import { readFileSync } from 'node:fs';
import { parsePdl2 } from '../src/pdl2/parser.ts';
import { Pdl2Decoder } from '../src/pdl2/interpreter.ts';
import { NordModular } from '../src/midi/nord.ts';

const source = readFileSync(new URL('../public/data/midi.pdl2', import.meta.url), 'utf8');
const decoder = new Pdl2Decoder(parsePdl2(source));

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = '') {
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}\n`);
  ok ? pass++ : fail++;
}

class FakeTransport {
  sent: Uint8Array[] = [];
  addListener() { return () => {}; }
  send(m: Uint8Array) { this.sent.push(m); }
}

const transport = new FakeTransport();
const nord = new NordModular(transport as never, source);

process.stdout.write('\nPatch part requests\n');
{
  const started = Date.now();
  const sent = await nord.requestPatchParts(0, 42, { gapMs: 5 });
  const elapsed = Date.now() - started;

  check('thirteen parts sent', sent === 13, `${sent}`);
  check('sent one at a time, not in a burst', elapsed >= 13 * 5, `${elapsed}ms`);

  // Expected (sc, payload) pairs, read off the disassembled tableswitch.
  const expected: Array<[number, number | null]> = [
    [0x20, 0x28], [0x4b, 1], [0x4b, 0], [0x53, 1], [0x53, 0],
    [0x4c, 1], [0x4c, 0], [0x66, null], [0x63, null], [0x61, null],
    [0x4e, 1], [0x4e, 0], [0x68, null],
  ];

  let wrong = 0;
  transport.sent.forEach((message, i) => {
    const [sc, payload] = expected[i];
    if (message[5] !== sc) wrong++;
    else if (payload !== null && message[6] !== payload) wrong++;
  });
  check('every sub-command and payload matches the disassembly', wrong === 0,
    `${wrong} wrong`);

  // HEADER is the one that was wrong before: payload 0x28, not 0.
  check('HEADER payload is 0x28', transport.sent[0][6] === 0x28,
    `0x${transport.sent[0][6].toString(16)}`);

  let bad = 0;
  for (const message of transport.sent) {
    try { decoder.decode(message, { validateComputed: true }); } catch { bad++; }
  }
  check('all thirteen are well-formed with valid checksums', bad === 0, `${bad} bad`);

  // None may collide with a destructive command in the same switch.
  const destructive = new Set([0x32, 0x51, 0x27, 0x33, 0x54]);
  check('no part collides with a destructive sub-command',
    transport.sent.every((m) => !destructive.has(m[5])), '');
}

process.stdout.write(`\n${pass} ok, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
