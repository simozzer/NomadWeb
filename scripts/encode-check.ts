import { readFileSync } from 'node:fs';
import { parsePdl2 } from '../src/pdl2/parser.ts';
import { Pdl2Decoder, Pdl2Encoder } from '../src/pdl2/interpreter.ts';

const grammar = parsePdl2(
  readFileSync(new URL('../public/data/midi.pdl2', import.meta.url), 'utf8'),
);
const encoder = new Pdl2Encoder(grammar);
const decoder = new Pdl2Decoder(grammar);

const hex = (b: Uint8Array) =>
  Array.from(b).map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail: string) {
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}\n`);
  ok ? pass++ : fail++;
}

// 1. The IAm request the host sends to discover the device.
process.stdout.write('\nIAm request (host -> device)\n');
{
  const bytes = encoder.encode({
    cc: 0x00,
    slot: 0,
    data: { sender: 0, versionHigh: 0, versionLow: 0 },
  });
  process.stdout.write(`  ${hex(bytes)}\n`);
  check('starts F0 33, ends F7', bytes[0] === 0xf0 && bytes[1] === 0x33 && bytes.at(-1) === 0xf7, '');
  // cc=0 slot=0 packs to 0x00, followed by the constant 0x06.
  check('command byte and 0x06 marker', bytes[2] === 0x00 && bytes[3] === 0x06, hex(bytes.subarray(2, 4)));
  check('IAm carries no checksum (per grammar)', bytes.length === 8, `${bytes.length} bytes`);
}

// 2. A parameter change — the message an editor sends most often — round-tripped.
process.stdout.write('\nParameterChange (host -> device), slot 1, module 5, param 2 = 100\n');
{
  const bytes = encoder.encode({
    cc: 0x13,
    slot: 1,
    data: { pid: 0, sc: 0x40, data: { section: 0, module: 5, parameter: 2, value: 100 } },
  });
  process.stdout.write(`  ${hex(bytes)}\n`);

  // Re-decode with checksum validation on: this proves the encoder computed it.
  try {
    const back = decoder.decode(bytes, { validateComputed: true });
    const inner = back.root.items.get('data') as any;
    const change = inner.items.get('data');
    check('checksum validates on re-decode', true, '');
    check('slot survives round-trip', back.root.values.get('slot') === 1, `slot=${back.root.values.get('slot')}`);
    check(
      'payload survives round-trip',
      change.values.get('module') === 5 &&
        change.values.get('parameter') === 2 &&
        change.values.get('value') === 100,
      `module=${change.values.get('module')} param=${change.values.get('parameter')} value=${change.values.get('value')}`,
    );
  } catch (error) {
    check('round-trip', false, (error as Error).message);
  }
}

// 3. A corrupt checksum must be rejected.
process.stdout.write('\nCorrupted checksum must be rejected\n');
{
  const bytes = encoder.encode({
    cc: 0x13,
    slot: 0,
    data: { pid: 0, sc: 0x40, data: { section: 0, module: 1, parameter: 0, value: 64 } },
  });
  const corrupted = Uint8Array.from(bytes);
  corrupted[corrupted.length - 2] ^= 0x01;
  let rejected = false;
  try {
    decoder.decode(corrupted, { validateComputed: true });
  } catch {
    rejected = true;
  }
  check('flipped checksum bit is caught', rejected, '');
}

process.stdout.write(`\n${pass} ok, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
