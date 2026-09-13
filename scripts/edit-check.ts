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
function check(label: string, ok: boolean, detail = '') {
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}\n`);
  ok ? pass++ : fail++;
}

const modify = (slot: number, sc: number, payload: Record<string, number>) =>
  encoder.encode({ cc: 0x17, slot, data: { data: { pid: 0, sc, data: payload } } });

function assertValidChecksum(bytes: Uint8Array, label: string) {
  const sum = Array.from(bytes.subarray(0, bytes.length - 2)).reduce((a, b) => a + b, 0);
  check(`${label}: checksum`, bytes[bytes.length - 2] === sum % 128, '');
  decoder.decode(bytes, { validateComputed: true });
}

process.stdout.write('\nModuleMove (sc 0x34)\n');
{
  const bytes = modify(0, 0x34, { section: 0, module: 7, xpos: 2, ypos: 13 });
  process.stdout.write(`  ${hex(bytes)}\n`);
  check('sc byte', bytes[5] === 0x34, `0x${bytes[5].toString(16)}`);
  check('module, xpos, ypos',
    bytes[7] === 7 && bytes[8] === 2 && bytes[9] === 13, hex(bytes.subarray(7, 10)));
  assertValidChecksum(bytes, 'move');
}

process.stdout.write('\nCableInsert (sc 0x50)\n');
{
  // CableInsert := 0:1 1:3 section:1 color:3 ...
  // so its first payload byte is 0_001_s_ccc.
  const bytes = modify(0, 0x50, {
    section: 1, color: 2,
    module1: 3, type1: 1, connector1: 5,
    module2: 9, type2: 0, connector2: 1,
  });
  process.stdout.write(`  ${hex(bytes)}\n`);
  check('sc byte', bytes[5] === 0x50, `0x${bytes[5].toString(16)}`);
  check('flags byte packs 0:1 1:3 section:1 color:3',
    bytes[6] === 0b0_001_1_010, `0b${bytes[6].toString(2).padStart(8, '0')}`);
  // Each endpoint is 0:1 module:7 then 0:1 type:1 connector:6.
  check('source endpoint', bytes[7] === 3 && bytes[8] === ((1 << 6) | 5),
    hex(bytes.subarray(7, 9)));
  check('dest endpoint', bytes[9] === 9 && bytes[10] === ((0 << 6) | 1),
    hex(bytes.subarray(9, 11)));
  assertValidChecksum(bytes, 'insert');
}

process.stdout.write('\nCableDelete (sc 0x51)\n');
{
  // CableDelete := 0:1 1:6 section:1 ... so the flags byte is 0_000001_s.
  const bytes = modify(2, 0x51, {
    section: 0,
    module1: 4, type1: 1, connector1: 0,
    module2: 6, type2: 0, connector2: 3,
  });
  process.stdout.write(`  ${hex(bytes)}\n`);
  check('sc byte', bytes[5] === 0x51, `0x${bytes[5].toString(16)}`);
  check('flags byte packs 0:1 1:6 section:1',
    bytes[6] === 0b0_000001_0, `0b${bytes[6].toString(2).padStart(8, '0')}`);
  check('slot rides in the command byte', ((bytes[2] >> 0) & 0x03) === 2,
    `0x${bytes[2].toString(16)}`);
  assertValidChecksum(bytes, 'delete');
}

process.stdout.write('\nModuleDeletion (sc 0x32)\n');
{
  const bytes = modify(0, 0x32, { section: 0, module: 11 });
  process.stdout.write(`  ${hex(bytes)}\n`);
  check('sc byte', bytes[5] === 0x32, `0x${bytes[5].toString(16)}`);
  check('module index', bytes[7] === 11, `${bytes[7]}`);
  assertValidChecksum(bytes, 'delete module');
}

process.stdout.write('\nAll four re-decode cleanly\n');
{
  const all = [
    modify(0, 0x34, { section: 0, module: 1, xpos: 0, ypos: 0 }),
    modify(1, 0x50, {
      section: 0, color: 0,
      module1: 1, type1: 1, connector1: 0, module2: 2, type2: 0, connector2: 0,
    }),
    modify(2, 0x51, {
      section: 1,
      module1: 1, type1: 1, connector1: 0, module2: 2, type2: 0, connector2: 0,
    }),
    modify(3, 0x32, { section: 1, module: 5 }),
  ];
  let ok = true;
  for (const bytes of all) {
    const back = decoder.decode(bytes, { validateComputed: true });
    if (back.bitsConsumed !== bytes.length * 8) ok = false;
  }
  check('every message consumed in full', ok, '');
}

process.stdout.write(`\n${pass} ok, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
