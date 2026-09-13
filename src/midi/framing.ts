const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;

export interface FramingStats {
  /** Complete messages emitted. */
  framed: number;
  /** Messages dropped because a new F0 arrived before the expected F7. */
  truncated: number;
  /** Bytes discarded outside any message. */
  stray: number;
}

/**
 * Reassembles SysEx messages from arbitrarily chunked MIDI input.
 *
 * Web MIDI delivers a long SysEx as several `MIDIMessageEvent`s, so messages
 * must be accumulated across events. The device also interleaves messages under
 * load — see NOTES-protocol.md — emitting a fresh `F0` before the previous
 * message's `F7`. A leading `F0` therefore always starts a new message and the
 * partial one is discarded; the affected traffic (meters, lights) is continuous,
 * so a dropped frame costs nothing.
 */
export class SysexFramer {
  private buffer: number[] = [];
  private inMessage = false;
  readonly stats: FramingStats = { framed: 0, truncated: 0, stray: 0 };

  /** Feed raw bytes; returns whatever complete messages they completed. */
  push(data: Uint8Array): Uint8Array[] {
    const messages: Uint8Array[] = [];

    for (const byte of data) {
      if (byte === SYSEX_START) {
        if (this.inMessage) this.stats.truncated++;
        this.buffer = [byte];
        this.inMessage = true;
        continue;
      }

      if (!this.inMessage) {
        // Realtime bytes (0xf8-0xff) may legally appear between SysEx chunks.
        if (byte < 0xf8) this.stats.stray++;
        continue;
      }

      if (byte === SYSEX_END) {
        this.buffer.push(byte);
        messages.push(Uint8Array.from(this.buffer));
        this.stats.framed++;
        this.buffer = [];
        this.inMessage = false;
        continue;
      }

      // Realtime messages can be embedded mid-SysEx; they are not part of it.
      if (byte >= 0xf8) continue;

      this.buffer.push(byte);
    }

    return messages;
  }

  reset(): void {
    this.buffer = [];
    this.inMessage = false;
  }
}

/**
 * Splits an outgoing SysEx message into chunks.
 *
 * Some drivers and USB-MIDI interfaces cap a single SysEx write; sending a long
 * patch dump as one buffer can silently truncate. Chunking is safe because the
 * receiver reassembles on F0/F7 rather than per write.
 */
export function chunkSysex(message: Uint8Array, maxChunk = 256): Uint8Array[] {
  if (message.length <= maxChunk) return [message];
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < message.length; offset += maxChunk) {
    chunks.push(message.subarray(offset, Math.min(offset + maxChunk, message.length)));
  }
  return chunks;
}

export function formatSysex(message: Uint8Array, maxBytes = 32): string {
  const shown = Array.from(message.subarray(0, maxBytes))
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
  return message.length > maxBytes ? `${shown} ... (${message.length} bytes)` : shown;
}
