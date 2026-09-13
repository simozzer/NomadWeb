import { readFileSync } from 'node:fs';
import { parsePdl2 } from '../src/pdl2/parser.ts';
import { Pdl2Decoder, decodedString, type Decoded } from '../src/pdl2/interpreter.ts';
import { SysexFramer } from '../src/midi/framing.ts';

const grammar = parsePdl2(
  readFileSync(new URL('../public/data/midi.pdl2', import.meta.url), 'utf8'),
);
const decoder = new Pdl2Decoder(grammar);

const bytes = (hex: string) =>
  Uint8Array.from(hex.trim().split(/\s+/).map((h) => parseInt(h, 16)));

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = '') {
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}\n`);
  ok ? pass++ : fail++;
}

function findString(node: Decoded): string | null {
  const direct = decodedString(node, 'chars');
  if (direct) return direct;
  for (const child of node.items.values()) {
    for (const c of Array.isArray(child) ? child : [child]) {
      if (c.rule === 'scalar') continue;
      const found = findString(c);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Captures recorded in the comments of midi.pdl2, decoded with checksum
 * validation on. The checksums are the real assertion: a wrong bit offset
 * anywhere in the message would fail them.
 */

process.stdout.write('\nACK / UnknownACKReply\n');
{
  const result = decoder.decode(
    bytes('F0 33 58 06 08 0D 08 21 00 01 40 F7'),
    { validateComputed: true },
  );
  check('messageId', result.messageId === 'ack', result.messageId);
  check('cc = 0x16 (ACK), slot 0',
    result.root.values.get('cc') === 0x16 && result.root.values.get('slot') === 0, '');
  check('whole message consumed', result.bitsConsumed === 12 * 8, `${result.bitsConsumed / 8}/12 bytes`);
}

process.stdout.write('\nNMInfo / UnknownNMInfo (patch name report)\n');
{
  const result = decoder.decode(
    bytes('F0 33 50 06 04 13 51 06 16 00 03 02 56 45 6C 70 69 61 6E 6F 20 36 00 05 7B F7'),
    { validateComputed: true },
  );
  check('messageId', result.messageId === 'unknownNMInfo', result.messageId);
  check('whole message consumed', result.bitsConsumed === 26 * 8, `${result.bitsConsumed / 8}/26 bytes`);
  // The grammar declares seven leading fields but the capture has six before
  // the text, so `unknown7` eats the leading "V". See NOTES-protocol.md; the
  // direction of the off-by-one cannot be settled without hardware.
  check('name decodes per the grammar as written',
    findString(result.root) === 'Elpiano 6',
    `${JSON.stringify(findString(result.root))} (capture comment says "VElpiano 6")`);
}

process.stdout.write('\nMeters — marked "parse failed" upstream, parses here\n');
{
  const result = decoder.decode(
    bytes('F0 33 50 06 07 3A 00 07 00 00 00 00 00 00 00 00 00 41 F7'),
    { validateComputed: true },
  );
  check('messageId', result.messageId === 'meters', result.messageId);
  check('whole message consumed', result.bitsConsumed === 19 * 8, `${result.bitsConsumed / 8}/19 bytes`);
}

process.stdout.write('\nInterleaved capture — two messages spliced together\n');
{
  // The second upstream "parse failed" sample is a Meters message with a Lights
  // message spliced into it and no terminating F7 for the first. The framer is
  // what handles this, not the decoder.
  const raw = bytes(
    'F0 33 50 06 20 3A 00 07 00 F0 33 50 06 20 39 00 11 00 00 00 00 00 00 63 F7',
  );

  let decoderRejected = false;
  try {
    decoder.decode(raw, { validateComputed: true });
  } catch {
    decoderRejected = true;
  }
  check('decoder rejects it as one message', decoderRejected, '');

  const framer = new SysexFramer();
  const framed = framer.push(raw);
  check('framer recovers the intact second message',
    framed.length === 1 && framed[0].length === 16,
    `${framed.length} message(s), dropped ${framer.stats.truncated} truncated`);

  const recovered = decoder.decode(framed[0], { validateComputed: true });
  check('recovered message decodes with a valid checksum',
    recovered.messageId === 'lights', recovered.messageId);
}

process.stdout.write(`\n${pass} ok, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
