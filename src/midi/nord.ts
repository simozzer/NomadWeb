import { parsePdl2 } from '../pdl2/parser.ts';
import {
  Pdl2Decoder,
  Pdl2Encoder,
  type Decoded,
  type DecodeResult,
  type MessageInit,
} from '../pdl2/interpreter.ts';
import type { WebMidiTransport } from './webmidi.ts';
import { formatSysex } from './framing.ts';

/** Command codes from the `switch (cc)` table in midi.pdl2. */
export const CC = {
  IAm: 0x00,
  Parameter: 0x13,
  NMInfo: 0x14,
  ACK: 0x16,
  PatchHandling: 0x17,
  /** 0x1c-0x1f are patch payload packets; the low two bits are first/last flags. */
  PatchPacketBase: 0x1c,
} as const;

export const DEVICE_NAMES: Record<number, string> = {
  0x00: 'Nord Modular Keyboard',
  0x01: 'Nord Modular Rack',
  0x02: 'Micro Modular',
};

/**
 * Knob ids as the protocol numbers them, with `Knob.getDefaultName`'s names.
 *
 * `KnobSet` builds 0-17 as knobs 1-18, then 19, 20 and 22; 18 and 21 are
 * never used.
 */
export const KNOB_NAMES: ReadonlyMap<number, string> = new Map([
  ...Array.from({ length: 18 }, (_, i) => [i, `Knob ${i + 1}`] as [number, string]),
  [19, 'Pedal'],
  [20, 'After touch'],
  [22, 'On/Off switch'],
]);

/**
 * Knobs a model physically has.
 *
 * The Micro Modular's three front-panel knobs are taken to be knobs 1-3. That
 * is not confirmed on hardware: Nomad itself makes no distinction between
 * models here.
 */
export function knobsFor(deviceId: number | undefined): number[] {
  return deviceId === 0x02 ? [0, 1, 2] : [...KNOB_NAMES.keys()];
}

export interface DeviceIdentity {
  deviceId: number;
  deviceName: string;
  /** Last four digits of the unit's serial number. */
  serial: number;
  version: string;
  /** How many patch slots this model has. */
  slotCount: number;
}

/**
 * Slots available on a model.
 *
 * From `NordModular.getMaxSlotCount`: the Micro Modular (device id 2) has a
 * single slot; the keyboard and rack have four.
 */
export function slotCountFor(deviceId: number): number {
  return deviceId === 0x02 ? 1 : 4;
}

/** Banks and positions the device accepts, per GetPatchListMessage's own bounds. */
export const MAX_BANKS = 9;
export const MAX_POSITION = 99;
/** A bank holds 99 patches, positions 0-98 (shown as 01-99). */
export const STORE_POSITIONS = 99;

/** Longest patch name the device keeps (SetPatchTitleMessage truncates at 16). */
export const PATCH_NAME_LENGTH = 16;

/**
 * Why a patch name cannot be sent, or null if it can.
 *
 * `NmCharacter.isValid` allows letters, digits, space and the printable
 * punctuation from `!` to `}` — every printable ASCII character but `~`.
 */
export function patchNameProblem(name: string): string | null {
  if (!name.trim()) return 'the name is empty';
  if (name.length > PATCH_NAME_LENGTH) return `the name is longer than ${PATCH_NAME_LENGTH} characters`;
  const bad = Array.from(name).find((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) > 0x7d);
  return bad ? `the device cannot store "${bad}" in a name` : null;
}

export interface PatchListEntry {
  bank: number;
  position: number;
  name: string;
  /** The device reported this slot as empty (ListCmd code 0x02). */
  empty: boolean;
}

/** Follows a single named child, which the grammar may or may not have produced. */
function child(node: Decoded | undefined, name: string): Decoded | undefined {
  const value = node?.items.get(name);
  return value && !Array.isArray(value) ? value : undefined;
}

function textOf(node: Decoded | undefined): string {
  const chars = node?.items.get('chars');
  if (!Array.isArray(chars)) return '';
  return chars
    .map((c) => c.values.get('value') ?? 0)
    .filter((code) => code !== 0)
    .map((code) => String.fromCharCode(code))
    .join('')
    .trim();
}

/**
 * Flattens a `PatchListResponse` into entries.
 *
 * The reply is a recursive `StringList`: each node optionally carries a
 * `ListCmd` that moves the cursor, then the patch name at that spot. Absent a
 * command the cursor simply advances by one. The command codes and the
 * traversal path (`data:patchList:data`, then `cmd`/`name`/`next`) are those
 * the original `PatchListMessage` walks.
 */
export function parsePatchList(
  root: Decoded,
  defaultBank: number,
  startPosition: number,
): PatchListEntry[] {
  const response = child(child(root, 'data'), 'patchList');
  if (!response) throw new Error('reply carries no patch list');

  const entries: PatchListEntry[] = [];
  let bank = defaultBank;
  let position = startPosition;
  let first = true;

  for (let node = child(response, 'data'); node; node = child(node, 'next')) {
    let empty = false;
    // Entries run consecutively unless a command moves the cursor; the first
    // entry sits at the position that was requested.
    let advance = !first;
    const cmd = child(node, 'cmd');

    if (cmd) {
      const code = cmd.values.get('code');
      if (code === 0x01) {
        position = child(cmd, 'nextposition')?.values.get('position') ?? position;
        advance = false;
      } else if (code === 0x02) {
        // An empty slot still occupies a position; it just holds no patch.
        empty = true;
      } else if (code === 0x03 || code === 0x05) {
        const target = child(cmd, code === 0x03 ? 'nextsection' : 'repeatedsection');
        bank = target?.values.get('section') ?? bank;
        position = target?.values.get('position') ?? position;
        advance = false;
      }
    }

    if (advance) position++;
    first = false;

    entries.push({ bank, position, name: textOf(child(node, 'name')), empty });
  }

  return entries;
}

/** Reads the 5-bit command code out of a raw frame's third byte. */
export function commandCodeOf(raw: Uint8Array): number {
  return raw.length > 2 ? (raw[2] >> 2) & 0x1f : -1;
}

/**
 * Supplies the payload length for a patch packet.
 *
 * `PatchPacket` pins its own length to zero (`%HACK:16 = (0)`) — a stop-gap the
 * upstream author left in place because their Java parser overflowed its stack
 * on long patch messages. The host is expected to provide the real count.
 *
 * The frame is `F0 33 cc 06 <command/pid> <payload...> <checksum> F7`, so the
 * payload is everything but those seven bytes.
 */
export function patchPacketOverrides(raw: Uint8Array): Record<string, number> | undefined {
  const cc = commandCodeOf(raw);
  if (cc < CC.PatchPacketBase || cc > CC.PatchPacketBase + 3) return undefined;
  return { HACK: Math.max(0, raw.length - 7) };
}

/**
 * Concatenates the 7 significant bits of each payload byte into a bitstream.
 *
 * SysEx data bytes cannot use the top bit, so the patch bitstream is carried
 * seven bits at a time. `PatchMessage.getEmbeddedStream` does the same, masking
 * with `0x7f` and appending in 7-bit groups.
 */
export function unpack7Bit(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil((payload.length * 7) / 8));
  let bitPos = 0;
  for (const byte of payload) {
    const value = byte & 0x7f;
    for (let bit = 6; bit >= 0; bit--) {
      if ((value >> bit) & 1) out[bitPos >> 3] |= 0x80 >> (bitPos & 7);
      bitPos++;
    }
  }
  return out;
}

/**
 * The inverse of `unpack7Bit`, as `NewModuleMessage.newModule` does it: pad
 * the bitstream with six zero bits, then take whole 7-bit groups, dropping
 * any shorter remainder.
 */
export function pack7Bit(bitstream: Uint8Array, bitLength = bitstream.length * 8): number[] {
  const total = bitLength + 6;
  const bit = (p: number) => (p < bitLength ? (bitstream[p >> 3] >> (7 - (p & 7))) & 1 : 0);
  const out: number[] = [];
  for (let pos = 0; pos + 7 <= total; pos += 7) {
    let value = 0;
    for (let b = 0; b < 7; b++) value = (value << 1) | bit(pos + b);
    out.push(value);
  }
  return out;
}

/**
 * Frames a patch fragment as one patch packet: cc 0x1c plus the first (1) and
 * last (2) flags, then the byte `0:1 command:1 pid:6`, the 7-bit payload and
 * the usual checksum.
 *
 * `NewModuleMessage` sends a lone packet (both flags) with command 0 and the
 * slot's patch id. A whole patch (`PatchMessage`) is one packet per section,
 * with command 1 and the section's number, from 1, in place of the id.
 */
export function patchPacket(
  slot: number,
  pid: number,
  fragment: { bytes: Uint8Array; bitLength: number },
  { first = true, last = true, command = 0 }: { first?: boolean; last?: boolean; command?: 0 | 1 } = {},
): Uint8Array {
  const cc = CC.PatchPacketBase | (first ? 1 : 0) | (last ? 2 : 0);
  const bytes = [
    0xf0, 0x33, (cc << 2) | (slot & 0x03), 0x06,
    (command << 6) | (pid & 0x3f),
    ...pack7Bit(fragment.bytes, fragment.bitLength),
  ];
  bytes.push(bytes.reduce((sum, b) => sum + b, 0) % 128, 0xf7);
  return Uint8Array.from(bytes);
}

/** The packets that carry a whole patch, as `Patch2BitstreamBuilder.createMessages` makes them. */
export function patchUploadPackets(
  slot: number,
  sections: { bytes: Uint8Array; bitLength: number }[],
): Uint8Array[] {
  return sections.map((section, i) => patchPacket(slot, i + 1, section, {
    first: i === 0, last: i === sections.length - 1, command: 1,
  }));
}

export interface PatchDumpReport {
  /** One unpacked bitstream per answered part, parsed separately. */
  parts: Uint8Array[];
  packets: number;
  payloadBytes: number;
  /** Complete packet runs seen; one per answered part. */
  runs: number;
  /** The transfer id handed back by the RequestPatch ACK. */
  patchId?: number;
  /** Whether a packet flagged as the start / end of a run was seen. */
  sawFirst: boolean;
  sawLast: boolean;
  /** Message ids that arrived instead, when the dump did not. */
  otherMessages: string[];
  /** Which request produced the result. */
  method?: string;
}


/**
 * The thirteen patch parts, in the order `GetPatchMessage.orderedParts` holds.
 *
 * Read off a real disassembly: `GetPatchMessage$1.$SwitchMap` gives each enum
 * constant's switch ordinal, and the `tableswitch` in
 * `GetPatchMessage.getBitStream` gives the bytes each case appends — a
 * sub-command, plus a payload for the parts that exist per patch area.
 *
 * Note that poly is payload 1 and common is payload 0, and that HEADER's second
 * byte is 0x28, not an area selector.
 */
const PATCH_PARTS: Array<{ name: string; sc: number; payload?: number }> = [
  { name: 'HEADER', sc: 0x20, payload: 0x28 },
  { name: 'POLY_MODULE', sc: 0x4b, payload: 1 },
  { name: 'COMMON_MODULE', sc: 0x4b, payload: 0 },
  { name: 'POLY_CABLE', sc: 0x53, payload: 1 },
  { name: 'COMMON_CABLE', sc: 0x53, payload: 0 },
  { name: 'POLY_PARAMETER', sc: 0x4c, payload: 1 },
  { name: 'COMMON_PARAMETER', sc: 0x4c, payload: 0 },
  { name: 'MORPHMAP', sc: 0x66 },
  { name: 'KNOBMAP', sc: 0x63 },
  { name: 'CONTROLMAP', sc: 0x61 },
  { name: 'POLY_NAMEDUMP', sc: 0x4e, payload: 1 },
  { name: 'COMMON_NAMEDUMP', sc: 0x4e, payload: 0 },
  { name: 'NOTE', sc: 0x68 },
];

export type MessageListener = (message: DecodeResult, raw: Uint8Array) => void;

export interface NordLogEntry {
  direction: 'in' | 'out';
  at: number;
  messageId?: string;
  hex: string;
  error?: string;
}

/**
 * The Nord Modular message layer.
 *
 * Everything the device understands is SysEx described by `midi.pdl2`, so both
 * directions run through the PDL2 engine rather than hand-written byte pushing.
 */
export class NordModular {
  private readonly decoder: Pdl2Decoder;
  private readonly encoder: Pdl2Encoder;
  private readonly transport: WebMidiTransport;
  private readonly listeners = new Set<MessageListener>();
  private unsubscribe: (() => void) | null = null;

  /** Rolling record of traffic, for the UI's monitor pane. */
  readonly log: NordLogEntry[] = [];
  logLimit = 500;

  identity: DeviceIdentity | null = null;

  /**
   * The device's current patch id for each of the four slots.
   *
   * The Nord stamps a pid on the patch in a slot and expects requests about
   * that patch to quote it; a stale pid gets acknowledged and ignored. The
   * original tracks this in `ActivePidListener`, which keeps one pid per slot
   * and updates it from incoming ACK (`pid1`) and light messages. The device
   * broadcasts it constantly, so listening is enough — there is nothing to ask.
   */
  private readonly activePids = [0, 0, 0, 0];

  getActivePid(slot: number): number {
    return this.activePids[slot] ?? 0;
  }

  /**
   * Called for a framed message the grammar could not decode.
   *
   * Worth surfacing rather than swallowing: against real hardware these are how
   * gaps in the 2008 grammar show up.
   */
  onDecodeError: ((raw: Uint8Array, error: string) => void) | null = null;

  constructor(transport: WebMidiTransport, midiGrammarSource: string) {
    const grammar = parsePdl2(midiGrammarSource);
    this.decoder = new Pdl2Decoder(grammar);
    this.encoder = new Pdl2Encoder(grammar);
    this.transport = transport;
  }

  start(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.transport.addListener((raw) => this.handleIncoming(raw));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  addListener(listener: MessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private record(entry: NordLogEntry): void {
    this.log.push(entry);
    if (this.log.length > this.logLimit) this.log.splice(0, this.log.length - this.logLimit);
  }

  private handleIncoming(raw: Uint8Array): void {
    let result: DecodeResult;
    try {
      result = this.decoder.decode(raw, {
        validateComputed: true,
        overrides: patchPacketOverrides(raw),
      });
    } catch (error) {
      // A message we cannot parse is logged and dropped rather than thrown:
      // the device emits continuous meter/light traffic and one bad frame
      // must not stall the session.
      this.record({
        direction: 'in',
        at: Date.now(),
        hex: formatSysex(raw),
        error: (error as Error).message,
      });
      this.onDecodeError?.(raw, (error as Error).message);
      return;
    }

    this.record({
      direction: 'in',
      at: Date.now(),
      messageId: result.messageId,
      hex: formatSysex(raw),
    });

    if (result.messageId === 'iam') this.captureIdentity(result.root);
    this.capturePid(result.root);
    for (const listener of this.listeners) listener(result, raw);
  }

  /**
   * Learns the active pid for a slot from whatever the device just sent.
   *
   * ACKs carry it as `pid1`; the NMInfo, Parameter and PatchHandling families
   * carry it as `pid`. Both sit directly under the top-level `data` item.
   */
  private capturePid(root: Decoded): void {
    const slot = root.values.get('slot');
    if (slot === undefined || slot < 0 || slot > 3) return;

    const data = root.items.get('data');
    if (!data || Array.isArray(data)) return;

    const pid = data.values.get('pid1') ?? data.values.get('pid');
    if (pid === undefined) return;

    if (this.activePids[slot] !== pid) {
      this.activePids[slot] = pid;
      this.onActivePidChanged?.(slot, pid);
    }
  }

  /** Fired when a slot's patch id changes, for the UI to report. */
  onActivePidChanged: ((slot: number, pid: number) => void) | null = null;

  private captureIdentity(root: Decoded): void {
    const data = root.items.get('data');
    if (!data || Array.isArray(data)) return;

    const identification = data.items.get('identification');
    if (!identification || Array.isArray(identification)) return;

    const high = data.values.get('versionHigh') ?? 0;
    const low = data.values.get('versionLow') ?? 0;
    const serial1 = identification.values.get('serial1') ?? 0;
    const serial2 = identification.values.get('serial2') ?? 0;
    const deviceId = identification.values.get('deviceId') ?? -1;

    this.identity = {
      deviceId,
      // An unrecognised id is assumed to be a keyboard, as the original does.
      deviceName: DEVICE_NAMES[deviceId] ?? 'Nord Modular (unrecognised id)',
      serial: ((serial1 & 0x7f) << 7) | (serial2 & 0x7f),
      version: `${high}.${low}`,
      slotCount: slotCountFor(deviceId),
    };
  }

  /** Builds a complete SysEx frame for the given command code and payload. */
  build(cc: number, slot: number, payload: MessageInit): Uint8Array {
    return this.encoder.encode({ cc, slot, ...payload });
  }

  send(cc: number, slot: number, payload: MessageInit): Uint8Array {
    const message = this.build(cc, slot, payload);
    this.transport.send(message);
    this.record({ direction: 'out', at: Date.now(), hex: formatSysex(message) });
    return message;
  }

  /**
   * Asks the device to identify itself and waits for its `IAm` reply.
   *
   * `sender` distinguishes the two directions of the same message: 0 is the
   * host asking, 1 is the device answering with its serial and model.
   */
  async identify(timeoutMs = 2000): Promise<DeviceIdentity> {
    const reply = this.waitFor('iam', timeoutMs);
    this.send(CC.IAm, 0, { data: { sender: 0, versionHigh: 0, versionLow: 0 } });
    await reply;

    if (!this.identity) {
      throw new Error('the device replied to IAm without an identification block');
    }
    return this.identity;
  }

  /**
   * Requests one page of the patch list, starting at a bank and position.
   *
   * Command codes are those the original `GetPatchListMessage` emits:
   * cc `0x17` (PatchHandling), pp `0x41` (PatchManagerCommand), ssc `0x14`.
   */
  requestPatchList(section: number, position: number): Uint8Array {
    if (section < 0 || section >= MAX_BANKS) {
      throw new RangeError(`invalid bank ${section} (0-${MAX_BANKS - 1})`);
    }
    if (position < 0 || position > MAX_POSITION) {
      throw new RangeError(`invalid position ${position} (0-${MAX_POSITION})`);
    }
    // Nesting follows the grammar: Sysex$data -> PatchHandling, whose
    // `(PatchModification | PatchCommand)` branch is itself named `data`.
    return this.send(CC.PatchHandling, 0, {
      data: { data: { pp: 0x41, command: { ssc: 0x14, data: { section, position } } } },
    });
  }

  /**
   * Walks every bank and returns the patches found.
   *
   * The device answers each request with a run of entries; a run ends when it
   * stops yielding new positions, at which point the next bank is requested.
   */
  async fetchPatchList(
    options: {
      /** Banks to read; defaults to all of them. */
      banks?: number[];
      onProgress?: (entries: PatchListEntry[]) => void;
      /** Polled between requests so a long scan can be interrupted. */
      shouldStop?: () => boolean;
      timeoutMs?: number;
    } = {},
  ): Promise<PatchListEntry[]> {
    const all: PatchListEntry[] = [];
    const seen = new Set<string>();
    const banks = options.banks ?? Array.from({ length: MAX_BANKS }, (_, i) => i);

    for (const bank of banks) {
      if (options.shouldStop?.()) break;
      let position = 0;
      // Each pass must advance past its last entry or the bank is done; the
      // cap is a backstop against a device that keeps repeating a page.
      for (let attempt = 0; attempt < MAX_POSITION + 2; attempt++) {
        if (options.shouldStop?.()) return all;
        const reply = this.waitFor('PatchListResponse', options.timeoutMs ?? 3000);
        // Consume the rejection unconditionally: if the send below throws, the
        // waiter would otherwise time out with nobody awaiting it.
        reply.catch(() => {});

        let entries: PatchListEntry[];
        try {
          this.requestPatchList(bank, position);
          entries = parsePatchList((await reply).root, bank, position);
        } catch {
          break; // No response for this bank: treat it as the end of the list.
        }

        const fresh = entries.filter((e) => !seen.has(`${e.bank}:${e.position}`));
        for (const entry of fresh) {
          seen.add(`${entry.bank}:${entry.position}`);
          all.push(entry);
        }
        if (fresh.length) options.onProgress?.(all);

        const last = entries.at(-1);
        if (!fresh.length || !last || last.position <= position) break;
        position = last.position + 1;
        if (position > MAX_POSITION) break;
      }
    }

    return all;
  }

  /**
   * Tells the device to load a stored patch into one of its four slots.
   *
   * Codes and nesting come from `LoadPatchMessage`, whose parameter paths are
   * literally `data:data:command:data:slot` and friends.
   */
  loadPatch(slot: number, bank: number, position: number): Uint8Array {
    if (slot < 0 || slot > 3) throw new RangeError(`invalid slot ${slot} (0-3)`);
    if (bank < 0 || bank >= MAX_BANKS) throw new RangeError(`invalid bank ${bank}`);
    if (position < 0 || position > MAX_POSITION) {
      throw new RangeError(`invalid position ${position}`);
    }
    return this.send(CC.PatchHandling, slot, {
      data: {
        data: {
          pp: 0x41,
          command: { ssc: 0x0a, data: { slot, section: bank, position } },
        },
      },
    });
  }

  /**
   * Stores the patch in a slot into a bank position, replacing what is there.
   *
   * Codes and nesting from `StorePatchMessage`: cc 0x17, pp 0x41, ssc 0x0b,
   * with `data:data:command:data:slot/section/position` — LoadPatch's shape.
   */
  storePatch(slot: number, bank: number, position: number): Uint8Array {
    if (slot < 0 || slot > 3) throw new RangeError(`invalid slot ${slot} (0-3)`);
    if (bank < 0 || bank >= MAX_BANKS) throw new RangeError(`invalid bank ${bank}`);
    if (position < 0 || position >= STORE_POSITIONS) {
      throw new RangeError(`invalid position ${position} (0-${STORE_POSITIONS - 1})`);
    }
    return this.send(CC.PatchHandling, slot, {
      data: {
        data: {
          pp: 0x41,
          command: { ssc: 0x0b, data: { slot, section: bank, position } },
        },
      },
    });
  }

  /**
   * Renames the patch in a slot. `SetPatchTitleMessage`: sc 0x27 under
   * PatchModification, the name as up to 16 characters.
   */
  setPatchTitle(slot: number, name: string): Uint8Array {
    const problem = patchNameProblem(name);
    if (problem) throw new Error(problem);
    return this.modifyPatch(slot, 0x27, {
      name: { chars: Array.from(name, (c) => c.charCodeAt(0)) },
    });
  }

  /** Asks the device to dump the patch currently in `slot`. */
  requestPatch(slot: number): Uint8Array {
    if (slot < 0 || slot > 3) throw new RangeError(`invalid slot ${slot} (0-3)`);
    return this.send(CC.PatchHandling, slot, {
      data: { data: { pp: 0x41, command: { ssc: 0x35, data: {} } } },
    });
  }

  /** Selects which slot the front panel is editing. */
  activateSlot(slot: number): Uint8Array {
    if (slot < 0 || slot > 3) throw new RangeError(`invalid slot ${slot} (0-3)`);
    return this.send(CC.PatchHandling, slot, {
      data: { data: { pp: 0x41, command: { ssc: 0x09, data: { slot } } } },
    });
  }

  /**
   * Collects patch packets arriving over a window.
   *
   * A dump is a run of packets whose command code carries first/last flags in
   * its low two bits (`0x1c`-`0x1f`); their payloads concatenate, seven bits per
   * byte, into the bitstream `patch.pdl2` describes.
   *
   * This resolves rather than rejects when nothing useful arrives: what *did*
   * arrive is the diagnostic, so the caller always gets a report.
   */
  collectPatchPackets(windowMs: number, expectedRuns = 1): {
    done: Promise<PatchDumpReport>;
    stop: () => void;
  } {
    // A patch arrives as one run per requested part, so payloads are grouped by
    // run and each run is unpacked on its own. Each run is a `Section` of the
    // patch bitstream, and sections are byte-aligned (`Section % 8`), so the
    // unpacked runs concatenate cleanly.
    const runs: Uint8Array[][] = [];
    let current: Uint8Array[] = [];
    const seen: string[] = [];
    let packets = 0;
    let sawFirst = false;
    let sawLast = false;
    let settle: (report: PatchDumpReport) => void;

    const done = new Promise<PatchDumpReport>((resolve) => { settle = resolve; });

    const build = (): PatchDumpReport => {
      if (current.length) runs.push(current);

      // Each run is one answered part and is unpacked on its own. They are
      // deliberately not joined: a part's bit length need not be a multiple of
      // eight, so concatenating byte-padded results would inject stray bits.
      const parts = runs.map((run) => {
        const size = run.reduce((n, p) => n + p.length, 0);
        const joined = new Uint8Array(size);
        let offset = 0;
        for (const chunk of run) {
          joined.set(chunk, offset);
          offset += chunk.length;
        }
        return unpack7Bit(joined);
      });

      return {
        parts,
        packets,
        payloadBytes: parts.reduce((n, s) => n + s.length, 0),
        runs: runs.length,
        sawFirst,
        sawLast,
        otherMessages: seen,
      };
    };

    const finish = () => {
      clearTimeout(timer);
      dispose();
      settle(build());
    };

    const timer = setTimeout(finish, windowMs);

    const dispose = this.transport.addListener((raw) => {
      const cc = commandCodeOf(raw);

      if (cc < CC.PatchPacketBase || cc > CC.PatchPacketBase + 3) {
        // Record everything else so a failed fetch says what the device did send.
        if (seen.length < 20) {
          try {
            const decoded = this.decoder.decode(raw);
            let label = decoded.messageId ?? `cc 0x${cc.toString(16)}`;
            // An ACK's type says what the device made of the request, which is
            // the whole story when a dump does not follow.
            const data = decoded.root.items.get('data');
            if (label === 'ack' && data && !Array.isArray(data)) {
              const type = data.values.get('type');
              const pid1 = data.values.get('pid1');
              label = `ack(type 0x${(type ?? 0).toString(16)}, pid ${pid1})`;
            }
            seen.push(label);
          } catch {
            seen.push(`cc 0x${cc.toString(16)} (undecodable)`);
          }
        }
        return;
      }

      packets++;
      const isFirst = (cc & 1) === 1;
      const isLast = ((cc >> 1) & 1) === 1;

      if (isFirst) {
        if (current.length) runs.push(current);
        current = [];
        sawFirst = true;
      }
      // Payload sits between the command/pid byte and the checksum.
      current.push(raw.subarray(5, raw.length - 2));

      if (isLast) {
        sawLast = true;
        runs.push(current);
        current = [];
        // Every requested part has answered; no need to wait out the window.
        if (runs.length >= expectedRuns) finish();
      }
    });

    return { done, stop: finish };
  }

  /**
   * Asks for a patch one part at a time.
   *
   * Off by default — an earlier version of this silenced the synth. Two things
   * were wrong then, both now fixed:
   *
   * 1. `HEADER` was sent with a payload of 0 instead of 0x28. The codes came
   *    from a linear opcode scan that cannot tell an instruction from an
   *    operand; `PATCH_PARTS` is now read off a proper disassembly of the
   *    `tableswitch` in `GetPatchMessage.getBitStream` together with the
   *    ordinal map in `GetPatchMessage$1`.
   * 2. All thirteen went out in one burst. `forAllParts` only *builds* the
   *    array; the original feeds it through `AbstractNmProtocol`'s queue one at
   *    a time. They are paced here, with a gap between each.
   *
   * These share a switch with destructive commands (`ModuleDeletion` 0x32,
   * `CableDelete` 0x51), so treat any change here as touching live hardware.
   */
  async requestPatchParts(
    slot: number,
    patchId: number,
    options: { gapMs?: number; onSent?: (part: string, index: number) => void } = {},
  ): Promise<number> {
    const gap = options.gapMs ?? 60;
    let sent = 0;

    for (const part of PATCH_PARTS) {
      // The pid must be the one the RequestPatch ACK handed back for this
      // transfer, not the slot's continuously-updated id.
      this.send(CC.PatchHandling, slot, {
        data: {
          data: {
            pid: patchId,
            sc: part.sc,
            data: part.payload === undefined ? {} : { payload: part.payload },
          },
        },
      });
      sent++;
      options.onSent?.(part.name, sent);
      await new Promise((r) => setTimeout(r, gap));
    }

    return sent;
  }

  /**
   * Waits for an ACK addressed to `slot` and returns its `pid1`.
   *
   * This is the handshake half of a patch transfer: `RequestPatch` does not
   * return patch data, it returns the id that the part requests must quote.
   */
  waitForAckPid(slot: number, timeoutMs = 2000): Promise<number> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        dispose();
        reject(new Error(`timed out after ${timeoutMs}ms waiting for the request ACK`));
      }, timeoutMs);

      const dispose = this.addListener((message) => {
        if (message.messageId !== 'ack') return;
        if (message.root.values.get('slot') !== slot) return;
        const data = message.root.items.get('data');
        if (!data || Array.isArray(data)) return;
        const pid1 = data.values.get('pid1');
        if (pid1 === undefined) return;
        clearTimeout(timer);
        dispose();
        resolve(pid1);
      });
    });
  }

  /**
   * Loads a stored patch and reads it back.
   *
   * Tries the single whole-patch request first, then the part-by-part path the
   * original uses, since only hardware can settle which this device answers.
   */
  async loadAndFetchPatch(
    slot: number,
    bank: number,
    position: number,
    { windowMs = 5000 }: { windowMs?: number } = {},
  ): Promise<PatchDumpReport> {
    this.loadPatch(slot, bank, position);

    // Loading stamps a new patch id on the slot. Requests that quote a stale
    // pid are acknowledged and ignored, so wait for the device to announce it
    // rather than guessing at a fixed delay.
    await this.waitForFreshPid(slot, 1200);
    return this.fetchPatch(slot, { windowMs });
  }

  /**
   * Reads back whatever patch is in a slot now — `NmSlot.requestPatch`, which
   * Nomad runs when the device reports a new patch in a slot (one chosen on
   * its own front panel, say).
   */
  async fetchPatch(
    slot: number,
    { windowMs = 5000 }: { windowMs?: number } = {},
  ): Promise<PatchDumpReport> {
    // Stage 1: RequestPatch is a handshake, not a dump. It returns an ACK whose
    // pid1 is the transfer's patch id — ReqPatchWorker takes exactly this and
    // hands it to GetPatchWorker.
    const ack = this.waitForAckPid(slot, 2000);
    this.requestPatch(slot);

    let patchId: number;
    try {
      patchId = await ack;
    } catch (error) {
      return {
        parts: [],
        packets: 0, payloadBytes: 0, runs: 0,
        sawFirst: false, sawLast: false,
        otherMessages: [(error as Error).message],
        method: 'RequestPatch (no ACK)',
      };
    }

    // Stage 2: ask for each part, quoting that id. GetPatchWorker waits for
    // thirteen replies with a five-second budget.
    const collecting = this.collectPatchPackets(windowMs, PATCH_PARTS.length);
    const sent = await this.requestPatchParts(slot, patchId);
    const report = await collecting.done;

    return {
      ...report,
      method: `RequestPatch -> pid ${patchId} -> ${sent} part requests`,
      patchId,
    };
  }

  /**
   * Sends a patch modification.
   *
   * All of these share the `PatchModification` shape under `PatchHandling`;
   * `MoveModuleMessage` and friends confirm the paths as `data:data:pid` and
   * `data:data:sc`.
   */
  private modifyPatch(slot: number, sc: number, payload: MessageInit): Uint8Array {
    return this.send(CC.PatchHandling, slot, {
      data: { data: { pid: this.getActivePid(slot), sc, data: payload } },
    });
  }

  /**
   * Adds a module: the fragment from `PatchWriter.newModule`, sent as one
   * patch packet quoting the slot's patch id (NmUtils.createNewModuleMessage).
   */
  addModule(slot: number, fragment: { bytes: Uint8Array; bitLength: number }): Uint8Array {
    if (slot < 0 || slot > 3) throw new RangeError(`invalid slot ${slot} (0-3)`);
    const message = patchPacket(slot, this.getActivePid(slot), fragment);
    this.transport.send(message);
    this.record({ direction: 'out', at: Date.now(), hex: formatSysex(message) });
    return message;
  }

  /**
   * Sends a whole patch into a slot, replacing what is there
   * (`StorePatchInSlotWorker`). Nothing is sent first: the packets alone do it.
   *
   * Packets go one at a time. Each expects a reply, and Nomad's send queue
   * waits for one (an ACK, or an error) before sending the next, giving up
   * after three seconds. The last reply's `pid1` is the slot's new patch id.
   */
  async uploadPatch(
    slot: number,
    sections: { bytes: Uint8Array; bitLength: number }[],
    onProgress?: (sent: number, total: number) => void,
  ): Promise<number> {
    if (slot < 0 || slot > 3) throw new RangeError(`invalid slot ${slot} (0-3)`);
    const packets = patchUploadPackets(slot, sections);
    let pid = this.getActivePid(slot);

    for (const [i, packet] of packets.entries()) {
      const reply = this.waitForReply(slot, 3000);
      reply.catch(() => {});
      this.transport.send(packet);
      this.record({ direction: 'out', at: Date.now(), hex: formatSysex(packet) });
      const answer = await reply.catch((error: Error) => {
        throw new Error(`section ${i + 1} of ${packets.length}: ${error.message}`);
      });
      if (answer.messageId === 'error') {
        const data = answer.root.items.get('data');
        const code = data && !Array.isArray(data) ? data.items.get('data') : undefined;
        const value = code && !Array.isArray(code) ? code.values.get('code') : undefined;
        throw new Error(`the device refused section ${i + 1} of ${packets.length} (error ${value ?? '?'})`);
      }
      const data = answer.root.items.get('data');
      const pid1 = data && !Array.isArray(data) ? data.values.get('pid1') : undefined;
      if (pid1 !== undefined) pid = pid1;
      onProgress?.(i + 1, packets.length);
    }
    return pid;
  }

  /** The next ACK or error for a slot: what the device answers a packet with. */
  private waitForReply(slot: number, timeoutMs: number): Promise<DecodeResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        dispose();
        reject(new Error(`no reply from the device within ${timeoutMs / 1000} s`));
      }, timeoutMs);
      const dispose = this.addListener((message) => {
        if (message.messageId !== 'ack' && message.messageId !== 'error') return;
        if (message.root.values.get('slot') !== slot) return;
        clearTimeout(timer);
        dispose();
        resolve(message);
      });
    });
  }

  /** Moves a module on the patch grid. `sc` 0x34, per MoveModuleMessage. */
  moveModule(slot: number, area: 0 | 1, moduleIndex: number, x: number, y: number): Uint8Array {
    return this.modifyPatch(slot, 0x34, {
      section: area,
      module: moduleIndex,
      xpos: x,
      ypos: y,
    });
  }

  /**
   * Connects two connectors. `sc` 0x50, per NewCableMessage.
   *
   * `type1`/`type2` say whether each end is an output (1) or an input (0) —
   * the Nord allows chaining from an input, so both ends are explicit.
   */
  addCable(
    slot: number,
    area: 0 | 1,
    color: number,
    from: { module: number; connector: number; isOutput: number },
    to: { module: number; connector: number; isOutput: number },
  ): Uint8Array {
    return this.modifyPatch(slot, 0x50, {
      section: area,
      color,
      module1: from.module, type1: from.isOutput, connector1: from.connector,
      module2: to.module, type2: to.isOutput, connector2: to.connector,
    });
  }

  /** Removes a cable between two connectors. `sc` 0x51, per DeleteCableMessage. */
  deleteCable(
    slot: number,
    area: 0 | 1,
    from: { module: number; connector: number; isOutput: number },
    to: { module: number; connector: number; isOutput: number },
  ): Uint8Array {
    return this.modifyPatch(slot, 0x51, {
      section: area,
      module1: from.module, type1: from.isOutput, connector1: from.connector,
      module2: to.module, type2: to.isOutput, connector2: to.connector,
    });
  }

  /** Removes a module from the patch. `sc` 0x32. */
  deleteModule(slot: number, area: 0 | 1, moduleIndex: number): Uint8Array {
    return this.modifyPatch(slot, 0x32, { section: area, module: moduleIndex });
  }

  /**
   * Puts a parameter on a hardware knob, or takes one off.
   *
   * Mirrors `KnobAssignmentMessage.assign(slot, pid, prevKnob, knob, ...)`:
   *
   * - no previous knob: `sc` 0x25 with the new assignment;
   * - a previous knob: `sc` 0x26 quoting it, followed by the new assignment as
   *   a nested 0x25 packet — or by nothing, which clears that knob.
   *
   * `previousKnob` is the knob the *parameter* was on before, not whatever the
   * target knob held. A parameter rides on at most one knob.
   */
  assignKnob(
    slot: number,
    previousKnob: number | null,
    assignment: { knob: number; area: 0 | 1; module: number; parameter: number } | null,
  ): Uint8Array {
    if (previousKnob === null && !assignment) {
      throw new Error('previous and new knob can not both be empty');
    }
    for (const knob of [previousKnob, assignment?.knob]) {
      if (knob != null && (knob < 0 || knob > 22)) throw new RangeError(`invalid knob ${knob}`);
    }

    const fields = assignment && {
      module: assignment.module,
      parameter: assignment.parameter,
      section: assignment.area,
      knob: assignment.knob,
    };

    if (previousKnob === null) return this.modifyPatch(slot, 0x25, fields!);
    // The nested packet wraps the assignment once more (`NewKnobAssignmentPacket
    // := 0x25 KnobAssignment$data`), hence Java's extra `data:data:` prefix.
    return this.modifyPatch(slot, 0x26, fields
      ? { prevknob: previousKnob, data: { data: fields } }
      : { prevknob: previousKnob });
  }

  /** Sets a single parameter value. `sc` 0x40 under the Parameter command. */
  setParameter(
    slot: number,
    area: 0 | 1,
    moduleIndex: number,
    parameterIndex: number,
    value: number,
  ): Uint8Array {
    return this.send(CC.Parameter, slot, {
      data: {
        pid: this.getActivePid(slot),
        sc: 0x40,
        data: { section: area, module: moduleIndex, parameter: parameterIndex, value },
      },
    });
  }

  /**
   * Waits for the device to report a patch id for `slot`.
   *
   * Resolves as soon as one arrives, or after `timeoutMs` with whatever is
   * current — the device streams meters and lights continuously, so a pid
   * normally appears within a few milliseconds.
   */
  waitForFreshPid(slot: number, timeoutMs = 1200): Promise<number> {
    return new Promise((resolve) => {
      const before = this.activePids[slot];

      const settle = () => {
        clearTimeout(timer);
        this.onActivePidChanged = previous;
        resolve(this.activePids[slot]);
      };

      const timer = setTimeout(settle, timeoutMs);
      const previous = this.onActivePidChanged;
      this.onActivePidChanged = (changed, pid) => {
        previous?.(changed, pid);
        if (changed === slot && pid !== before) settle();
      };
    });
  }

  /** Resolves on the next message with the given id, or rejects on timeout. */
  waitFor(messageId: string, timeoutMs = 2000): Promise<DecodeResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        dispose();
        reject(
          new Error(
            `timed out after ${timeoutMs}ms waiting for "${messageId}". ` +
              'Check that the MIDI ports match the Nord and that it is powered on.',
          ),
        );
      }, timeoutMs);

      const dispose = this.addListener((message) => {
        if (message.messageId !== messageId) return;
        clearTimeout(timer);
        dispose();
        resolve(message);
      });
    });
  }
}
