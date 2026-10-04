import {
  createPatch,
  type HeldNote,
  type Patch,
  type PatchArea,
  type PatchCable,
} from './patch.ts';

/**
 * The .pch patch file, as the Clavia editor and Nomad read and write it.
 *
 * Text sections, `[Name]` … `[/Name]`. Areas are numbered as on the device:
 * 1 the poly voice area, 0 the common area. The rules here follow Nomad's
 * PParser / PScanner (reading) and PatchExporter / PatchFileWriter (writing).
 * The file carries no patch name; it comes from the file name.
 */

export class PchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PchError';
  }
}

const areaFromBit = (bit: number): PatchArea => (bit === 1 ? 'voice' : 'common');
const bitFromArea = (area: PatchArea): number => (area === 'voice' ? 1 : 0);

/** "My Patch.pch" -> "My Patch", as NmUtils.getPatchNameFromfileName does. */
export function patchNameFromFileName(fileName: string): string {
  return fileName.replace(/^.*[\\/]/, '').replace(/\.pch$/i, '');
}

// ---- reading ----

interface RawSection {
  name: string;
  body: string;
}

/**
 * Splits a file into its sections. Section names are matched without regard
 * to case, as PParser does; [Notes] runs to its closing tag, or to the end.
 */
function splitSections(text: string): RawSection[] {
  const sections: RawSection[] = [];
  const open = /\[([A-Za-z]+)\]/g;
  let match: RegExpExecArray | null;
  let position = 0;
  while ((open.lastIndex = position, match = open.exec(text))) {
    const name = match[1];
    const start = match.index + match[0].length;
    if (name.toLowerCase() === 'notes') {
      const close = text.toLowerCase().indexOf('[/notes]', start);
      sections.push({ name, body: text.slice(start, close < 0 ? undefined : close) });
      break;
    }
    const closeTag = new RegExp(`\\[/${name}\\]`, 'i');
    closeTag.lastIndex = start;
    const rest = text.slice(start);
    const close = rest.search(closeTag);
    if (close < 0) throw new PchError(`[${name}] has no closing [/${name}]`);
    sections.push({ name, body: rest.slice(0, close) });
    position = start + close + name.length + 3;
  }
  return sections;
}

/** Whitespace-separated integers; a record may span lines or share one. */
function numbersOf(section: RawSection, body = section.body): number[] {
  const tokens = body.split(/\s+/).filter(Boolean);
  return tokens.map((token) => {
    if (!/^-?\d+$/.test(token)) {
      throw new PchError(`[${section.name}] has "${token}" where a number should be`);
    }
    return Number(token);
  });
}

/** Cuts a flat list into fixed-size records; a short last record is dropped, as PParser does. */
function records(values: number[], size: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i + size <= values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/** Records whose length is read from the record itself: `count` at position `countAt`. */
function variableRecords(values: number[], fixed: number, countAt: number): number[][] {
  const out: number[][] = [];
  let i = 0;
  while (i + fixed <= values.length) {
    const size = fixed + values[i + countAt];
    if (i + size > values.length) break;
    out.push(values.slice(i, i + size));
    i += size;
  }
  return out;
}

/** The area line that opens ModuleDump, CableDump, ParameterDump, CustomDump and NameDump. */
function splitArea(section: RawSection): { area: PatchArea; body: string } {
  const match = /^\s*(-?\d+)/.exec(section.body);
  if (!match || (match[1] !== '0' && match[1] !== '1')) {
    throw new PchError(`[${section.name}] should start with its area, 1 (voice) or 0 (common)`);
  }
  return { area: areaFromBit(Number(match[1])), body: section.body.slice(match[0].length) };
}

export function parsePch(text: string, fileName = ''): Patch {
  const source = text.replace(/\r\n?/g, '\n');
  const patch = createPatch({ name: patchNameFromFileName(fileName) });
  const sections = splitSections(source);
  if (!sections.length || sections[0].name.toLowerCase() !== 'header') {
    throw new PchError('this is not a Nord Modular patch file: it does not start with [Header]');
  }

  for (const section of sections) {
    switch (section.name.toLowerCase()) {
      case 'header': {
        const numbers: number[] = [];
        for (const line of section.body.split('\n')) {
          if (!line.includes('=')) numbers.push(...numbersOf(section, line));
          else if (/version/i.test(line) && line.includes('2.10')) {
            throw new PchError('this patch is in the old 2.10 format, which is not supported');
          }
        }
        if (numbers.length < 23) throw new PchError(`[Header] has ${numbers.length} of its 23 numbers`);
        patch.header = numbers.slice(0, 23);
        break;
      }
      case 'moduledump': {
        const { area, body } = splitArea(section);
        for (const [index, type, x, y] of records(numbersOf(section, body), 4)) {
          patch.modules.push({ area, type, index, x, y });
        }
        break;
      }
      case 'currentnotedump':
        patch.heldNotes = records(numbersOf(section), 3)
          .map(([note, attack, release]): HeldNote => ({ note, attack, release }));
        break;
      case 'cabledump': {
        const { area, body } = splitArea(section);
        for (const [color, dm, dc, dt, sm, sc, st] of records(numbersOf(section, body), 7)) {
          // A stored cable ends at an input; if the file names an output as the
          // destination, the ends swap, as Nomad's connect does.
          const cable: PatchCable = dt === 1
            ? { area, color, sourceModule: dm, sourceConnector: dc, sourceIsOutput: 1, destModule: sm, destConnector: sc }
            : { area, color, sourceModule: sm, sourceConnector: sc, sourceIsOutput: st, destModule: dm, destConnector: dc };
          patch.cables.push(cable);
        }
        break;
      }
      case 'parameterdump': {
        const { area, body } = splitArea(section);
        const byModule = new Map<number, number[]>();
        for (const record of variableRecords(numbersOf(section, body), 3, 2)) {
          byModule.set(record[0], record.slice(3));
        }
        patch.parameters.push({ area, byModule });
        break;
      }
      case 'customdump': {
        const { area, body } = splitArea(section);
        const byModule = new Map<number, number[]>();
        for (const record of variableRecords(numbersOf(section, body), 2, 1)) {
          byModule.set(record[0], record.slice(2));
        }
        patch.customs.push({ area, byModule });
        break;
      }
      case 'knobmapdump':
        for (const [area, module, parameter, knob] of records(numbersOf(section), 4)) {
          if (area === 2) patch.morphKnobs.set(knob, parameter);
          else patch.knobs.set(knob, { area: areaFromBit(area), module, parameter });
        }
        break;
      case 'ctrlmapdump':
        for (const [area, module, parameter, cc] of records(numbersOf(section), 4)) {
          patch.controllers.push({ cc, area: area === 2 ? 'morph' : areaFromBit(area), module, parameter });
        }
        break;
      case 'keyboardassignment': {
        const [assignment] = records(numbersOf(section), 4);
        if (assignment) patch.morphs.keyboard = assignment;
        break;
      }
      case 'morphmapdump': {
        const values = numbersOf(section);
        if (values.length < 4) break;
        patch.morphs.values = values.slice(0, 4);
        patch.morphs.assignments = records(values.slice(4), 5).map(([area, module, parameter, morph, range]) => ({
          area: areaFromBit(area), module, parameter, morph, range,
        }));
        break;
      }
      case 'namedump': {
        const { area, body } = splitArea(section);
        for (const line of body.split('\n')) {
          // A module index, then the rest of the line, less one separating space.
          const match = /^\s*(\d+)(.*)$/.exec(line);
          if (!match) continue;
          const module = patch.modules.find((m) => m.area === area && m.index === Number(match[1]));
          if (module) module.name = match[2].replace(/^\s/, '');
        }
        break;
      }
      case 'notes': {
        // The newline after [Notes] and the one before [/Notes] are the tags'.
        patch.notes = section.body.replace(/^[ \t]*\n/, '').replace(/\n[ \t]*$/, '');
        break;
      }
      default:
        throw new PchError(`unknown section [${section.name}]`);
    }
  }
  return patch;
}

// ---- writing ----

const CRLF = '\r\n';
/** Every number followed by one space, as PatchFileWriter prints int lists. */
const line = (values: number[]) => values.map((v) => `${v} `).join('') + CRLF;

/**
 * A cable as a .pch record, ordered and sorted as PatchExporter does:
 * `[color, dstModule, dstConnector, dstType, srcModule, srcConnector, srcType]`,
 * an input-to-input cable written lower end first.
 */
function cableRecord(cable: PatchCable): number[] {
  const record = [
    cable.color, cable.destModule, cable.destConnector, 0,
    cable.sourceModule, cable.sourceConnector, cable.sourceIsOutput,
  ];
  if (record[3] === 0 && record[6] === 0 &&
      (record[1] > record[4] || (record[1] === record[4] && record[2] > record[5]))) {
    return [record[0], record[4], record[5], record[6], record[1], record[2], record[3]];
  }
  return record;
}

/** CableSort: lexicographic on fields 0, 1, 3, 2, 4, 6, 5. */
function compareCables(a: number[], b: number[]): number {
  for (const i of [0, 1, 3, 2, 4, 6, 5]) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function writePch(patch: Patch): string {
  let out = '';
  const section = (name: string, body: string, area?: PatchArea) => {
    out += `[${name}]${CRLF}`;
    if (area) out += `${bitFromArea(area)}${CRLF}`;
    out += body;
    out += `[/${name}]${CRLF}`;
  };
  const areas: PatchArea[] = ['voice', 'common'];
  const byIndex = <T extends { index: number }>(list: T[]) => [...list].sort((a, b) => a.index - b.index);

  section('Header', `Version=Nord Modular patch 3.0${CRLF}${line(patch.header)}`);

  for (const area of areas) {
    const modules = byIndex(patch.modules.filter((m) => m.area === area));
    section('ModuleDump', modules.map((m) => line([m.index, m.type, m.x, m.y])).join(''), area);
  }

  if (patch.heldNotes.length) {
    const notes = patch.heldNotes.flatMap((n) => [n.note, n.attack, n.release]);
    section('CurrentNoteDump', notes.map((v) => `${v} `).join('') + CRLF);
  }

  for (const area of areas) {
    const cables = patch.cables.filter((c) => c.area === area).map(cableRecord).sort(compareCables);
    section('CableDump', cables.map(line).join(''), area);
  }

  for (const area of areas) {
    const types = new Map(patch.modules.filter((m) => m.area === area).map((m) => [m.index, m.type]));
    const values = patch.parameters.find((p) => p.area === area)?.byModule ?? new Map<number, number[]>();
    const body = [...values].filter(([index]) => types.has(index)).sort(([a], [b]) => a - b)
      .map(([index, list]) => line([index, types.get(index)!, list.length, ...list])).join('');
    section('ParameterDump', body, area);
  }

  const morphs = patch.morphs;
  const assignments = [...morphs.assignments].sort((a, b) => a.morph - b.morph);
  section('MorphMapDump', line(morphs.values) + assignments.map((a) =>
    line([bitFromArea(a.area), a.module, a.parameter, a.morph, a.range])).join(''));
  section('KeyboardAssignment', line(morphs.keyboard));

  const knobs = [
    ...[...patch.knobs].map(([knob, t]) => [bitFromArea(t.area), t.module, t.parameter, knob]),
    ...[...patch.morphKnobs].map(([knob, morph]) => [2, 1, morph, knob]),
  ].sort((a, b) => a[3] - b[3]);
  section('KnobMapDump', knobs.map(line).join(''));

  const controllers = [...patch.controllers].sort((a, b) => a.cc - b.cc).map((c) =>
    [c.area === 'morph' ? 2 : bitFromArea(c.area), c.module, c.parameter, c.cc]);
  section('CtrlMapDump', controllers.map(line).join(''));

  for (const area of areas) {
    const indexes = new Set(patch.modules.filter((m) => m.area === area).map((m) => m.index));
    const values = patch.customs.find((c) => c.area === area)?.byModule ?? new Map<number, number[]>();
    const body = [...values].filter(([index, list]) => indexes.has(index) && list.length)
      .sort(([a], [b]) => a - b)
      .map(([index, list]) => line([index, list.length, ...list])).join('');
    section('CustomDump', body, area);
  }

  for (const area of areas) {
    const modules = byIndex(patch.modules.filter((m) => m.area === area));
    section('NameDump', modules.map((m) => `${m.index} ${m.name ?? ''}${CRLF}`).join(''), area);
  }

  const notes = patch.notes.replace(/\r/g, '').replace(/\n/g, CRLF);
  section('Notes', notes ? `${notes}${CRLF}` : '');
  return out;
}
