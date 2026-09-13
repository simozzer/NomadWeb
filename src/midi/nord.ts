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
