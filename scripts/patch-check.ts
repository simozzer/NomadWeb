import { readFileSync } from 'node:fs';
import { parsePdl2 } from '../src/pdl2/parser.ts';
import { Pdl2Decoder, Pdl2Encoder } from '../src/pdl2/interpreter.ts';
import { PatchReader, SECTION } from '../src/model/patch.ts';
import { unpack7Bit, patchPacketOverrides, commandCodeOf } from '../src/midi/nord.ts';

const read = (name: string) =>
  readFileSync(new URL(`../public/data/${name}`, import.meta.url), 'utf8');

const midi = parsePdl2(read('midi.pdl2'));
const midiEncoder = new Pdl2Encoder(midi);
const midiDecoder = new Pdl2Decoder(midi);

const patchGrammar = parsePdl2(read('patch.pdl2'));
const patchEncoder = new Pdl2Encoder(patchGrammar);
const patchReader = new PatchReader(read('patch.pdl2'));

const hex = (b: Uint8Array) =>
  Array.from(b).map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = '') {
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}\n`);
  ok ? pass++ : fail++;
}

process.stdout.write('\nLoadPatch / RequestPatch requests\n');
{
  // LoadPatchMessage's own parameter paths are data:data:command:data:slot etc.
  const load = midiEncoder.encode({
    cc: 0x17, slot: 1,
    data: { data: { pp: 0x41, command: { ssc: 0x0a, data: { slot: 1, section: 3, position: 12 } } } },
  });
  process.stdout.write(`  load    ${hex(load)}\n`);
  check('load: pp=0x41, ssc=0x0a', load[4] === 0x41 && load[5] === 0x0a, hex(load.subarray(4, 6)));
  check('load: slot, bank, position', load[6] === 1 && load[7] === 3 && load[8] === 12,
    hex(load.subarray(6, 9)));
  check('load: cc=0x17 slot=1 packs to 0x5D', load[2] === 0x5d, `0x${load[2].toString(16)}`);
  midiDecoder.decode(load, { validateComputed: true });
  check('load: checksum valid on re-decode', true);

  const request = midiEncoder.encode({
    cc: 0x17, slot: 2,
    data: { data: { pp: 0x41, command: { ssc: 0x35, data: {} } } },
  });
  process.stdout.write(`  request ${hex(request)}\n`);
  check('request: ssc=0x35', request[5] === 0x35, `0x${request[5].toString(16)}`);
  midiDecoder.decode(request, { validateComputed: true });
  check('request: checksum valid on re-decode', true);
}

process.stdout.write('\n7-bit payload unpacking\n');
{
  // Eight 7-bit groups pack into exactly seven bytes.
  const packed = Uint8Array.from([0x7f, 0x00, 0x7f, 0x00, 0x7f, 0x00, 0x7f, 0x00]);
  const out = unpack7Bit(packed);
  check('8 payload bytes -> 7 stream bytes', out.length === 7, `${out.length}`);
  check('bits land MSB-first', out[0] === 0xfe, `0x${out[0].toString(16)}`);

  const single = unpack7Bit(Uint8Array.from([0b1010101]));
  check('single group is left-aligned', single[0] === 0b10101010, `0b${single[0].toString(2)}`);
}

process.stdout.write('\nPatchPacket HACK length override\n');
{
  // cc 0x1d = first packet of a run (low bit set, bit 1 clear).
  // PatchPacketExtra is referenced inline (`$$`), so PatchPacket sits directly
  // under `data`. The encoder needs the same HACK override as the decoder,
  // otherwise the grammar's own `%HACK:16 = (0)` writes an empty payload.
  const payload = [1, 2, 3, 4, 5, 6, 7, 8];
  const packet = midiEncoder.encode(
    {
      cc: 0x1d, slot: 0,
      data: { command: 0, pid: 5, embedded_stream: payload },
    },
    { overrides: { HACK: payload.length } },
  );
  process.stdout.write(`  ${hex(packet)}\n`);

  const overrides = patchPacketOverrides(packet);
  check('override computed for a patch packet', overrides?.HACK === payload.length,
    `HACK=${overrides?.HACK}, payload=${payload.length}`);
  check('command code recovered', commandCodeOf(packet) === 0x1d,
    `0x${commandCodeOf(packet).toString(16)}`);

  const decoded = midiDecoder.decode(packet, { validateComputed: true, overrides });
  check('decodes fully with the override', decoded.bitsConsumed === packet.length * 8,
    `${decoded.bitsConsumed / 8}/${packet.length} bytes`);

  // first/last are implicit fields merged into the root by the inline reference.
  const flags = decoded.root.values;
  check('first/last flags derived from cc', flags.get('first') === 1 && flags.get('last') === 0,
    `first=${flags.get('first')} last=${flags.get('last')}`);

  // Without the override the grammar reads a zero-length payload and the
  // checksum lands on the wrong byte.
  let rejected = false;
  try {
    midiDecoder.decode(packet, { validateComputed: true });
  } catch {
    rejected = true;
  }
  check('without the override the packet does not parse', rejected, '');
}

process.stdout.write('\nPatch bitstream round-trip\n');
{
  const chars = (s: string) => ({ chars: Array.from(s, (c) => c.charCodeAt(0)) });

  // A minimal but realistic patch: name, two modules, one cable between them.
  const bitstream = patchEncoder.encode({
    section: { type: SECTION.PatchName, data: { name: chars('Test Patch') } },
    next: {
      section: {
        type: SECTION.ModuleDump,
        data: {
          section: 0, nmodules: 2,
          modules: [
            { type: 20, index: 1, xpos: 0, ypos: 0 },
            { type: 4, index: 2, xpos: 0, ypos: 5 },
          ],
        },
      },
      next: {
        section: {
          type: SECTION.CableDump,
          data: {
            section: 0, ncables: 1,
            cables: [{
              color: 1, source: 1, inputOutput: 5, type: 1, destination: 2, input: 0,
            }],
          },
        },
        next: {
          section: {
            type: SECTION.NameDump,
            data: {
              section: 0, nmodules: 1,
              moduleNames: [{ index: 1, name: chars('My Env') }],
            },
          },
        },
      },
    },
  });

  process.stdout.write(`  ${bitstream.length} bytes: ${hex(bitstream.subarray(0, 24))}...\n`);

  const patch = patchReader.read(bitstream);
  process.stdout.write(`  name=${JSON.stringify(patch.name)} ` +
    `modules=${patch.modules.length} cables=${patch.cables.length}\n`);
  for (const m of patch.modules) {
    process.stdout.write(
      `    ${m.area} #${m.index} type ${m.type} at (${m.x},${m.y})` +
        `${m.name ? ` "${m.name}"` : ''}\n`,
    );
  }

  check('patch name', patch.name === 'Test Patch', JSON.stringify(patch.name));
  check('two modules', patch.modules.length === 2, `${patch.modules.length}`);
  check('module type and instance index',
    patch.modules[0].type === 20 && patch.modules[0].index === 1, '');
  check('module position', patch.modules[1].y === 5, `y=${patch.modules[1].y}`);
  check('one cable', patch.cables.length === 1, `${patch.cables.length}`);
  check('cable endpoints',
    patch.cables[0].sourceModule === 1 && patch.cables[0].destModule === 2,
    `${patch.cables[0].sourceModule} -> ${patch.cables[0].destModule}`);
  check('module name applied from NameDump', patch.modules[0].name === 'My Env',
    JSON.stringify(patch.modules[0].name));
}

process.stdout.write('\nParts parsed separately (not concatenated)\n');
{
  const chars = (s: string) => ({ chars: Array.from(s, (c) => c.charCodeAt(0)) });

  // Each part arrives as its own bitstream, exactly as the device sends them.
  const namePart = patchEncoder.encode({
    section: { type: SECTION.PatchName, data: { name: chars('Split Patch') } },
  });
  const modulePart = patchEncoder.encode({
    section: {
      type: SECTION.ModuleDump,
      data: {
        section: 0, nmodules: 2,
        modules: [
          { type: 20, index: 1, xpos: 0, ypos: 0 },
          { type: 4, index: 2, xpos: 1, ypos: 3 },
        ],
      },
    },
  });
  const commonPart = patchEncoder.encode({
    section: {
      type: SECTION.ModuleDump,
      data: {
        section: 1, nmodules: 1,
        modules: [{ type: 7, index: 1, xpos: 0, ypos: 0 }],
      },
    },
  });
  const cablePart = patchEncoder.encode({
    section: {
      type: SECTION.CableDump,
      data: {
        section: 0, ncables: 1,
        cables: [{ color: 1, source: 1, inputOutput: 5, type: 1, destination: 2, input: 0 }],
      },
    },
  });

  const parts = [namePart, modulePart, commonPart, cablePart];
  process.stdout.write(`  part sizes: ${parts.map((p) => p.length).join(', ')} bytes\n`);

  const patch = patchReader.readParts(parts);
  check('name from its own part', patch.name === 'Split Patch', JSON.stringify(patch.name));
  check('modules merged across parts', patch.modules.length === 3, `${patch.modules.length}`);
  check('voice and common areas both present',
    patch.modules.filter((m) => m.area === 'voice').length === 2 &&
      patch.modules.filter((m) => m.area === 'common').length === 1, '');
  check('cable from its own part', patch.cables.length === 1, `${patch.cables.length}`);

  // An unreadable part must not lose the others.
  const withJunk = [...parts, Uint8Array.from([0xff, 0xff, 0xff])];
  const survived = patchReader.readParts(withJunk);
  check('an unreadable part is skipped, the rest survive',
    survived.modules.length === 3, `${survived.modules.length} modules`);

  let threw = false;
  try { patchReader.readParts([Uint8Array.from([0xff, 0xff])]); } catch { threw = true; }
  check('all-unreadable is an error, not a silent empty patch', threw, '');
}

process.stdout.write(`\n${pass} ok, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
