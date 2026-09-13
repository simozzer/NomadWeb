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

process.stdout.write('\nIAm request (host -> device), sender=0\n');
{
  const bytes = encoder.encode({
    cc: 0x00, slot: 0,
    data: { sender: 0, versionHigh: 0, versionLow: 0 },
  });
  process.stdout.write(`  ${hex(bytes)}\n`);
  check('8 bytes', bytes.length === 8, `${bytes.length}`);

  const back = decoder.decode(bytes, { validateComputed: true });
  check('round-trips', back.messageId === 'iam', `messageId=${back.messageId}`);
  check('consumes the whole message', back.bitsConsumed === bytes.length * 8,
    `${back.bitsConsumed / 8}/${bytes.length} bytes`);
}

process.stdout.write('\nIAm reply (device -> host), sender=1 with identification\n');
{
  // serial = ((serial1 & 0x7f) << 7) | (serial2 & 0x7f)
  const bytes = encoder.encode({
    cc: 0x00, slot: 0,
    data: {
      sender: 1, versionHigh: 3, versionLow: 3,
      identification: { reserved: 0, serial1: 0x0a, serial2: 0x2b, deviceId: 0x02 },
    },
  });
  process.stdout.write(`  ${hex(bytes)}\n`);

  const back = decoder.decode(bytes, { validateComputed: true });
  check('decodes', back.messageId === 'iam', `messageId=${back.messageId}`);
  check('consumes the whole message', back.bitsConsumed === bytes.length * 8,
    `${back.bitsConsumed / 8}/${bytes.length} bytes`);

  const data = back.root.items.get('data') as any;
  check('data node present', !!data, '');
  const ident = data?.items.get('identification');
  check('identification node present', !!ident,
    ident ? '' : `items: [${data ? Array.from(data.items.keys()).join(', ') : ''}]`);

  if (ident) {
    const serial = ((ident.values.get('serial1') & 0x7f) << 7) | (ident.values.get('serial2') & 0x7f);
    check('deviceId', ident.values.get('deviceId') === 0x02, `${ident.values.get('deviceId')}`);
    check('serial', serial === 1323, `${serial}`);
    check('version', data.values.get('versionHigh') === 3 && data.values.get('versionLow') === 3,
      `${data.values.get('versionHigh')}.${data.values.get('versionLow')}`);
  }
}

process.stdout.write(`\n${pass} ok, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
