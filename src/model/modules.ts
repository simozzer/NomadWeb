/**
 * Loader for `modules.xml` — the device's module catalogue.
 *
 * This file is Nomad's own data, carried over unchanged. It is the authority on
 * what each module has: its connectors and their signal types, its parameters
 * and their ranges, its LEDs, and its DSP cost.
 */

export type SignalType =
  | 'audio' | 'control' | 'logic' | 'master-slave' | 'user1' | 'user2' | 'none';

export interface SignalDef {
  key: number;
  type: SignalType;
  color: string;
  noSignal: boolean;
}

export interface ConnectorDef {
  componentId: string;
  index: number;
  name: string;
  direction: 'input' | 'output';
  signal: SignalType;
}

export interface ParameterDef {
  componentId: string;
  index: number;
  name: string;
  /** `parameter` for a normal control, `morph` for its morph-range partner. */
  className: string;
  role?: string;
  minValue: number;
  maxValue: number;
  defaultValue: number;
  /** Name of the display formatter in nmformat.js, if the parameter has one. */
  formatter?: string;
  /** component-id of the morph parameter that extends this one. */
  extension?: string;
}

export interface LightDef {
  componentId: string;
  index: number;
  name: string;
  type: string;
}

export interface ModuleDef {
  componentId: string;
  /** The type index used on the wire and in patch files. */
  index: number;
  name: string;
  category: string;
  connectors: ConnectorDef[];
  parameters: ParameterDef[];
  lights: LightDef[];
  /** Height in the patch grid's row units. */
  height: number;
  background?: string;
  /** DSP cycles consumed, used for the patch resource meters. */
  cycles?: number;
  attributes: Map<string, string>;
}

export interface ModuleCatalogue {
  modules: Map<number, ModuleDef>;
  byComponentId: Map<string, ModuleDef>;
  signals: Map<SignalType, SignalDef>;
  categories: string[];
}

function attr(el: Element, name: string): string | undefined {
  const value = el.getAttribute(name);
  return value === null ? undefined : value;
}

function num(el: Element, name: string, fallback: number): number {
  const value = el.getAttribute(name);
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseModuleCatalogue(xml: string): ModuleCatalogue {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const error = doc.querySelector('parsererror');
  if (error) throw new Error(`modules.xml is not well-formed: ${error.textContent}`);

  const signals = new Map<SignalType, SignalDef>();
  for (const el of Array.from(doc.getElementsByTagName('signal'))) {
    const type = (attr(el, 'type') ?? 'none') as SignalType;
    signals.set(type, {
      key: num(el, 'key', -1),
      type,
      color: attr(el, 'color') ?? '#FFFFFF',
      noSignal: attr(el, 'nosignal') === 'true',
    });
  }

  const modules = new Map<number, ModuleDef>();
  const byComponentId = new Map<string, ModuleDef>();
  const categories = new Set<string>();

  for (const el of Array.from(doc.getElementsByTagName('module'))) {
    // `<module component-id=... />` also appears inside <container> as a
    // reference; only definitions carry an index.
    if (!el.hasAttribute('index')) continue;

    const attributes = new Map<string, string>();
    for (const a of Array.from(el.getElementsByTagName('attribute'))) {
      const name = attr(a, 'name');
      const value = attr(a, 'value');
      if (name !== undefined && value !== undefined) attributes.set(name, value);
    }

    const connectors: ConnectorDef[] = Array.from(el.getElementsByTagName('connector')).map((c) => ({
      componentId: attr(c, 'component-id') ?? '',
      index: num(c, 'index', 0),
      name: attr(c, 'name') ?? '',
      direction: (attr(c, 'type') ?? 'input') as 'input' | 'output',
      signal: (attr(c, 'signal') ?? 'none') as SignalType,
    }));

    const parameters: ParameterDef[] = Array.from(el.getElementsByTagName('parameter')).map((p) => ({
      componentId: attr(p, 'component-id') ?? '',
      index: num(p, 'index', 0),
      name: attr(p, 'name') ?? '',
      className: attr(p, 'class') ?? 'parameter',
      role: attr(p, 'role'),
      minValue: num(p, 'minValue', 0),
      // Nord parameters are 7-bit unless the catalogue narrows them.
      maxValue: num(p, 'maxValue', 127),
      defaultValue: num(p, 'defaultValue', 0),
      formatter: attr(p, 'formatter'),
      extension: attr(p, 'extension'),
    }));

    const lights: LightDef[] = Array.from(el.getElementsByTagName('light')).map((l) => ({
      componentId: attr(l, 'component-id') ?? '',
      index: num(l, 'index', 0),
      name: attr(l, 'name') ?? '',
      type: attr(l, 'type') ?? 'led',
    }));

    const category = attr(el, 'category') ?? 'Other';
    categories.add(category);

    const def: ModuleDef = {
      componentId: attr(el, 'component-id') ?? '',
      index: num(el, 'index', -1),
      name: attr(el, 'name') ?? '(unnamed)',
      category,
      connectors,
      parameters,
      lights,
      height: Number(attributes.get('height') ?? '2'),
      background: attributes.get('background'),
      cycles: attributes.has('cycles') ? Number(attributes.get('cycles')) : undefined,
      attributes,
    };

    modules.set(def.index, def);
    byComponentId.set(def.componentId, def);
  }

  return {
    modules,
    byComponentId,
    signals,
    categories: Array.from(categories).sort(),
  };
}

/** Parameters the user edits, excluding the morph-range shadows. */
export function controlParameters(def: ModuleDef): ParameterDef[] {
  return def.parameters.filter((p) => p.className === 'parameter');
}

export function morphParameters(def: ModuleDef): ParameterDef[] {
  return def.parameters.filter((p) => p.className === 'morph');
}
