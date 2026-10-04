/**
 * Guards hardware knob assignment: the messages sent, the knob map read out of
 * a patch, and assignments the device reports on its own.
 *
 * The expected bytes follow `KnobAssignmentMessage.assign`: cc 0x17, sc 0x25
 * for a fresh assignment, sc 0x26 quoting the parameter's previous knob, with
 * the new assignment nested after it or nothing at all to clear.
 */
import { readFileSync } from 'node:fs';
import { parsePdl2 } from '../src/pdl2/parser.ts';
import { Pdl2Decoder, Pdl2Encoder, type MessageInit } from '../src/pdl2/interpreter.ts';
import { PatchReader, SECTION } from '../src/model/patch.ts';
import { NordModular, KNOB_NAMES, knobsFor } from '../src/midi/nord.ts';
import type { WebMidiTransport } from '../src/midi/webmidi.ts';

const read = (name: string) =>
  readFileSync(new URL(`../public/data/${name}`, import.meta.url), 'utf8');

const midi = parsePdl2(read('midi.pdl2'));
const decoder = new Pdl2Decoder(midi);
const encoder = new Pdl2Encoder(midi);

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

/** The payload between the sc byte and the checksum. */
const payloadOf = (b: Uint8Array) => Array.from(b.subarray(6, b.length - 2));
const consumed = (b: Uint8Array) =>
  decoder.decode(b, { validateComputed: true }).bitsConsumed === b.length * 8;

process.stdout.write('\nAssign a free parameter (sc 0x25)\n');
{
  // Knob 2 -> module 3, parameter 1, area bit 1.
  const bytes = nord.assignKnob(0, null, { knob: 1, area: 1, module: 3, parameter: 1 });
  process.stdout.write(`  ${hex(bytes)}\n`);
  check('PatchHandling, slot 0', bytes[2] === 0x17 << 2, `0x${bytes[2].toString(16)}`);
  check('sc 0x25', bytes[5] === 0x25, `0x${bytes[5].toString(16)}`);
  check('module, parameter, section:2 knob:5',
    payloadOf(bytes).join() === [3, 1, (1 << 5) | 1].join(), payloadOf(bytes).join(' '));
  check('re-decodes in full with a valid checksum', consumed(bytes));
  check('actually went out', sent.at(-1) === bytes);
}

process.stdout.write('\nMove a parameter between knobs (sc 0x26 + nested 0x25)\n');
{
  const bytes = nord.assignKnob(0, 0, { knob: 2, area: 0, module: 5, parameter: 4 });
  process.stdout.write(`  ${hex(bytes)}\n`);
  check('sc 0x26', bytes[5] === 0x26, `0x${bytes[5].toString(16)}`);
  check('prevknob, then 0x25 and the new assignment',
    payloadOf(bytes).join() === [0, 0x25, 5, 4, 2].join(), payloadOf(bytes).join(' '));
  check('re-decodes in full with a valid checksum', consumed(bytes));
}

process.stdout.write('\nClear a knob (sc 0x26 alone)\n');
{
  const bytes = nord.assignKnob(0, 2, null);
  process.stdout.write(`  ${hex(bytes)}\n`);
  check('sc 0x26 with only prevknob',
    bytes[5] === 0x26 && payloadOf(bytes).join() === '2', payloadOf(bytes).join(' '));
  check('re-decodes in full with a valid checksum', consumed(bytes));
}

process.stdout.write('\nGuards\n');
{
  const throws = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };
  check('nothing to do is refused', throws(() => nord.assignKnob(0, null, null)));
  check('knob id past 22 is refused',
    throws(() => nord.assignKnob(0, null, { knob: 23, area: 0, module: 1, parameter: 0 })));
  check('Micro Modular offers three knobs', knobsFor(0x02).join() === '0,1,2', knobsFor(2).join());
  check('keyboard/rack offer all 21', knobsFor(0x00).length === 21 && KNOB_NAMES.get(22) === 'On/Off switch',
    `${knobsFor(0).length}`);
}

process.stdout.write('\nAssignments the device reports (NMInfo)\n');
{
  const fresh = encoder.encode({
    cc: 0x14, slot: 0,
    data: { pid: 9, sc: 0x25, data: { module: 2, parameter: 0, section: 0, knob: 1 } },
  });
  const decoded = decoder.decode(fresh, { validateComputed: true });
  const body = (decoded.root.items.get('data') as any)?.items.get('data');
  check('tagged knobAssignment', decoded.messageId === 'knobAssignment', decoded.messageId);
  check('fields where the listener looks',
    body?.values.get('knob') === 1 && body?.values.get('module') === 2, '');

  const change = encoder.encode({
    cc: 0x14, slot: 0,
    data: {
      pid: 9, sc: 0x26,
      data: { prevknob: 1, data: { data: { module: 2, parameter: 0, section: 0, knob: 2 } } },
    },
  });
  const decodedChange = decoder.decode(change, { validateComputed: true });
  const changeBody = (decodedChange.root.items.get('data') as any)?.items.get('data');
  check('0x26 tagged knobAssignment too', decodedChange.messageId === 'knobAssignment',
    decodedChange.messageId);
  check('prevknob and nested assignment reachable',
    changeBody?.values.get('prevknob') === 1 &&
      changeBody?.items.get('data')?.items.get('data')?.values.get('knob') === 2, '');
}

process.stdout.write('\nMIDI controller mappings (MidiCtrlAssignmentMessage)\n');
{
  const { isAssignableController } = await import('../src/midi/nord.ts');
  const fresh = nord.assignController(0, null, { cc: 7, area: 1, module: 3, parameter: 0 });
  process.stdout.write(`  ${hex(fresh)}\n`);
  check('a new mapping: sc 0x22, section module parameter cc',
    fresh[5] === 0x22 && payloadOf(fresh).join() === '1,3,0,7', payloadOf(fresh).join(' '));
  check('re-decodes in full with a valid checksum', consumed(fresh));

  const moved = nord.assignController(0, 7, { cc: 74, area: 0, module: 2, parameter: 5 });
  check('moving it: sc 0x23 quoting the old cc, then 0x22 and the new mapping',
    moved[5] === 0x23 && payloadOf(moved).join() === '7,34,0,2,5,74', payloadOf(moved).join(' '));
  check('re-decodes in full with a valid checksum', consumed(moved));

  const cleared = nord.assignController(0, 74, null);
  check('removing it: sc 0x23 with only the cc', cleared[5] === 0x23 && payloadOf(cleared).join() === '74');
  check('re-decodes in full with a valid checksum', consumed(cleared));

  const throwsFor = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };
  check('CC 32 and 120 are refused, as Nomad refuses them',
    throwsFor(() => nord.assignController(0, null, { cc: 32, area: 1, module: 1, parameter: 0 })) &&
      throwsFor(() => nord.assignController(0, null, { cc: 120, area: 1, module: 1, parameter: 0 })) &&
      isAssignableController(0) && isAssignableController(119));
}

process.stdout.write('\nA knob turned on the device (KnobChange / ParameterChange)\n');
{
  // Both arrive with sc 0x40 and the same four fields, where the editor reads them.
  for (const [cc, label] of [[0x14, 'NMInfo KnobChange'], [0x13, 'Parameter ParameterChange']] as const) {
    const bytes = encoder.encode({
      cc, slot: 0, data: { pid: 5, sc: 0x40, data: { section: 1, module: 3, parameter: 2, value: 99 } },
    });
    const decoded = decoder.decode(bytes, { validateComputed: true });
    const info = decoded.root.items.get('data') as any;
    const body = info?.items.get('data');
    check(`${label} decodes to section, module, parameter, value`,
      decoded.root.values.get('cc') === cc && info?.values.get('sc') === 0x40 &&
        ['section', 'module', 'parameter', 'value'].map((f) => body?.values.get(f)).join() === '1,3,2,99',
      decoded.messageId ?? '(no id)');
  }
}

process.stdout.write('\nA patch chosen on the device (NewPatchInSlot)\n');
{
  const bytes = encoder.encode({
    cc: 0x14, slot: 0, data: { pid: 12, sc: 0x38, data: { slot: 0, pid: 12 } },
  });
  const decoded = decoder.decode(bytes, { validateComputed: true });
  const info = decoded.root.items.get('data') as any;
  check('tagged newPatchInSlot, with the slot and pid where the editor reads them',
    decoded.messageId === 'newPatchInSlot' && decoded.root.values.get('slot') === 0 &&
      info?.values.get('pid') === 12, decoded.messageId);
}

process.stdout.write('\nKnob map in a patch (KnobMapDump)\n');
{
  const patchEncoder = new Pdl2Encoder(parsePdl2(read('patch.pdl2')));
  const knobs: Record<string, MessageInit> = {};
  for (let i = 0; i <= 22; i++) knobs[`knob${i}`] = { assigned: 0 };
  // Section 1 is the voice area, 0 the common area.
  knobs.knob0 = { assigned: 1, assignment: [{ section: 1, module: 4, parameter: 2 }] };
  knobs.knob2 = { assigned: 1, assignment: [{ section: 0, module: 1, parameter: 7 }] };
  // A morph-group assignment (section 2) is not a module parameter.
  knobs.knob19 = { assigned: 1, assignment: [{ section: 2, module: 0, parameter: 1 }] };

  const bitstream = patchEncoder.encode({
    section: { type: SECTION.KnobMapDump, data: knobs },
  });
  const patch = new PatchReader(read('patch.pdl2')).read(bitstream);
  const show = [...patch.knobs].map(([k, t]) => `${k}:${t.area}#${t.module}.${t.parameter}`);
  process.stdout.write(`  ${show.join('  ')}\n`);
  check('two module assignments read', patch.knobs.size === 2, `${patch.knobs.size}`);
  check('knob 1 -> voice module 4 parameter 2',
    patch.knobs.get(0)?.module === 4 && patch.knobs.get(0)?.parameter === 2 &&
      patch.knobs.get(0)?.area === 'voice', '');
  check('knob 3 -> common area, module 1 parameter 7',
    patch.knobs.get(2)?.area === 'common' && patch.knobs.get(2)?.parameter === 7, '');
  check('section 2 skipped', !patch.knobs.has(19));
}

process.stdout.write(`\n${pass} ok, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
