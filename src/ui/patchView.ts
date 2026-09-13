import type { ModuleCatalogue, ModuleDef, ParameterDef } from '../model/modules.ts';
import type { Theme } from '../model/theme.ts';
import type { Patch, PatchArea, PatchCable, PatchModule } from '../model/patch.ts';
import { controlParameters } from '../model/modules.ts';
import { ModuleView } from './moduleView.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Patch grid geometry.
 *
 * Every themed panel is 255px wide, and panel height is exactly 15px per unit
 * of the `height` attribute in modules.xml — verified across all 109 themed
 * modules. So a module at (xpos, ypos) sits at (xpos * 255, ypos * 15).
 */
export const COLUMN_WIDTH = 255;
export const ROW_HEIGHT = 15;

/** Cable colours, indexed by the 3-bit `color` field, matching def-signal. */
const CABLE_COLORS = [
  '#CB4F4F', // audio
  '#5A5FB3', // control
  '#E5DE45', // logic
  '#A8A8A8', // master-slave
  '#9AC899', // user1
  '#BB00D7', // user2
  '#FFFFFF', // none
  '#FFFFFF',
];

export interface ConnectorRef {
  moduleIndex: number;
  connectorIndex: number;
  /** 1 if this end is an output, 0 if an input. */
  isOutput: number;
}

export interface PatchViewOptions {
  patch: Patch;
  area: PatchArea;
  catalogue: ModuleCatalogue;
  theme: Theme;
  format?: (parameter: ParameterDef, value: number) => string;
  onParameterChange?: (module: PatchModule, parameter: ParameterDef, value: number) => void;
  onModuleMove?: (module: PatchModule, x: number, y: number) => void;
  onCableAdd?: (from: ConnectorRef, to: ConnectorRef, color: number) => void;
  onCableDelete?: (cable: PatchCable) => void;
  onSelect?: (module: PatchModule | null) => void;
}

function el<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

/** Widget groups that own their own pointer gestures. */
const CONTROL_CLASSES = ['knob', 'button', 'slider'];

/** Walks up from an event target to the canvas, looking for a class. */
function ancestorWithClass(target: EventTarget | null, className: string): Element | null {
  let node = target as Element | null;
  // `closest` is unreliable across the nested <svg> boundary of a module, so
  // walk up explicitly and stop at the canvas.
  while (node && !node.classList?.contains('patch-canvas')) {
    if (node.classList?.contains(className)) return node;
    node = node.parentElement ?? (node.parentNode as Element | null);
  }
  return null;
}

function isModuleControl(target: EventTarget | null): boolean {
  return CONTROL_CLASSES.some((name) => ancestorWithClass(target, name) !== null);
}

interface Placed {
  module: PatchModule;
  def: ModuleDef;
  group: SVGGElement;
  view: ModuleView;
  heightPx: number;
}

/**
 * The patch canvas for one area: modules on the grid, cables between them.
 *
 * A press is routed by what it lands on: a control operates itself, a connector
 * starts a cable, a module body drags that module, and bare canvas pans.
 */
export class PatchView {
  readonly element: SVGSVGElement;

  private readonly options: PatchViewOptions;
  private readonly root: SVGGElement;
  private readonly moduleLayer: SVGGElement;
  private readonly cableLayer: SVGGElement;
  private readonly overlay: SVGGElement;

  private readonly placed = new Map<number, Placed>();
  private cables: PatchCable[];

  private view = { x: 0, y: 0, scale: 1 };
  private selected: PatchModule | null = null;

  constructor(options: PatchViewOptions) {
    this.options = options;
    this.cables = options.patch.cables.filter((c) => c.area === options.area);

    this.element = el('svg', { class: 'patch-canvas', width: '100%', height: '100%' });
    this.root = el('g');
    this.cableLayer = el('g', { class: 'cables' });
    this.moduleLayer = el('g', { class: 'modules' });
    this.overlay = el('g', { class: 'overlay' });

    // Modules first, cables above them, transient drawing on top.
    this.root.append(this.moduleLayer, this.cableLayer, this.overlay);
    this.element.appendChild(this.root);

    this.renderModules();
    this.renderCables();
    this.attachPanZoom();
    this.applyTransform();
  }

  // ---- geometry ----

  /**
   * Centre of a connector in canvas coordinates.
   *
   * The patch references connectors by index and direction; the catalogue maps
   * that to a component-id, and the theme places that id on the panel.
   */
  connectorPoint(ref: ConnectorRef): { x: number; y: number } | null {
    const placed = this.placed.get(ref.moduleIndex);
    if (!placed) return null;

    const wanted = ref.isOutput ? 'output' : 'input';
    const connector = placed.def.connectors.find(
      (c) => c.index === ref.connectorIndex && c.direction === wanted,
    );
    if (!connector) return null;

    const layout = this.options.theme.modules.get(placed.def.componentId);
    const widget = layout?.widgets.find(
      (w) => w.kind === 'connector' && w.connectorId === connector.componentId,
    );
    if (!widget) return null;

    const size = widget.size ?? 13;
    return {
      x: placed.module.x * COLUMN_WIDTH + widget.x + size / 2,
      y: placed.module.y * ROW_HEIGHT + widget.y + size / 2,
    };
  }

  /** Finds the connector nearest a canvas point, within `radius`. */
  private connectorAt(x: number, y: number, radius = 11): ConnectorRef | null {
    let best: ConnectorRef | null = null;
    let bestDistance = radius * radius;

    for (const placed of this.placed.values()) {
      for (const connector of placed.def.connectors) {
        const ref: ConnectorRef = {
          moduleIndex: placed.module.index,
          connectorIndex: connector.index,
          isOutput: connector.direction === 'output' ? 1 : 0,
        };
        const point = this.connectorPoint(ref);
        if (!point) continue;
        const distance = (point.x - x) ** 2 + (point.y - y) ** 2;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = ref;
        }
      }
    }
    return best;
  }

  /** Converts a pointer event to canvas coordinates. */
  private toCanvas(event: PointerEvent): { x: number; y: number } {
    const rect = this.element.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left - this.view.x) / this.view.scale,
      y: (event.clientY - rect.top - this.view.y) / this.view.scale,
    };
  }

  // ---- modules ----

  private renderModules(): void {
    this.moduleLayer.replaceChildren();
    this.placed.clear();

    for (const module of this.options.patch.modules) {
      if (module.area !== this.options.area) continue;

      const def = this.options.catalogue.modules.get(module.type);
      const layout = def && this.options.theme.modules.get(def.componentId);
      if (!def || !layout) continue;

      const group = el('g', { class: 'patch-module' });
      const view = new ModuleView({
        def,
        theme: layout,
        imageBase: '/data/theme-images',
        format: this.options.format,
        onParameterChange: (parameter, value) =>
          this.options.onParameterChange?.(module, parameter, value),
      });

      const nested = view.element;
      nested.setAttribute('x', '0');
      nested.setAttribute('y', '0');
      group.appendChild(nested);
      group.style.cursor = 'move';

      const placed: Placed = { module, def, group, view, heightPx: layout.height };
      this.placed.set(module.index, placed);

      this.positionModule(placed);
      this.moduleLayer.appendChild(group);

      // Apply the patch's stored values, positionally per modules.xml order.
      const dump = this.options.patch.parameters.find((p) => p.area === this.options.area);
      const stored = dump?.byModule.get(module.index) ?? [];
      controlParameters(def).forEach((parameter, i) => {
        if (i < stored.length) view.setValue(parameter.componentId, stored[i]);
      });
    }
  }

  private positionModule(placed: Placed): void {
    placed.group.setAttribute(
      'transform',
      `translate(${placed.module.x * COLUMN_WIDTH} ${placed.module.y * ROW_HEIGHT})`,
    );
  }

  /** The module whose panel covers a canvas point, if any. */
  private moduleAt(x: number, y: number): Placed | null {
    // Later modules sit above earlier ones, so search in reverse.
    const all = Array.from(this.placed.values()).reverse();
    for (const placed of all) {
      const left = placed.module.x * COLUMN_WIDTH;
      const top = placed.module.y * ROW_HEIGHT;
      if (x >= left && x <= left + COLUMN_WIDTH && y >= top && y <= top + placed.heightPx) {
        return placed;
      }
    }
    return null;
  }

  /** Drags a module anywhere on its body, snapped to the patch grid. */
  private beginModuleDrag(event: PointerEvent, placed: Placed): void {
    event.preventDefault();
    this.element.setPointerCapture(event.pointerId);

    this.select(placed.module);
    const start = this.toCanvas(event);
    const originX = placed.module.x;
    const originY = placed.module.y;

    const move = (moveEvent: PointerEvent) => {
      const now = this.toCanvas(moveEvent);
      // Snap to the grid the device itself stores positions on.
      const x = Math.max(0, originX + Math.round((now.x - start.x) / COLUMN_WIDTH));
      const y = Math.max(0, originY + Math.round((now.y - start.y) / ROW_HEIGHT));
      if (x === placed.module.x && y === placed.module.y) return;
      placed.module.x = x;
      placed.module.y = y;
      this.positionModule(placed);
      this.renderCables();
    };

    const up = () => {
      this.element.releasePointerCapture(event.pointerId);
      this.element.removeEventListener('pointermove', move);
      this.element.removeEventListener('pointerup', up);
      if (placed.module.x !== originX || placed.module.y !== originY) {
        this.options.onModuleMove?.(placed.module, placed.module.x, placed.module.y);
      }
    };

    this.element.addEventListener('pointermove', move);
    this.element.addEventListener('pointerup', up);
  }

  private select(module: PatchModule | null): void {
    this.selected = module;
    for (const placed of this.placed.values()) {
      placed.group.classList.toggle('patch-module--selected', placed.module === module);
    }
    this.options.onSelect?.(module);
  }

  get selectedModule(): PatchModule | null {
    return this.selected;
  }

  // ---- cables ----

  /** A cable hangs slightly, which also keeps parallel runs distinguishable. */
  private cablePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const sag = Math.min(60, Math.max(12, Math.hypot(dx, dy) * 0.25));
    return `M ${a.x} ${a.y} Q ${(a.x + b.x) / 2} ${(a.y + b.y) / 2 + sag} ${b.x} ${b.y}`;
  }

  private renderCables(): void {
    this.cableLayer.replaceChildren();

    for (const cable of this.cables) {
      const from = this.connectorPoint({
        moduleIndex: cable.sourceModule,
        connectorIndex: cable.sourceConnector,
        isOutput: cable.sourceIsOutput,
      });
      // The far end of a stored cable is always an input.
      const to = this.connectorPoint({
        moduleIndex: cable.destModule,
        connectorIndex: cable.destConnector,
        isOutput: 0,
      });
      if (!from || !to) continue;

      const color = CABLE_COLORS[cable.color] ?? '#FFFFFF';
      const path = this.cablePath(from, to);
      const group = el('g', { class: 'cable' });

      // A wide transparent stroke underneath makes thin cables clickable.
      const hit = el('path', {
        d: path, fill: 'none', stroke: 'transparent', 'stroke-width': 10,
      });
      hit.style.cursor = 'pointer';
      const line = el('path', {
        d: path, fill: 'none', stroke: color, 'stroke-width': 2.5,
        'stroke-linecap': 'round',
      });

      hit.addEventListener('click', (event) => {
        event.stopPropagation();
        this.removeCable(cable);
      });
      // A cable is thin; widen it on hover so it is obvious what will be cut.
      group.addEventListener('pointerenter', () => {
        line.setAttribute('stroke-width', '4.5');
        line.setAttribute('stroke-dasharray', '6 3');
      });
      group.addEventListener('pointerleave', () => {
        line.setAttribute('stroke-width', '2.5');
        line.removeAttribute('stroke-dasharray');
      });

      const tip = el('title');
      tip.textContent =
        `${this.describeEnd(cable.sourceModule, cable.sourceConnector, cable.sourceIsOutput)}` +
        ` → ${this.describeEnd(cable.destModule, cable.destConnector, 0)}` +
        ' — click to disconnect';

      group.append(hit, line, tip);
      this.cableLayer.appendChild(group);
    }
  }

  /** Names a cable end the way the panel labels it, for tooltips. */
  private describeEnd(moduleIndex: number, connectorIndex: number, isOutput: number): string {
    const placed = this.placed.get(moduleIndex);
    if (!placed) return `#${moduleIndex}:${connectorIndex}`;
    const connector = placed.def.connectors.find(
      (c) => c.index === connectorIndex && c.direction === (isOutput ? 'output' : 'input'),
    );
    const label = placed.module.name || placed.def.name;
    return connector ? `${label} ${connector.name}` : `${label} #${connectorIndex}`;
  }

  /** Disconnects every cable attached to a connector. */
  disconnectAt(ref: ConnectorRef): number {
    const attached = this.cables.filter(
      (c) =>
        (c.sourceModule === ref.moduleIndex &&
          c.sourceConnector === ref.connectorIndex &&
          c.sourceIsOutput === ref.isOutput) ||
        (c.destModule === ref.moduleIndex && c.destConnector === ref.connectorIndex &&
          ref.isOutput === 0),
    );
    for (const cable of attached) this.removeCable(cable);
    return attached.length;
  }

  private removeCable(cable: PatchCable): void {
    this.cables = this.cables.filter((c) => c !== cable);
    this.options.patch.cables = this.options.patch.cables.filter((c) => c !== cable);
    this.renderCables();
    this.options.onCableDelete?.(cable);
  }

  addCable(cable: PatchCable): void {
    this.cables.push(cable);
    this.options.patch.cables.push(cable);
    this.renderCables();
  }

  // ---- pan, zoom, and cable dragging ----

  private applyTransform(): void {
    this.root.setAttribute(
      'transform',
      `translate(${this.view.x} ${this.view.y}) scale(${this.view.scale})`,
    );
  }

  private attachPanZoom(): void {
    this.element.addEventListener('wheel', (event: WheelEvent) => {
      event.preventDefault();
      const rect = this.element.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      const scale = Math.min(3, Math.max(0.2, this.view.scale * factor));
      // Keep the point under the cursor fixed while zooming.
      this.view.x = px - ((px - this.view.x) / this.view.scale) * scale;
      this.view.y = py - ((py - this.view.y) / this.view.scale) * scale;
      this.view.scale = scale;
      this.applyTransform();
    }, { passive: false });

    // Double-clicking a connector clears everything plugged into it, which is
    // quicker than cutting each cable when unpicking a busy input.
    this.element.addEventListener('dblclick', (event: MouseEvent) => {
      if (isModuleControl(event.target)) return;
      const rect = this.element.getBoundingClientRect();
      const point = {
        x: (event.clientX - rect.left - this.view.x) / this.view.scale,
        y: (event.clientY - rect.top - this.view.y) / this.view.scale,
      };
      const connector = this.connectorAt(point.x, point.y);
      if (!connector) return;
      event.preventDefault();
      this.disconnectAt(connector);
    });

    // One dispatcher decides what a press means, in priority order:
    // a control operates itself, a connector starts a cable, a module body
    // drags the module, and only bare canvas pans.
    this.element.addEventListener('pointerdown', (event: PointerEvent) => {
      if (isModuleControl(event.target)) return;

      // Cables sit above the modules, so a press on one must not be taken as a
      // press on the module behind it. Its own handler does the disconnect.
      if (ancestorWithClass(event.target, 'cable')) return;

      const point = this.toCanvas(event);

      const connector = this.connectorAt(point.x, point.y);
      if (connector) return this.beginCableDrag(event, connector);

      const placed = this.moduleAt(point.x, point.y);
      if (placed) return this.beginModuleDrag(event, placed);

      // Empty space: pan, and clear the selection.
      this.select(null);
      this.element.setPointerCapture(event.pointerId);
      const startX = event.clientX - this.view.x;
      const startY = event.clientY - this.view.y;
      this.element.style.cursor = 'grabbing';

      const move = (moveEvent: PointerEvent) => {
        this.view.x = moveEvent.clientX - startX;
        this.view.y = moveEvent.clientY - startY;
        this.applyTransform();
      };
      const up = () => {
        this.element.releasePointerCapture(event.pointerId);
        this.element.style.cursor = '';
        this.element.removeEventListener('pointermove', move);
        this.element.removeEventListener('pointerup', up);
      };
      this.element.addEventListener('pointermove', move);
      this.element.addEventListener('pointerup', up);
    });
  }

  private beginCableDrag(event: PointerEvent, from: ConnectorRef): void {
    event.preventDefault();
    event.stopPropagation();
    this.element.setPointerCapture(event.pointerId);

    const origin = this.connectorPoint(from)!;
    const preview = el('path', {
      fill: 'none', stroke: '#c8b072', 'stroke-width': 2,
      'stroke-dasharray': '5 4', 'stroke-linecap': 'round',
    });
    this.overlay.appendChild(preview);

    const move = (moveEvent: PointerEvent) => {
      const point = this.toCanvas(moveEvent);
      const snap = this.connectorAt(point.x, point.y);
      const end = snap ? this.connectorPoint(snap)! : point;
      preview.setAttribute('d', this.cablePath(origin, end));
    };

    const up = (upEvent: PointerEvent) => {
      this.element.releasePointerCapture(event.pointerId);
      this.element.removeEventListener('pointermove', move);
      this.element.removeEventListener('pointerup', up);
      preview.remove();

      const point = this.toCanvas(upEvent);
      const to = this.connectorAt(point.x, point.y);
      if (!to) return;
      if (to.moduleIndex === from.moduleIndex && to.connectorIndex === from.connectorIndex &&
          to.isOutput === from.isOutput) {
        return;
      }

      // Colour follows the signal type of the source connector.
      const placed = this.placed.get(from.moduleIndex);
      const connector = placed?.def.connectors.find(
        (c) => c.index === from.connectorIndex &&
          c.direction === (from.isOutput ? 'output' : 'input'),
      );
      const color = this.options.catalogue.signals.get(connector?.signal ?? 'none')?.key ?? 6;

      this.addCable({
        area: this.options.area,
        color,
        sourceModule: from.moduleIndex,
        sourceConnector: from.connectorIndex,
        sourceIsOutput: from.isOutput,
        destModule: to.moduleIndex,
        destConnector: to.connectorIndex,
      });
      this.options.onCableAdd?.(from, to, color);
    };

    this.element.addEventListener('pointermove', move);
    this.element.addEventListener('pointerup', up);
  }

  /** Fits the whole patch in the given viewport size. */
  fit(width: number, height: number, padding = 24): void {
    let maxX = 1;
    let maxY = 1;
    for (const placed of this.placed.values()) {
      maxX = Math.max(maxX, (placed.module.x + 1) * COLUMN_WIDTH);
      maxY = Math.max(maxY, placed.module.y * ROW_HEIGHT + placed.heightPx);
    }
    const scale = Math.min(
      (width - padding * 2) / maxX,
      (height - padding * 2) / maxY,
      1,
    );
    this.view.scale = Math.max(0.2, scale);
    this.view.x = padding;
    this.view.y = padding;
    this.applyTransform();
  }

  /** Applies a live value arriving from the device. */
  setParameter(moduleIndex: number, parameterId: string, value: number): void {
    this.placed.get(moduleIndex)?.view.setValue(parameterId, value);
  }
}
