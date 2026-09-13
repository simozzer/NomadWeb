import { readFileSync } from 'node:fs';
import { parsePdl2 } from '../src/pdl2/parser.ts';
import { Pdl2Decoder, decodedString, type Decoded } from '../src/pdl2/interpreter.ts';

const grammar = parsePdl2(
  readFileSync(new URL('../public/data/midi.pdl2', import.meta.url), 'utf8'),
);
const decoder = new Pdl2Decoder(grammar);

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.trim().split(/\s+/).map((h) => parseInt(h, 16)));
}

/** Capture recordings taken from the comments in midi.pdl2 itself. */
const VECTORS: Array<{ name: string; hex: string; expect?: string }> = [
  {
    name: 'ACK / UnknownACKReply (reply to LoadPatch of an empty slot)',
    hex: 'F0 33 58 06 08 0D 08 21 00 01 40 F7',
  },
  {
    name: 'NMInfo / UnknownNMInfo (patch name report)',
    hex: 'F0 33 50 06 04 13 51 06 16 00 03 02 56 45 6C 70 69 61 6E 6F 20 36 00 05 7B F7',
    expect: 'VElpiano 6',
  },
  {
    name: 'Meters (marked "parse failed" upstream)',
    hex: 'F0 33 50 06 07 3A 00 07 00 00 00 00 00 00 00 00 00 41 F7',
  },
  {
    name: 'Meters, nested (marked "parse failed" upstream)',
    hex: 'F0 33 50 06 20 3A 00 07 00 F0 33 50 06 20 39 00 11 00 00 00 00 00 00 63 F7',
  },
];

function findString(node: Decoded): string | null {
  const direct = decodedString(node, 'chars');
  if (direct) return direct;
  for (const child of node.items.values()) {
    const list = Array.isArray(child) ? child : [child];
    for (const c of list) {
      if (c.rule === 'scalar') continue;
      const found = findString(c);
      if (found) return found;
    }
  }
  return null;
}

let pass = 0;
let fail = 0;

for (const vector of VECTORS) {
  const raw = bytes(vector.hex);
  process.stdout.write(`\n${vector.name}\n  ${raw.length} bytes\n`);
  try {
    const result = decoder.decode(raw, { validateComputed: true });
    const trailing = (raw.length * 8 - result.bitsConsumed) / 8;
    const cc = result.root.values.get('cc');
    const slot = result.root.values.get('slot');
    process.stdout.write(
      `  messageId = ${result.messageId}\n` +
        `  cc = 0x${cc?.toString(16)}  slot = ${slot}\n` +
        `  consumed  = ${result.bitsConsumed / 8} bytes (${trailing} trailing)\n`,
    );
    const name = findString(result.root);
    if (name !== null) process.stdout.write(`  string    = ${JSON.stringify(name)}\n`);
    if (vector.expect !== undefined) {
      const ok = name === vector.expect;
      process.stdout.write(
        `  expected  = ${JSON.stringify(vector.expect)} -> ${ok ? 'MATCH' : 'MISMATCH'}\n`,
      );
      ok ? pass++ : fail++;
    } else {
      pass++;
    }
  } catch (error) {
    process.stdout.write(`  DECODE FAILED: ${(error as Error).message}\n`);
    fail++;
  }
}

process.stdout.write(`\n${pass} ok, ${fail} failed\n`);
