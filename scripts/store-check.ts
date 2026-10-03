/**
 * Guards storing a patch into a bank: the StorePatch command, the rename that
 * can precede it, and the names the device accepts.
 */
import { readFileSync } from 'node:fs';
import { parsePdl2 } from '../src/pdl2/parser.ts';
import { Pdl2Decoder } from '../src/pdl2/interpreter.ts';
import { NordModular, patchNameProblem, STORE_POSITIONS } from '../src/midi/nord.ts';
import type { WebMidiTransport } from '../src/midi/webmidi.ts';

const read = (name: string) =>
  readFileSync(new URL(`../public/data/${name}`, import.meta.url), 'utf8');

const decoder = new Pdl2Decoder(parsePdl2(read('midi.pdl2')));
const hex = (b: Uint8Array) =>
  Array.from(b).map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = '') {
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}\n`);
  ok ? pass++ : fail++;
}

const sent: Uint8Array[] = [];
const transport = {
  send: (message: Uint8Array) => { sent.push(message); },
  addListener: () => () => {},
} as unknown as WebMidiTransport;
const nord = new NordModular(transport, read('midi.pdl2'));
const throws = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };

process.stdout.write('\nStorePatch (cc 0x17, pp 0x41, ssc 0x0b)\n');
{
  const bytes = nord.storePatch(0, 2, 41);
  process.stdout.write(`  ${hex(bytes)}\n`);
  check('PatchHandling for slot 0', bytes[2] === 0x17 << 2, `0x${bytes[2].toString(16)}`);
  check('pp 0x41, ssc 0x0b', bytes[4] === 0x41 && bytes[5] === 0x0b, hex(bytes.subarray(4, 6)));
  check('slot, bank, position', bytes[6] === 0 && bytes[7] === 2 && bytes[8] === 41, hex(bytes.subarray(6, 9)));
  const decoded = decoder.decode(bytes, { validateComputed: true });
  const command = ((decoded.root.items.get('data') as any)?.items.get('data') as any)?.items.get('command');
  const data = command?.items.get('data');
  check('decodes as StorePatch, checksum valid, every byte used',
    command?.values.get('ssc') === 0x0b && data?.values.get('section') === 2 &&
      data?.values.get('position') === 41 && decoded.bitsConsumed === bytes.length * 8, '');
  check('a bank holds positions 0-98', STORE_POSITIONS === 99);
  check('position 99 is refused', throws(() => nord.storePatch(0, 0, 99)));
  check('bank 9 is refused', throws(() => nord.storePatch(0, 9, 0)));
}

process.stdout.write('\nSetPatchTitle (sc 0x27)\n');
{
  const bytes = nord.setPatchTitle(0, 'Filthy filt 2');
  process.stdout.write(`  ${hex(bytes)}\n`);
  check('PatchModification sc 0x27', bytes[2] === 0x17 << 2 && bytes[5] === 0x27, `0x${bytes[5].toString(16)}`);
  const decoded = decoder.decode(bytes, { validateComputed: true });
  const name = ((decoded.root.items.get('data') as any)?.items.get('data') as any)
    ?.items.get('data')?.items.get('name')?.items.get('chars')
    ?.map((c: any) => String.fromCharCode(c.values.get('value'))).join('').replace(/\0+$/, '');
  check('the name round-trips', name === 'Filthy filt 2', JSON.stringify(name));
  check('every byte used', decoded.bitsConsumed === bytes.length * 8);
}

process.stdout.write('\nNames the device accepts (NmCharacter.isValid)\n');
{
  check('letters, digits, space and punctuation', patchNameProblem('Si_acid Bass-2!') === null);
  check('16 characters is the limit', patchNameProblem('x'.repeat(16)) === null &&
    patchNameProblem('x'.repeat(17)) !== null);
  check('"~" is refused', patchNameProblem('a~b') !== null, patchNameProblem('a~b') ?? '');
  check('accented letters are refused', patchNameProblem('Café') !== null);
  check('an empty name is refused', patchNameProblem('  ') !== null);
  check('a bad name is never sent', throws(() => nord.setPatchTitle(0, 'Café')));
}

process.stdout.write(`\n${pass} ok, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
