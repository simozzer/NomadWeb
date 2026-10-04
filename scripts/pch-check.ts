/**
 * Guards .pch files and whole-patch upload: reading and writing the file as
 * Nomad does, and turning a patch into the sixteen sections and packets the
 * device takes. The fixtures are the sample patches Nomad 0.3.2 ships.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { DOMParser } from 'linkedom';

(globalThis as any).DOMParser = DOMParser;

const { parsePdl2 } = await import('../src/pdl2/parser.ts');
const { Pdl2Decoder } = await import('../src/pdl2/interpreter.ts');
const { parsePch, writePch, patchNameFromFileName } = await import('../src/model/pch.ts');
const { PatchReader, PatchWriter, createPatch } = await import('../src/model/patch.ts');
const { patchUploadPackets, unpack7Bit, patchPacketOverrides, commandCodeOf } = await import('../src/midi/nord.ts');
const { parseModuleCatalogue, controlParameters } = await import('../src/model/modules.ts');

const read = (name: string) => readFileSync(new URL(`../public/data/${name}`, import.meta.url), 'utf8');
const fixtures = new URL('./fixtures/', import.meta.url);

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = '') {
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}\n`);
  ok ? pass++ : fail++;
}

const catalogue = parseModuleCatalogue(read('modules.xml'));
const writer = new PatchWriter(read('patch.pdl2'));
const reader = new PatchReader(read('patch.pdl2'));
const midiDecoder = new Pdl2Decoder(parsePdl2(read('midi.pdl2')));

type Patch = ReturnType<typeof createPatch>;

/** Everything a file or the device keeps, in a comparable order. */
function essence(patch: Patch, { withNotes = true } = {}) {
  const sortBy = <T>(list: T[], key: (t: T) => string) => [...list].sort((a, b) => key(a).localeCompare(key(b)));
  const maps = (list: { area: string; byModule: Map<number, number[]> }[]) => sortBy(
    list.flatMap((d) => [...d.byModule].filter(([, v]) => v.length).map(([i, v]) => `${d.area}#${i}:${v.join(',')}`)),
    (s) => s);
  return JSON.stringify({
    header: patch.header,
    modules: sortBy(patch.modules, (m) => `${m.area}${String(m.index).padStart(3)}`)
      .map((m) => `${m.area}#${m.index} t${m.type} ${m.x},${m.y} "${m.name ?? ''}"`),
    cables: sortBy(patch.cables.map((c) =>
      `${c.area} ${c.color} ${c.sourceModule}:${c.sourceConnector}/${c.sourceIsOutput}>${c.destModule}:${c.destConnector}`), (s) => s),
    parameters: maps(patch.parameters),
    customs: maps(patch.customs),
    knobs: [...patch.knobs].sort(([a], [b]) => a - b),
    morphKnobs: [...patch.morphKnobs].sort(([a], [b]) => a - b),
    morphs: { ...patch.morphs, assignments: sortBy(patch.morphs.assignments, (a) => JSON.stringify(a)) },
    controllers: sortBy(patch.controllers, (c) => JSON.stringify(c)),
    heldNotes: patch.heldNotes,
    ...(withNotes ? { notes: patch.notes } : {}),
  });
}

/** What the device would send back for these sections. */
const throughDevice = (patch: Patch) => reader.readParts(writer.patchSections(patch).map((s) => s.bytes));

process.stdout.write('\nReading the sample patches\n');
const samples = readdirSync(fixtures).filter((f) => f.endsWith('.pch')).sort();
check('seven samples', samples.length === 7, samples.join(', '));
const parsed = new Map(samples.map((f) => [f, parsePch(readFileSync(new URL(f, fixtures), 'latin1'), f)]));
{
  const latch = parsed.get('D-Latch.pch')!;
  check('the name comes from the file name', latch.name === 'D-Latch' && patchNameFromFileName('C:\\x\\My Pad.PCH') === 'My Pad');
  check('D-Latch: 7 voice modules, none common', latch.modules.length === 7 && latch.modules.every((m) => m.area === 'voice'));
  check('D-Latch: 9 cables', latch.cables.length === 9, `${latch.cables.length}`);
  check('D-Latch: names kept literally, "$" and all',
    latch.modules.find((m) => m.index === 1)?.name === '1S$2', latch.modules.find((m) => m.index === 1)?.name);
  check('D-Latch: notes, without the tags\' newlines', latch.notes.startsWith('D-latch\n-------') && latch.notes.endsWith('1| 1  1\n'),
    JSON.stringify(latch.notes.slice(-12)));
  check('D-Latch: header split position 4000', latch.header[8] === 4000 && latch.header.length === 23);
  const seq = parsed.get('Test-Sequence.pch')!;
  check('Test-Sequence: a 21-value parameter record', seq.parameters[0].byModule.get(1)?.length === 21);
  check('Test-Sequence: custom values', seq.customs.find((c) => c.area === 'voice')?.byModule.get(1)?.join() === '1,6');
  check('Test-Sequence: empty notes', seq.notes === '', JSON.stringify(seq.notes));

  // Values must line up with the catalogue, or the device would misread them.
  const mismatches: string[] = [];
  for (const [file, patch] of parsed) {
    for (const m of patch.modules) {
      const def = catalogue.modules.get(m.type);
      const values = patch.parameters.find((p) => p.area === m.area)?.byModule.get(m.index);
      if (def && values && values.length !== controlParameters(def).length) mismatches.push(`${file} #${m.index}`);
    }
  }
  check('parameter counts match the catalogue for every module', mismatches.length === 0, mismatches.join(', '));
}

process.stdout.write('\nWriting them back\n');
{
  let same = 0;
  const differ: string[] = [];
  for (const [file, patch] of parsed) {
    const again = parsePch(writePch(patch), file);
    if (essence(again) === essence(patch)) same++;
    else differ.push(file);
  }
  check('every sample survives file -> patch -> file -> patch', same === samples.length, differ.join(', '));

  const text = writePch(parsed.get('D-Latch.pch')!);
  const lines = text.split('\r\n');
  check('CRLF throughout', !text.replace(/\r\n/g, '').includes('\n'));
  check('starts with the header and its version', lines[0] === '[Header]' && lines[1] === 'Version=Nord Modular patch 3.0');
  check('numbers each followed by a space', lines[2].endsWith(' ') && lines[2].startsWith('0 127 0 127 2 0 0 1 4000 '));
  const order = lines.filter((l) => /^\[[A-Za-z]+\]$/.test(l)).map((l) => l.slice(1, -1));
  check('sections in the exporter\'s order', order.join(',') ===
    'Header,ModuleDump,ModuleDump,CableDump,CableDump,ParameterDump,ParameterDump,MorphMapDump,KeyboardAssignment,' +
      'KnobMapDump,CtrlMapDump,CustomDump,CustomDump,NameDump,NameDump,Notes', order.join(','));
  check('voice area first, marked 1', lines[lines.indexOf('[ModuleDump]') + 1] === '1');
  const cableLines = lines.slice(lines.indexOf('[CableDump]') + 2, lines.indexOf('[/CableDump]'));
  check('cables sorted as CableSort does', cableLines.join('|') === [
    '2 1 0 0 5 0 1 ', '2 1 1 0 4 0 1 ', '2 2 0 0 6 0 1 ', '2 2 1 0 3 0 1 ', '2 3 0 0 1 0 1 ',
    '2 4 0 0 2 0 1 ', '2 6 0 0 7 0 1 ', '6 5 0 0 7 0 0 ', '6 5 1 0 6 1 0 '].join('|'), cableLines.join('|'));
  check('names written "index name"', lines.includes('1 1S$2'));
}

process.stdout.write('\nThe parts the samples do not use\n');
const rich = createPatch({
  name: 'Everything',
  header: [12, 100, 1, 126, 5, 30, 1, 4, 2000, 3, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 1, 0, 1],
  modules: [
    { area: 'voice', type: 7, index: 1, x: 0, y: 0, name: 'Osc' },
    { area: 'voice', type: 20, index: 2, x: 1, y: 3, name: 'Env' },
    { area: 'common', type: 19, index: 1, x: 0, y: 0, name: 'Mix' },
  ],
  cables: [{ area: 'voice', color: 1, sourceModule: 2, sourceConnector: 0, sourceIsOutput: 1, destModule: 1, destConnector: 0 }],
  parameters: [
    { area: 'voice', byModule: new Map([[1, [64, 64, 64, 64, 0, 0, 0, 0, 0, 0]], [2, [1, 10, 20, 30, 40, 0]]]) },
    { area: 'common', byModule: new Map([[1, [100, 90, 80]]]) },
  ],
  knobs: new Map([[0, { area: 'voice' as const, module: 2, parameter: 1 }]]),
  morphKnobs: new Map([[2, 3]]),
  morphs: {
    values: [10, 0, 127, 64], keyboard: [1, 0, 2, 0],
    assignments: [
      { area: 'voice', module: 1, parameter: 0, morph: 0, range: -60 },
      { area: 'common', module: 1, parameter: 2, morph: 3, range: 127 },
    ],
  },
  controllers: [{ cc: 7, area: 'voice', module: 2, parameter: 3 }, { cc: 1, area: 'morph', module: 1, parameter: 2 }],
  heldNotes: [{ note: 60, attack: 100, release: 0 }, { note: 67, attack: 90, release: 0 }],
  notes: 'two lines\nof notes',
});
{
  const again = parsePch(writePch(rich), 'Everything.pch');
  check('morphs, keyboard, morph knob, controllers, held notes survive a file',
    essence(again) === essence(rich), '');
}

process.stdout.write('\nTo the device and back\n');
{
  const sections = writer.patchSections(rich);
  check('sixteen sections, as Patch2BitstreamBuilder makes', sections.length === 16, `${sections.length}`);
  const back = throughDevice(rich);
  // Not stored on the device: the notes text, the header's four unknowns.
  const expected = { ...rich, notes: '' };
  check('everything the device stores comes back', essence(back, { withNotes: false }) === essence(expected, { withNotes: false }),
    '');
  check('a negative morph range survives the 8-bit field',
    back.morphs.assignments.find((a) => a.morph === 0)?.range === -60);
  check('the name travels', back.name === 'Everything', back.name);

  // The device always holds at least one note; a file that names none gets
  // the 64/0/0 Nomad sends.
  const failed: string[] = [];
  for (const [file, patch] of parsed) {
    const heldNotes = patch.heldNotes.length ? patch.heldNotes : [{ note: 64, attack: 0, release: 0 }];
    if (essence(throughDevice(patch), { withNotes: false }) !== essence({ ...patch, heldNotes }, { withNotes: false })) {
      failed.push(file);
    }
  }
  check('every sample survives file -> device sections -> patch', failed.length === 0, failed.join(', '));
}

process.stdout.write('\nThe packets\n');
{
  const sections = writer.patchSections(rich);
  const packets = patchUploadPackets(0, sections);
  const ccs = packets.map(commandCodeOf);
  check('first 0x1d, middle 0x1c, last 0x1e',
    ccs[0] === 0x1d && ccs.slice(1, -1).every((cc) => cc === 0x1c) && ccs.at(-1) === 0x1e,
    ccs.map((c) => c.toString(16)).join(' '));
  check('command 1, numbered from 1 in place of the patch id',
    packets.every((p, i) => p[4] === (0x40 | (i + 1))), packets.map((p) => p[4].toString(16)).join(' '));
  check('every packet decodes, checksum valid', packets.every((p) => {
    const decoded = midiDecoder.decode(p, { validateComputed: true, overrides: patchPacketOverrides(p) });
    return decoded.messageId === 'PatchPacket' && decoded.bitsConsumed === p.length * 8;
  }));
  const reassembled = reader.readParts(packets.map((p) => unpack7Bit(p.subarray(5, p.length - 2))));
  check('the packets carry the patch', essence(reassembled, { withNotes: false }) === essence({ ...rich, notes: '' }, { withNotes: false }));
  check('slot rides in the cc byte', patchUploadPackets(2, sections).every((p) => (p[2] & 3) === 2));
}

process.stdout.write('\nBad files are refused with a reason\n');
{
  const reason = (text: string) => { try { parsePch(text); return ''; } catch (e) { return (e as Error).message; } };
  check('not a patch at all', /Header/.test(reason('hello')), reason('hello'));
  check('an unclosed section', /closing/.test(reason('[Header]\n0 127\n')), reason('[Header]\n0 127\n'));
  check('a word where a number goes', /number/.test(reason('[Header]\nVersion=x\n0 1 x\n[/Header]')), '');
  check('the old 2.10 format', /2\.10/.test(reason('[Header]\nVersion=Nord Modular patch 2.10\n[/Header]')), '');
}

process.stdout.write(`\n${pass} ok, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
