/**
 * Guards adding a module: the patch fragment `NewModuleMessage.newModule`
 * builds, and the single patch packet it travels in.
 */
import { readFileSync } from 'node:fs';
import { DOMParser } from 'linkedom';

(globalThis as any).DOMParser = DOMParser;

const { parsePdl2 } = await import('../src/pdl2/parser.ts');
const { Pdl2Decoder } = await import('../src/pdl2/interpreter.ts');
const { PatchReader, PatchWriter, SECTION } = await import('../src/model/patch.ts');
const { patchPacket, pack7Bit, unpack7Bit, patchPacketOverrides, commandCodeOf } =
  await import('../src/midi/nord.ts');
const { parseModuleCatalogue, controlParameters } = await import('../src/model/modules.ts');

const read = (name: string) =>
  readFileSync(new URL(`../public/data/${name}`, import.meta.url), 'utf8');

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
const customs = (def: any) => def.parameters.filter((p: any) => p.className === 'custom');
const defaults = (list: any[]) => list.map((p) => p.defaultValue);

process.stdout.write('\nEvery module type can be written\n');
{
  const failures: string[] = [];
  for (const def of catalogue.modules.values()) {
    if (def.category === 'Morph') continue;
    try {
      const fragment = writer.newModule({
        type: def.index, area: 'voice', index: 1, x: 0, y: 0, name: def.name,
        parameters: defaults(controlParameters(def)), customs: defaults(customs(def)),
      });
      // It must read back as the same module with the same values.
      const back = reader.read(fragment.bytes);
      const stored = back.parameters.find((p) => p.area === 'voice')?.byModule.get(1) ?? [];
      if (stored.join() !== defaults(controlParameters(def)).join()) {
        failures.push(`${def.name}: values ${stored.join()} vs ${defaults(controlParameters(def)).join()}`);
      }
    } catch (error) {
      failures.push(`${def.name}: ${(error as Error).message}`);
    }
  }
  check('all 109 types write and read back with their default values',
    failures.length === 0, failures.slice(0, 4).join(' · '));
}

process.stdout.write('\nOne module, through the packet and back\n');
{
  const adsr = catalogue.modules.get(20)!;
  const values = [1, 30, 60, 90, 20, 0];
  const fragment = writer.newModule({
    type: 20, area: 'voice', index: 7, x: 2, y: 13, name: 'ADSR1',
    parameters: values, customs: [],
  });
  const packet = patchPacket(0, 9, fragment);
  process.stdout.write(`  ${Array.from(packet, (b) => b.toString(16).padStart(2, '0')).join(' ')}\n`);

  check('cc 0x1f: a patch packet that is both first and last', commandCodeOf(packet) === 0x1f,
    `0x${commandCodeOf(packet).toString(16)}`);
  check('command 0 and the pid share byte 4', packet[4] === 9, `0x${packet[4].toString(16)}`);
  check('every payload byte is 7-bit', Array.from(packet.subarray(1, -1)).every((b) => b < 0x80));

  const decoded = midiDecoder.decode(packet, { validateComputed: true, overrides: patchPacketOverrides(packet) });
  check('decodes as a PatchPacket with a valid checksum',
    decoded.messageId === 'PatchPacket' && decoded.bitsConsumed === packet.length * 8, decoded.messageId);

  const bits = unpack7Bit(packet.subarray(5, packet.length - 2));
  const patch = reader.read(bits);
  // SingleModule is only ever sent, so the reader does not model it; check its fields.
  const single = (patch.sections.get(SECTION.SingleModule)?.[0]?.items.get('data') as any);
  const field = (name: string) => single?.values.get(name);
  check('the module comes back: type, voice area (section 1), index, cell',
    field('type') === 20 && field('section') === 1 && field('index') === 7 &&
      field('xpos') === 2 && field('ypos') === 13,
    ['type', 'section', 'index', 'xpos', 'ypos'].map((n) => `${n}=${field(n)}`).join(' '));
  const nameDump = (patch.sections.get(SECTION.NameDump)?.[0]?.items.get('data') as any);
  const nameChars = nameDump?.items.get('moduleNames')?.[0]?.items.get('name')?.items.get('chars') ?? [];
  const name = nameChars.map((c: any) => String.fromCharCode(c.values.get('value'))).join('').replace(/\0+$/, '');
  check('with its name', name === 'ADSR1', JSON.stringify(name));
  check('and its parameter values', patch.parameters[0]?.byModule.get(7)?.join() === values.join(),
    patch.parameters[0]?.byModule.get(7)?.join());
  check('five sections, in NewModuleMessage\'s order',
    [...patch.sections.keys()].join() ===
      [SECTION.SingleModule, SECTION.CableDump, SECTION.ParameterDump, SECTION.CustomDump, SECTION.NameDump].join(),
    [...patch.sections.keys()].join());
  check('the ADSR has no custom values', customs(adsr).length === 0);
}

process.stdout.write('\nThe 7-bit packing follows NewModuleMessage exactly\n');
{
  // 14 bits -> +6 = 20 -> two whole groups; the remaining 6 are dropped.
  const groups = pack7Bit(Uint8Array.from([0b1010_1010, 0b1100_0000]), 14);
  check('pads by six bits and drops a short remainder', groups.join() === [0b1010101, 0b0110000].join(),
    groups.map((g) => g.toString(2)).join(' '));
  // Exactly 7 bits -> +6 = 13 -> one group: the padding never makes a group of its own.
  check('padding alone never becomes a group', pack7Bit(Uint8Array.from([0xfe]), 7).length === 1, '');
}

process.stdout.write(`\n${pass} ok, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
