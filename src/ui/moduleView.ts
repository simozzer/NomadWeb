import type { ModuleDef, ParameterDef } from '../model/modules.ts';
import type { ModuleTheme, Widget } from '../model/theme.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Baseline offset for the theme's 9px panel text.
 *
 * Theme coordinates are Swing bounds (top-left); SVG places text by its
 * baseline, so everything drawn as text needs the ascent added.
 */
const LABEL_ASCENT = 7;

/** Signal colours, taken from the stylesheet at the head of classic-theme.xml. */
const SIGNAL_COLORS: Record<string, string> = {
  cAUDIO: '#CB4F4F',
  cCONTROL: '#5A5FB3',
  cLOGIC: '#E5DE45',
  cSLAVE: '#A8A8A8',
  cUSER1: '#9AC899',
  cUSER2: '#BB00D7',
  cNONE: '#FFFFFF',
};

export interface ModuleViewOptions {
  def: ModuleDef;
  theme: ModuleTheme;
  /** Base URL for theme images (button faces). */
  imageBase: string;
  /** Formats a parameter value for its text display. */
  format?: (parameter: ParameterDef, value: number) => string;
  /** Called as the user edits a control. */
  onParameterChange?: (parameter: ParameterDef, value: number) => void;
}

function el<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, String(value));
  }
  return node;
}

/**
 * Renders one module panel as SVG and wires up its controls.
 *
 * Geometry comes entirely from the theme; ranges and names from the module
 * catalogue. Nothing about any particular module is hardcoded here.
 */
export class ModuleView {
  readonly element: SVGSVGElement;
  private readonly options: ModuleViewOptions;
  private readonly values = new Map<string, number>();
  /** Redraw callbacks keyed by parameter component-id. */
  private readonly painters = new Map<string, ((value: number) => void)[]>();

  constructor(options: ModuleViewOptions) {
    this.options = options;
    const { def, theme } = options;

    for (const parameter of def.parameters) {
      this.values.set(parameter.componentId, parameter.defaultValue);
    }

    this.element = el('svg', {
      class: 'module',
      width: theme.width,
      height: theme.height,
      viewBox: `0 0 ${theme.width} ${theme.height}`,
      role: 'group',
      'aria-label': def.name,
    });

    this.element.appendChild(
      el('rect', {
        x: 0,
        y: 0,
        width: theme.width,
        height: theme.height,
        rx: 3,
        fill: def.background ?? '#BFBFBF',
        stroke: 'rgba(0,0,0,.35)',
      }),
    );

    for (const widget of theme.widgets) this.renderWidget(widget);
  }

  /** Applies a value from the device without re-notifying it. */
  setValue(parameterId: string, value: number): void {
    this.values.set(parameterId, value);
    for (const paint of this.painters.get(parameterId) ?? []) paint(value);
  }

  getValue(parameterId: string): number {
    return this.values.get(parameterId) ?? 0;
  }

  private parameterFor(id: string | undefined): ParameterDef | undefined {
    if (!id) return undefined;
    return this.options.def.parameters.find((p) => p.componentId === id);
  }

  private addPainter(id: string, paint: (value: number) => void): void {
    const list = this.painters.get(id) ?? [];
    list.push(paint);
    this.painters.set(id, list);
    paint(this.values.get(id) ?? 0);
  }

  private commit(parameter: ParameterDef, value: number): void {
    const clamped = Math.max(parameter.minValue, Math.min(parameter.maxValue, Math.round(value)));
    if (this.values.get(parameter.componentId) === clamped) return;
    this.setValue(parameter.componentId, clamped);
    this.options.onParameterChange?.(parameter, clamped);
  }

  private renderWidget(widget: Widget): void {
    switch (widget.kind) {
      case 'connector': return this.renderConnector(widget);
      case 'label': return this.renderLabel(widget);
      case 'knob': return this.renderKnob(widget);
      case 'button':
      case 'resetButton': return this.renderButton(widget);
      case 'slider': return this.renderSlider(widget);
      case 'textDisplay': return this.renderTextDisplay(widget);
      case 'light': return this.renderLight(widget);
      case 'display': return this.renderPlaceholder(widget);
    }
  }

  private renderConnector(widget: Widget): void {
    const size = widget.size ?? 13;
    const color = SIGNAL_COLORS[widget.className ?? 'cNONE'] ?? '#FFF';
    const def = this.options.def.connectors.find((c) => c.componentId === widget.connectorId);

    const group = el('g', { class: 'connector', 'data-connector': widget.connectorId ?? '' });
    // The patch format addresses a connector by index plus direction, so carry
    // both on the element. That lets a press be resolved by what it actually
    // hit rather than by distance to the nearest centre.
    if (def) {
      group.setAttribute('data-connector-index', String(def.index));
      group.setAttribute('data-connector-output', def.direction === 'output' ? '1' : '0');
      group.setAttribute('data-signal', def.signal);
    }

    group.appendChild(
      el('rect', {
        x: widget.x, y: widget.y, width: size, height: size, rx: 2,
        fill: '#2a2a2a', stroke: 'rgba(0,0,0,.5)',
      }),
    );
    group.appendChild(
      el('circle', {
        cx: widget.x + size / 2, cy: widget.y + size / 2, r: Math.max(2, size / 2 - 3),
        fill: color,
      }),
    );
    // An invisible, generously sized target: the drawn jack is only 13px, which
    // is a hard thing to hit, especially zoomed out.
    const target = el('rect', {
      x: widget.x - 3, y: widget.y - 3, width: size + 6, height: size + 6,
      fill: 'transparent', class: 'connector-target',
    });
    group.appendChild(target);

    if (widget.alt) {
      const label = el('title');
      label.textContent = widget.alt;
      group.appendChild(label);
    }
    this.element.appendChild(group);
  }

  private renderLabel(widget: Widget): void {
    // Theme coordinates are Swing component bounds — the top-left corner — but
    // SVG positions text by its baseline. Without the ascent the label rides up
    // into whatever sits above it: "Coarse" is at y=4 on a panel it would
    // otherwise overhang, and "Slv" at y=39 lands on the display at 24-40.
    // A few labels sit close enough to the bottom edge that the ascent would
    // push them off the panel (PolyAreaIn's "R" is at y=26 on a 30px panel), so
    // the baseline is kept inside.
    const text = el('text', {
      x: widget.x,
      y: Math.min(widget.y + LABEL_ASCENT, this.options.theme.height - 2),
      class: 'module-label',
    });
    text.textContent = widget.text ?? '';
    this.element.appendChild(text);
  }

  private renderKnob(widget: Widget): void {
    const parameter = this.parameterFor(widget.parameterId);
    const size = widget.size ?? 21;
    const radius = size / 2;
    // The theme's own transform (module2svg.xsl) places a knob at
    // cx = x + radius, cy = y + radius. This previously subtracted size/2 from
    // cy, which is identically zero, so every knob sat half its height too high
    // and collided with the label above it.
    const cx = widget.x + radius;
    const cy = widget.y + radius;

    const group = el('g', { class: 'knob' });
    group.appendChild(el('circle', { cx, cy, r: radius, fill: '#989898', stroke: 'rgba(0,0,0,.45)' }));
    const pointer = el('line', {
      x1: cx, y1: cy, x2: cx, y2: cy - radius + 2,
      stroke: '#1a1a1a', 'stroke-width': 2, 'stroke-linecap': 'round',
    });
    group.appendChild(pointer);

    if (widget.alt) {
      const tip = el('title');
      tip.textContent = widget.alt;
      group.appendChild(tip);
    }

    if (parameter) {
      // Knobs sweep 270 degrees, the convention the hardware panel uses.
      const paint = (value: number) => {
        const span = parameter.maxValue - parameter.minValue || 1;
        const fraction = (value - parameter.minValue) / span;
        const angle = -135 + fraction * 270;
        pointer.setAttribute('transform', `rotate(${angle} ${cx} ${cy})`);
      };
      this.addPainter(parameter.componentId, paint);
      this.attachDrag(group, parameter);
      group.setAttribute('tabindex', '0');
      this.attachKeys(group, parameter);
    }

    this.element.appendChild(group);
  }

  private renderButton(widget: Widget): void {
    const parameter = this.parameterFor(widget.parameterId);
    const width = widget.width ?? 26;
    const height = widget.height ?? 16;
    const group = el('g', { class: 'button' });

    // Inset by 1px, as the theme's own transform does, so adjacent widgets
    // do not share an edge.
    const body = el('rect', {
      x: widget.x, y: widget.y,
      width: Math.max(0, width - 1), height: Math.max(0, height - 1),
      rx: 2, fill: '#7c7c7c', stroke: 'rgba(0,0,0,.5)',
    });
    group.appendChild(body);

    const faces = widget.faces ?? [];
    const caption = el('text', {
      x: widget.x + width / 2,
      y: widget.y + height / 2 + 3,
      class: 'module-label',
      'text-anchor': 'middle',
    });
    group.appendChild(caption);

    const image = el('image', {
      x: widget.x + 2, y: widget.y + 2,
      width: Math.max(0, width - 4), height: Math.max(0, height - 4),
    });
    image.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    group.appendChild(image);

    if (parameter) {
      const paint = (value: number) => {
        const face = faces.find((f) => f.index === value) ?? faces[0];
        caption.textContent = face?.text ?? '';
        if (face?.image) {
          image.setAttribute('href', `${this.options.imageBase}/${face.image.replace(/^images\//, '')}`);
          image.removeAttribute('hidden');
        } else {
          image.setAttribute('href', '');
        }
        // A non-zero setting reads as engaged on the hardware panel.
        body.setAttribute('fill', value > parameter.minValue ? '#c8b072' : '#7c7c7c');
      };
      this.addPainter(parameter.componentId, paint);

      group.style.cursor = 'pointer';
      group.setAttribute('tabindex', '0');
      // Buttons act on click, but the press still has to be kept from the
      // canvas underneath, which would otherwise begin panning.
      group.addEventListener('pointerdown', (event: PointerEvent) => {
        event.stopPropagation();
      });
      group.addEventListener('click', (event: MouseEvent) => {
        event.stopPropagation();
        const current = this.getValue(parameter.componentId);
        const next = current >= parameter.maxValue ? parameter.minValue : current + 1;
        this.commit(parameter, next);
      });
      this.attachKeys(group, parameter);
    }

    this.element.appendChild(group);
  }

  private renderSlider(widget: Widget): void {
    const parameter = this.parameterFor(widget.parameterId);
    const width = widget.width ?? 12;
    const height = widget.height ?? 40;
    const group = el('g', { class: 'slider' });

    group.appendChild(
      el('rect', {
        x: widget.x + width / 2 - 2, y: widget.y, width: 4, height,
        rx: 2, fill: '#4a4a4a',
      }),
    );
    const thumb = el('rect', {
      x: widget.x, y: widget.y, width, height: 8, rx: 2,
      fill: '#d0d0d0', stroke: 'rgba(0,0,0,.5)',
    });
    group.appendChild(thumb);

    if (parameter) {
      this.addPainter(parameter.componentId, (value) => {
        const span = parameter.maxValue - parameter.minValue || 1;
        const fraction = (value - parameter.minValue) / span;
        thumb.setAttribute('y', String(widget.y + (height - 8) * (1 - fraction)));
      });
      this.attachDrag(group, parameter);
      group.setAttribute('tabindex', '0');
      this.attachKeys(group, parameter);
    }

    this.element.appendChild(group);
  }

  private renderTextDisplay(widget: Widget): void {
    const parameter = this.parameterFor(widget.parameterId);
    const width = widget.width ?? 40;
    const height = widget.height ?? 16;
    const group = el('g', { class: 'text-display' });

    // The theme insets a display by 2px, which is what keeps neighbouring
    // widgets from touching it.
    group.appendChild(
      el('rect', {
        x: widget.x, y: widget.y, width: Math.max(0, width - 2), height: Math.max(0, height - 2),
        rx: 2, fill: '#392F7D', stroke: 'rgba(0,0,0,.5)',
      }),
    );
    const text = el('text', {
      x: widget.x + (width - 2) / 2, y: widget.y + (height - 2) / 2 + 3,
      class: 'display-text', 'text-anchor': 'middle',
    });
    group.appendChild(text);

    if (parameter) {
      this.addPainter(parameter.componentId, (value) => {
        text.textContent = this.options.format
          ? this.options.format(parameter, value)
          : String(value);
      });
    }

    this.element.appendChild(group);
  }

  private renderLight(widget: Widget): void {
    const size = widget.size ?? 8;
    const light = el('circle', {
      cx: widget.x + size / 2, cy: widget.y + size / 2, r: size / 2,
      fill: '#3a1414', stroke: 'rgba(0,0,0,.5)',
      class: 'light', 'data-light': widget.lightId ?? '',
    });
    this.element.appendChild(light);
  }

  /** Custom panel graphics (LFO shapes, envelope curves) are not drawn yet. */
  private renderPlaceholder(widget: Widget): void {
    const group = el('g', { class: 'display-placeholder' });
    group.appendChild(
      el('rect', {
        x: widget.x, y: widget.y,
        width: widget.width ?? 20, height: widget.height ?? 12,
        rx: 2, fill: 'rgba(0,0,0,.12)', stroke: 'rgba(0,0,0,.25)',
        'stroke-dasharray': '2 2',
      }),
    );
    const tip = el('title');
    tip.textContent = `${widget.variant ?? 'display'} (not yet drawn)`;
    group.appendChild(tip);
    this.element.appendChild(group);
  }

  /** Vertical drag adjusts the value, the way the desktop editor behaves. */
  private attachDrag(group: SVGElement, parameter: ParameterDef): void {
    group.style.cursor = 'ns-resize';

    group.addEventListener('pointerdown', (event: PointerEvent) => {
      event.preventDefault();
      // The patch canvas pans on pointerdown; without this the gesture starts a
      // pan as well as a control edit.
      event.stopPropagation();
      group.setPointerCapture(event.pointerId);
      const startY = event.clientY;
      const startValue = this.getValue(parameter.componentId);
      const span = parameter.maxValue - parameter.minValue || 1;
      // One full range over ~150px, finer with shift held.
      const perPixel = span / 150;

      const move = (moveEvent: PointerEvent) => {
        const delta = (startY - moveEvent.clientY) * perPixel * (moveEvent.shiftKey ? 0.25 : 1);
        this.commit(parameter, startValue + delta);
      };
      const up = () => {
        group.releasePointerCapture(event.pointerId);
        group.removeEventListener('pointermove', move);
        group.removeEventListener('pointerup', up);
      };

      group.addEventListener('pointermove', move);
      group.addEventListener('pointerup', up);
    });
  }

  private attachKeys(group: SVGElement, parameter: ParameterDef): void {
    group.addEventListener('keydown', (event: KeyboardEvent) => {
      const step = event.shiftKey ? 10 : 1;
      const current = this.getValue(parameter.componentId);
      if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
        this.commit(parameter, current + step);
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
        this.commit(parameter, current - step);
      } else {
        return;
      }
      event.preventDefault();
    });
  }
}
