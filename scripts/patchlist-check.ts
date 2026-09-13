import { readFileSync } from 'node:fs';
import { parsePdl2 } from '../src/pdl2/parser.ts';
import { Pdl2Decoder, Pdl2Encoder } from '../src/pdl2/interpreter.ts';
import { parsePatchList } from '../src/midi/nord.ts';

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

process.stdout.write('\nGetPatchList request (host -> device)\n');
{
  // cc 0x17 / pp 0x41 / ssc 0x14 are the constants in GetPatchListMessage.<init>.
  const bytes = encoder.encode({
    cc: 0x17,
    slot: 0,
    data: { data: { pp: 0x41, command: { ssc: 0x14, data: { section: 2, position: 7 } } } },
  });
  process.stdout.write(`  ${hex(bytes)}\n`);

  // cc=0x17, slot=0 packs as 0:1 cc:5 slot:2 = 0_10111_00 = 0x5C.
  check('command byte is 0x5C', bytes[2] === 0x5c, `0x${bytes[2].toString(16)}`);
  check('pp=0x41, ssc=0x14', bytes[4] === 0x41 && bytes[5] === 0x14, hex(bytes.subarray(4, 6)));
  check('section and position carried', bytes[6] === 2 && bytes[7] === 7, hex(bytes.subarray(6, 8)));

  const sum = Array.from(bytes.subarray(0, bytes.length - 2)).reduce((a, b) => a + b, 0);
  check('checksum correct', bytes[bytes.length - 2] === sum % 128,
    `0x${bytes[bytes.length - 2].toString(16)} vs 0x${(sum % 128).toString(16)}`);

  // The encoder must pick PatchCommand over PatchModification in the
  // `(PatchModification | PatchCommand)` alternation, using the fields present.
  const back = decoder.decode(bytes, { validateComputed: true });
  check('re-decodes with a valid checksum', back.bitsConsumed === bytes.length * 8,
    `${back.bitsConsumed / 8}/${bytes.length} bytes`);
}

process.stdout.write('\nPatchListResponse round-trip (device -> host)\n');
{
  const chars = (s: string) => ({ chars: Array.from(s, (c) => c.charCodeAt(0)) });

  // A reply whose cursor moves three ways: an explicit position, a plain
  // advance, an empty slot, then a jump to another bank.
  const message = encoder.encode({
    cc: 0x16,
    slot: 0,
    data: {
      pid1: 0, type: 0x13, pid2: 0,
      patchList: {
        unknown1: 6, unknown2: 22, unknown3: 1,
        endmarker: 0,
        data: {
          cmd: { code: 0x01, nextposition: { position: 4 } },
          name: chars('Bass Pluck'),
          next: {
            name: chars('Second One'),
            next: {
              cmd: { code: 0x02, emptyposition: {} },
              name: chars(''),
              next: {
                cmd: { code: 0x03, nextsection: { section: 5, position: 11 } },
                name: chars('Other Bank'),
              },
            },
          },
        },
      },
    },
  });

  process.stdout.write(`  ${hex(message)}\n`);

  const decoded = decoder.decode(message, { validateComputed: true });
  check('decodes with a valid checksum', decoded.messageId === 'PatchListResponse',
    `messageId=${decoded.messageId}`);

  const entries = parsePatchList(decoded.root, 2, 0);
  for (const e of entries) {
    process.stdout.write(
      `    bank ${e.bank} pos ${String(e.position).padStart(2)}  ` +
        `${e.empty ? '(empty)' : JSON.stringify(e.name)}\n`,
    );
  }

  check('four entries recovered', entries.length === 4, `${entries.length}`);
  check('explicit position honoured',
    entries[0].bank === 2 && entries[0].position === 4 && entries[0].name === 'Bass Pluck', '');
  check('cursor advances without a command',
    entries[1].position === 5 && entries[1].name === 'Second One', `pos ${entries[1].position}`);
  check('empty slot flagged and still advances the cursor',
    entries[2].empty === true && entries[2].position === 6, `pos ${entries[2].position}`);
  check('bank jump honoured',
    entries[3].bank === 5 && entries[3].position === 11 && entries[3].name === 'Other Bank',
    `bank ${entries[3].bank} pos ${entries[3].position}`);
}

process.stdout.write(`\n${pass} ok, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
