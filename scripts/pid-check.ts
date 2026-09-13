import { readFileSync } from 'node:fs';
import { parsePdl2 } from '../src/pdl2/parser.ts';
import { Pdl2Encoder } from '../src/pdl2/interpreter.ts';
import { NordModular } from '../src/midi/nord.ts';

const source = readFileSync(new URL('../public/data/midi.pdl2', import.meta.url), 'utf8');
const encoder = new Pdl2Encoder(parsePdl2(source));

const hex = (b: Uint8Array) =>
  Array.from(b).map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = '') {
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}\n`);
  ok ? pass++ : fail++;
}

/** A transport stub that records what was sent and can inject replies. */
class FakeTransport {
  sent: Uint8Array[] = [];
  private listeners = new Set<(m: Uint8Array) => void>();

  addListener(fn: (m: Uint8Array) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  send(message: Uint8Array) { this.sent.push(message); }
  receive(message: Uint8Array) { for (const fn of this.listeners) fn(message); }
}

const transport = new FakeTransport();
const nord = new NordModular(transport as never, source);
nord.start();

process.stdout.write('\nActive patch id tracking\n');
{
  check('starts at zero for every slot',
    [0, 1, 2, 3].every((s) => nord.getActivePid(s) === 0), '');

  // An ACK on slot 1 carrying pid1 = 42. Type 0x36 has no payload.
  const ack = encoder.encode({
    cc: 0x16, slot: 1,
    data: { pid1: 42, type: 0x36, pid2: 0 },
  });
  process.stdout.write(`  ack: ${hex(ack)}\n`);
  transport.receive(ack);

  check('ACK pid1 is adopted for its slot', nord.getActivePid(1) === 42,
    `slot1=${nord.getActivePid(1)}`);
  check('other slots are untouched',
    nord.getActivePid(0) === 0 && nord.getActivePid(2) === 0, '');

  // NMInfo (lights) on slot 2 carries the pid as `pid`.
  const lights = encoder.encode({
    cc: 0x14, slot: 2,
    data: {
      pid: 7, sc: 0x39,
      data: {
        startIndex: 0,
        l0: 0, l1: 0, l2: 0, l3: 0, l4: 0, l5: 0, l6: 0, l7: 0, l8: 0, l9: 0,
        l10: 0, l11: 0, l12: 0, l13: 0, l14: 0, l15: 0, l16: 0, l17: 0, l18: 0, l19: 0,
      },
    },
  });
  transport.receive(lights);
  check('a lights message also updates the pid', nord.getActivePid(2) === 7,
    `slot2=${nord.getActivePid(2)}`);
}

process.stdout.write('\nOutgoing messages quote the active pid\n');
{
  transport.sent.length = 0;

  // Slot 1 is at pid 42 from the ACK above.
  const move = nord.moveModule(1, 0, 3, 1, 2);
  process.stdout.write(`  move: ${hex(move)}\n`);
  check('module move carries pid 42', move[4] === 42, `pid byte = ${move[4]}`);

  const param = nord.setParameter(1, 0, 3, 0, 64);
  process.stdout.write(`  param: ${hex(param)}\n`);
  check('parameter change carries pid 42', param[4] === 42, `pid byte = ${param[4]}`);

  const cable = nord.addCable(1, 0, 0,
    { module: 1, connector: 0, isOutput: 1 },
    { module: 2, connector: 0, isOutput: 0 });
  check('cable insert carries pid 42', cable[4] === 42, `pid byte = ${cable[4]}`);

  // A slot with no pid reported still sends a well-formed message.
  const other = nord.moveModule(3, 0, 1, 0, 0);
  check('an unknown slot falls back to pid 0', other[4] === 0, `pid byte = ${other[4]}`);
}

process.stdout.write('\nwaitForFreshPid\n');
{
  const waiting = nord.waitForFreshPid(0, 500);
  const ack = encoder.encode({
    cc: 0x16, slot: 0,
    data: { pid1: 99, type: 0x36, pid2: 0 },
  });
  setTimeout(() => transport.receive(ack), 10);
  const resolved = await waiting;
  check('resolves with the announced pid', resolved === 99, `${resolved}`);
}

process.stdout.write(`\n${pass} ok, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
