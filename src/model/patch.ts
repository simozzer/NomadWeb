import { parsePdl2 } from '../pdl2/parser.ts';
import { Pdl2Decoder, type Decoded } from '../pdl2/interpreter.ts';

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

export interface Patch {
  name: string;
  modules: PatchModule[];
  cables: PatchCable[];
  parameters: PatchParameters[];
  /** Every section as decoded, keyed by type code, for anything not modelled. */
  sections: Map<number, Decoded[]>;
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

const areaOf = (value: number | undefined): PatchArea => (value === 1 ? 'common' : 'voice');

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
