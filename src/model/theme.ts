/**
 * Loader for `classic-theme.xml` — Nomad's pixel layout for every module.
 *
 * Each module is a fixed-size panel with absolutely positioned widgets, every
 * one bound to a parameter or connector `component-id` from `modules.xml`.
 * That makes the file a renderer-agnostic UI spec: this loader turns it into
 * plain data and `ui/moduleView.ts` draws it as SVG.
 */

export type WidgetKind =
  | 'knob' | 'button' | 'slider' | 'textDisplay' | 'label'
  | 'connector' | 'light' | 'resetButton' | 'display';

export interface ButtonFace {
  index: number;
  /** Face text, when the button is labelled rather than illustrated. */
  text?: string;
  /** Face image, relative to the theme's images directory. */
  image?: string;
}

export interface Widget {
  kind: WidgetKind;
  x: number;
  y: number;
  width?: number;
  height?: number;
  size?: number;
  /** CSS class from the theme's stylesheet, e.g. `cAUDIO`. */
  className?: string;
  /** Static text, for `label`. */
  text?: string;
  /** component-id of the bound parameter, if any. */
  parameterId?: string;
  /** component-id of the bound connector, if any. */
  connectorId?: string;
  /** component-id of the bound light, if any. */
  lightId?: string;
  /** Human-readable name carried by the binding. */
  alt?: string;
  faces?: ButtonFace[];
  cyclic?: boolean;
  landscape?: boolean;
  /** Element name for widgets outside the core vocabulary (e.g. LFODisplay). */
  variant?: string;
}

export interface ModuleTheme {
  componentId: string;
  name: string;
  width: number;
  height: number;
  widgets: Widget[];
}

export interface Theme {
  modules: Map<string, ModuleTheme>;
  /** The `<style>` block from the head of the theme file. */
  css: string;
}

const CORE_KINDS: Record<string, WidgetKind> = {
  knob: 'knob',
  button: 'button',
  slider: 'slider',
  textDisplay: 'textDisplay',
  label: 'label',
  connector: 'connector',
  light: 'light',
  resetButton: 'resetButton',
};

function num(el: Element, name: string): number | undefined {
  const value = el.getAttribute(name);
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Reads the `<parameter>` / `<connector>` / `<light>` binding inside a widget. */
function readBinding(el: Element, widget: Widget): void {
  for (const child of Array.from(el.children)) {
    const id = child.getAttribute('component-id') ?? undefined;
    if (!id) continue;
    const alt = child.getAttribute('alt') ?? undefined;
    if (child.tagName === 'parameter') {
      widget.parameterId = id;
      widget.alt ??= alt;
    } else if (child.tagName === 'connector') {
      widget.connectorId = id;
      widget.alt ??= alt;
    } else if (child.tagName === 'light') {
      widget.lightId = id;
      widget.alt ??= alt;
    }
  }
}

function readFaces(el: Element): ButtonFace[] {
  return Array.from(el.getElementsByTagName('btn')).map((btn, i) => {
    const image = btn.getElementsByTagName('image')[0];
    const href = image?.getAttribute('xlink:href') ?? image?.getAttribute('href') ?? undefined;
    const text = btn.textContent?.trim();
    return {
      index: num(btn, 'index') ?? i,
      text: text && !href ? text : undefined,
      // Paths in the theme are relative ("./images/slice/x.png").
      image: href ? href.replace(/^\.\//, '') : undefined,
    };
  });
}

export function parseTheme(xml: string): Theme {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const error = doc.querySelector('parsererror');
  if (error) throw new Error(`classic-theme.xml is not well-formed: ${error.textContent}`);

  const css = doc.getElementsByTagName('style')[0]?.textContent ?? '';
  const modules = new Map<string, ModuleTheme>();

  for (const el of Array.from(doc.getElementsByTagName('module'))) {
    const componentId = el.getAttribute('component-id');
    if (!componentId) continue;

    const widgets: Widget[] = [];

    for (const child of Array.from(el.children)) {
      if (child.tagName === 'name') continue;

      const kind = CORE_KINDS[child.tagName];
      const x = num(child, 'x');
      const y = num(child, 'y');
      // Everything drawable carries a position; anything else is metadata.
      if (x === undefined || y === undefined) continue;

      const widget: Widget = {
        kind: kind ?? 'display',
        variant: kind ? undefined : child.tagName,
        x,
        y,
        width: num(child, 'width'),
        height: num(child, 'height'),
        size: num(child, 'size'),
        className: child.getAttribute('class') ?? undefined,
      };

      if (widget.kind === 'label') {
        widget.text = child.textContent?.trim() ?? '';
      } else {
        readBinding(child, widget);
        if (widget.kind === 'button' || widget.kind === 'resetButton') {
          widget.faces = readFaces(child);
          widget.cyclic = child.getAttribute('cyclic') === 'true';
          widget.landscape = child.getAttribute('landscape') === 'true';
        }
      }

      widgets.push(widget);
    }

    modules.set(componentId, {
      componentId,
      name: el.getElementsByTagName('name')[0]?.textContent?.trim() ?? componentId,
      width: num(el, 'width') ?? 255,
      height: num(el, 'height') ?? 75,
      widgets,
    });
  }

  return { modules, css };
}
