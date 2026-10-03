import { parsePdl2 } from '../pdl2/parser.ts';
import { Pdl2Decoder, Pdl2Encoder, type Decoded, type MessageInit } from '../pdl2/interpreter.ts';
import type { Grammar } from '../pdl2/ast.ts';

/**
 * Reads a Nord Modular patch from the bitstream described by `patch.pdl2`.
 *
 * A patch is a chain of typed sections. Only the ones an editor needs are
 * interpreted here; the rest are still parsed by the grammar and kept as raw
 * nodes, so nothing is silently dropped.
 */

/** Section type codes, from the `switch (type)` table in patch.pdl2. */
export const SECTION = {
  PatchName: 55,
  PatchName2: 39,
  Header: 33,
  ModuleDump: 74,
  NoteDump: 105,
  CableDump: 82,
  ParameterDump: 77,
  MorphMap: 101,
  KnobMapDump: 98,
  ControlMapDump: 96,
  CustomDump: 91,
  NameDump: 90,
  SingleModule: 48,
  SynthSettings: 3,
} as const;

/**
 * The Nord Modular has two patch areas. The 1-bit `section` field in each dump
 * selects between them: the polyphonic voice area and the common/FX area.
 * See `areaOf` for which bit is which.
 */
export type PatchArea = 'voice' | 'common';

export interface PatchModule {
  area: PatchArea;
  /** Module type index, matching `index` in modules.xml. */
  type: number;
  /** Instance index within the area — what parameter messages address. */
  index: number;
  x: number;
  y: number;
  name?: string;
}

export interface PatchCable {
  area: PatchArea;
  color: number;
  sourceModule: number;
  sourceConnector: number;
  /** 0 = the source end is an input, 1 = an output. */
  sourceIsOutput: number;
  destModule: number;
  destConnector: number;
}

export interface PatchParameters {
  area: PatchArea;
  /** Module instance index -> parameter values in declaration order. */
  byModule: Map<number, number[]>;
}

/** A parameter a hardware knob controls. */
export interface KnobTarget {
  area: PatchArea;
  /** Module instance index within the area. */
  module: number;
  /** Parameter index, as `ParameterChange` addresses it. */
  parameter: number;
}

export interface Patch {
  name: string;
  modules: PatchModule[];
  cables: PatchCable[];
  parameters: PatchParameters[];
  /** Knob id (see `KNOB_NAMES`) -> what it controls. Unassigned knobs are absent. */
  knobs: Map<number, KnobTarget>;
  /** Every section as decoded, keyed by type code, for anything not modelled. */
  sections: Map<number, Decoded[]>;
}

/**
 * Works out what `ypos` means, from the values a real patch carries.
 *
 * Two readings are possible and they look alike until you check the numbers:
 * an ordinal (rank within the column, so 0,1,2,3) or an absolute row in 15px
 * units (so spaced by each module's height). The device is the authority, and
 * on a Micro Modular there is no display to compare against, so this decides it
 * from the data instead.
 */
export function describeLayoutScheme(patch: Patch): {
  verdict: 'ordinal' | 'absolute' | 'unclear';
  detail: string;
} {
  const columns = new Map<string, PatchModule[]>();
  for (const module of patch.modules) {
    const key = `${module.area}:${module.x}`;
    const list = columns.get(key) ?? [];
    list.push(module);
    columns.set(key, list);
  }

  let ordinalColumns = 0;
  let absoluteColumns = 0;
  const samples: string[] = [];

  for (const [key, members] of columns) {
    if (members.length < 2) continue;
    members.sort((a, b) => a.y - b.y);
    const ys = members.map((m) => m.y);
    if (samples.length < 4) samples.push(`${key} -> [${ys.join(', ')}]`);

    // Consecutive integers from any start means a rank.
    const consecutive = ys.every((y, i) => i === 0 || y === ys[i - 1] + 1);
    if (consecutive) ordinalColumns++;
    // Gaps of two or more suggest rows, since a module spans several.
    else if (ys.some((y, i) => i > 0 && y - ys[i - 1] >= 2)) absoluteColumns++;
  }

  const verdict =
    ordinalColumns > 0 && absoluteColumns === 0 ? 'ordinal'
    : absoluteColumns > 0 && ordinalColumns === 0 ? 'absolute'
    : 'unclear';

  return {
    verdict,
    detail:
      `${ordinalColumns} column(s) consecutive, ${absoluteColumns} gapped` +
      (samples.length ? ` · ${samples.join(' ')}` : ''),
  };
}

function one(node: Decoded | undefined, name: string): Decoded | undefined {
  const value = node?.items.get(name);
  return value && !Array.isArray(value) ? value : undefined;
}

function many(node: Decoded | undefined, name: string): Decoded[] {
  const value = node?.items.get(name);
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(node: Decoded | undefined): string {
  const chars = node?.items.get('chars');
  if (!Array.isArray(chars)) return '';
  return chars
    .map((c) => c.values.get('value') ?? 0)
    .filter((code) => code > 0)
    .map((code) => String.fromCharCode(code))
    .join('')
    .trim();
}

/**
 * The `section` bit: 1 is the poly voice area, 0 the common area.
 *
 * From `PatchBuilder.getVoiceArea`, whose `lookupswitch` sends 1 to
 * `getPolyVoiceArea` and 0 to `getCommonVoiceArea` — and `GetPatchMessage`
 * requests POLY_MODULE with payload 1. This used to be the other way round,
 * which every edit faithfully echoed back, so the device was always addressed
 * correctly; only the area labels were swapped.
 */
export const areaOf = (value: number | undefined): PatchArea => (value === 1 ? 'voice' : 'common');
export const areaBit = (area: PatchArea): 0 | 1 => (area === 'voice' ? 1 : 0);

export interface NewModule {
  type: number;
  area: PatchArea;
  index: number;
  x: number;
  y: number;
  name: string;
  /** Values of the module's `parameter`-class parameters, in modules.xml order. */
  parameters: number[];
  /** Values of its `custom`-class parameters, in modules.xml order. */
  customs: number[];
}

/**
 * Writes patch bitstreams, for the one case the device takes a patch fragment
 * instead of a message: adding a module.
 */
export class PatchWriter {
  private readonly grammar: Grammar;
  private readonly encoder: Pdl2Encoder;

  constructor(patchGrammarSource: string) {
    this.grammar = parsePdl2(patchGrammarSource);
    this.encoder = new Pdl2Encoder(this.grammar);
  }

  /**
   * The fragment `NewModuleMessage.newModule` builds: the module itself
   * (`SingleModule`), an empty cable list, its parameter values, its custom
   * values and its name — five sections, in that order, for its own area.
   */
  newModule(module: NewModule): { bytes: Uint8Array; bitLength: number } {
    const section = areaBit(module.area);
    const name = { chars: Array.from(module.name.slice(0, 16), (c) => c.charCodeAt(0) & 0x7f) };

    const fields = this.parameterFields(module.type);
    if (fields.length !== module.parameters.length) {
      throw new Error(
        `module type ${module.type} stores ${fields.length} parameters, ` +
          `but ${module.parameters.length} were given`,
      );
    }
    const values: MessageInit = {};
    fields.forEach((field, i) => { values[field] = module.parameters[i]; });

    const sections: MessageInit[] = [
      { type: SECTION.SingleModule, data: {
        type: module.type, section, index: module.index, xpos: module.x, ypos: module.y, name,
      } },
      { type: SECTION.CableDump, data: { section, ncables: 0, cables: [] } },
      { type: SECTION.ParameterDump, data: fields.length
        ? { section, nmodules: 1, parameters: [{ index: module.index, type: module.type, parameters: values }] }
        : { section, nmodules: 0, parameters: [] } },
      { type: SECTION.CustomDump, data: module.customs.length
        ? { section, nmodules: 1, customModules: [{
            index: module.index, nparams: module.customs.length,
            customValues: module.customs.map((value) => ({ value })),
          }] }
        : { section, nmodules: 0, customModules: [] } },
      { type: SECTION.NameDump, data: {
        section, nmodules: 1, moduleNames: [{ index: module.index, name }],
      } },
    ];

    // Patch := Section$section ?Patch$next
    let chain: MessageInit | undefined;
    for (const sectionData of sections.reverse()) {
      chain = chain ? { section: sectionData, next: chain } : { section: sectionData };
    }
    return this.encoder.encodeBits(chain!);
  }

  /**
   * Field names of a module type's stored parameters, in stream order. Each
   * type has its own `ParamN` rule; the order is the order modules.xml
   * declares the parameters in, which is also how the reader maps them.
   */
  private parameterFields(type: number): string[] {
    const rule = this.grammar.rules.get(`Param${type}`);
    return (rule?.body ?? []).flatMap((item) => (item.kind === 'var' ? [item.name] : []));
  }
}

export class PatchReader {
  private readonly decoder: Pdl2Decoder;

  constructor(patchGrammarSource: string) {
    this.decoder = new Pdl2Decoder(parsePdl2(patchGrammarSource));
  }

  read(bitstream: Uint8Array): Patch {
    return this.build(this.collectSections(bitstream, new Map()));
  }

  /**
   * Reads a patch delivered as separate parts.
   *
   * Each part answered by the device is its own bitstream, and the original
   * parses them one at a time into a shared builder rather than joining them
   * (`GetPatchWorker` calls `NmUtils.parsePatchMessage` per message). Joining
   * is wrong because a part's bit length need not be a multiple of eight, so
   * concatenating the byte-padded results injects stray bits between sections.
   */
  readParts(parts: Uint8Array[]): Patch {
    const sections = new Map<number, Decoded[]>();
    let parsed = 0;

    for (const part of parts) {
      if (!part.length) continue;
      try {
        this.collectSections(part, sections);
        parsed++;
      } catch {
        // One unreadable part should not lose the rest of the patch.
      }
    }

    if (!parsed) throw new Error(`none of the ${parts.length} patch parts could be read`);
    return this.build(sections);
  }

  /** Walks `Patch := Section$section ?Patch$next`, adding to `sections`. */
  private collectSections(
    bitstream: Uint8Array,
    sections: Map<number, Decoded[]>,
  ): Map<number, Decoded[]> {
    const result = this.decoder.decode(bitstream);

    for (let node: Decoded | undefined = result.root; node; node = one(node, 'next')) {
      const section = one(node, 'section');
      if (!section) continue;
      const type = section.values.get('type');
      if (type === undefined) continue;
      const list = sections.get(type) ?? [];
      list.push(section);
      sections.set(type, list);
    }

    return sections;
  }

  private build(sections: Map<number, Decoded[]>): Patch {
    const patch: Patch = {
      name: this.readName(sections),
      modules: this.readModules(sections),
      cables: this.readCables(sections),
      parameters: this.readParameters(sections),
      knobs: this.readKnobs(sections),
      sections,
    };

    this.applyModuleNames(patch, sections);
    return patch;
  }

  private readName(sections: Map<number, Decoded[]>): string {
    for (const type of [SECTION.PatchName, SECTION.PatchName2]) {
      for (const section of sections.get(type) ?? []) {
        const name = textOf(one(one(section, 'data'), 'name'));
        if (name) return name;
      }
    }
    return '';
  }

  private readModules(sections: Map<number, Decoded[]>): PatchModule[] {
    const modules: PatchModule[] = [];
    for (const section of sections.get(SECTION.ModuleDump) ?? []) {
      const dump = one(section, 'data');
      const area = areaOf(dump?.values.get('section'));
      for (const entry of many(dump, 'modules')) {
        modules.push({
          area,
          type: entry.values.get('type') ?? -1,
          index: entry.values.get('index') ?? -1,
          x: entry.values.get('xpos') ?? 0,
          y: entry.values.get('ypos') ?? 0,
        });
      }
    }
    return modules;
  }

  private readCables(sections: Map<number, Decoded[]>): PatchCable[] {
    const cables: PatchCable[] = [];
    for (const section of sections.get(SECTION.CableDump) ?? []) {
      const dump = one(section, 'data');
      const area = areaOf(dump?.values.get('section'));
      for (const entry of many(dump, 'cables')) {
        cables.push({
          area,
          color: entry.values.get('color') ?? 0,
          sourceModule: entry.values.get('source') ?? -1,
          sourceConnector: entry.values.get('inputOutput') ?? -1,
          sourceIsOutput: entry.values.get('type') ?? 0,
          destModule: entry.values.get('destination') ?? -1,
          destConnector: entry.values.get('input') ?? -1,
        });
      }
    }
    return cables;
  }

  /**
   * Parameter values per module.
   *
   * `patch.pdl2` gives each module type its own `ParamN` rule with fixed field
   * names, so the values are collected positionally in declaration order, which
   * is the order `modules.xml` lists that module's parameters in.
   */
  private readParameters(sections: Map<number, Decoded[]>): PatchParameters[] {
    const dumps: PatchParameters[] = [];
    for (const section of sections.get(SECTION.ParameterDump) ?? []) {
      const dump = one(section, 'data');
      const byModule = new Map<number, number[]>();

      for (const entry of many(dump, 'parameters')) {
        const index = entry.values.get('index');
        if (index === undefined) continue;
        const values = one(entry, 'parameters');
        byModule.set(index, values ? Array.from(values.values.values()) : []);
      }

      dumps.push({ area: areaOf(dump?.values.get('section')), byModule });
    }
    return dumps;
  }

  /**
   * `KnobMapDump` has a fixed entry per knob id, `knob0` to `knob22`, each
   * with an `assigned` flag and, when set, the parameter it drives. Its
   * `section` is two bits wide; only the two patch areas are modelled.
   */
  private readKnobs(sections: Map<number, Decoded[]>): Map<number, KnobTarget> {
    const knobs = new Map<number, KnobTarget>();
    for (const section of sections.get(SECTION.KnobMapDump) ?? []) {
      const dump = one(section, 'data');
      for (let knob = 0; knob <= 22; knob++) {
        const entry = one(dump, `knob${knob}`);
        // `assigned*KnobAssignment` is a counted repeat, so it decodes as a list.
        const [assignment] = many(entry, 'assignment');
        if (!assignment) continue;
        const area = assignment.values.get('section');
        if (area !== 0 && area !== 1) continue;
        knobs.set(knob, {
          area: areaOf(area),
          module: assignment.values.get('module') ?? -1,
          parameter: assignment.values.get('parameter') ?? -1,
        });
      }
    }
    return knobs;
  }

  /** `NameDump` carries the user-assigned label for each module, if any. */
  private applyModuleNames(patch: Patch, sections: Map<number, Decoded[]>): void {
    for (const section of sections.get(SECTION.NameDump) ?? []) {
      const dump = one(section, 'data');
      const area = areaOf(dump?.values.get('section'));
      for (const entry of many(dump, 'moduleNames')) {
        const index = entry.values.get('index');
        const name = textOf(one(entry, 'name'));
        if (index === undefined || !name) continue;
        const target = patch.modules.find((m) => m.area === area && m.index === index);
        if (target) target.name = name;
      }
    }
  }
}
