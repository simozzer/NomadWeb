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

export interface DeviceIdentity {
  deviceId: number;
  deviceName: string;
  /** Last four digits of the unit's serial number. */
  serial: number;
  version: string;
}

/** Banks and positions the device accepts, per GetPatchListMessage's own bounds. */
export const MAX_BANKS = 9;
export const MAX_POSITION = 99;

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
      result = this.decoder.decode(raw, { validateComputed: true });
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
    for (const listener of this.listeners) listener(result, raw);
  }

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
      deviceName: DEVICE_NAMES[deviceId] ?? `unknown device (0x${deviceId.toString(16)})`,
      serial: ((serial1 & 0x7f) << 7) | (serial2 & 0x7f),
      version: `${high}.${low}`,
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
