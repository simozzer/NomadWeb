/**
 * Bit-level cursor over a byte buffer, MSB-first.
 *
 * Verified against the sample messages recorded in midi.pdl2: for
 * `F0 33 50 06 ...` the third byte 0x50 decomposes under `0:1 cc:5 slot:2`
 * into cc=0x14 (NMInfo), slot=0, which matches the Clavia command table.
 */
export class BitReader {
  readonly bytes: Uint8Array;
  /** Absolute position in bits from the start of the buffer. */
  pos = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get bitLength(): number {
    return this.bytes.length * 8;
  }

  get remaining(): number {
    return this.bitLength - this.pos;
  }

  get atEnd(): boolean {
    return this.pos >= this.bitLength;
  }

  /** Read `width` bits (0..32) as an unsigned integer, advancing the cursor. */
  read(width: number): number {
    if (width === 0) return 0;
    if (width < 0 || width > 32) {
      throw new RangeError(`bit width out of range: ${width}`);
    }
    if (this.pos + width > this.bitLength) {
      throw new BitStreamError(
        `read of ${width} bits at ${this.pos} exceeds buffer (${this.bitLength} bits)`,
      );
    }
    let value = 0;
    let need = width;
    while (need > 0) {
      const byteIndex = this.pos >> 3;
      const bitOffset = this.pos & 7;
      const available = 8 - bitOffset;
      const take = Math.min(available, need);
      // Shift the byte so the bits we want sit at the bottom, then mask.
      const chunk = (this.bytes[byteIndex] >> (available - take)) & ((1 << take) - 1);
      value = (value << take) | chunk;
      this.pos += take;
      need -= take;
    }
    // `<<` is signed 32-bit; force unsigned for widths near 32.
    return value >>> 0;
  }

  /** Read without advancing. */
  peek(width: number): number {
    const saved = this.pos;
    try {
      return this.read(width);
    } finally {
      this.pos = saved;
    }
  }

  /** Advance the cursor to the next multiple of `alignment` bits. */
  align(alignment: number): void {
    if (alignment <= 0) return;
    const overshoot = this.pos % alignment;
    if (overshoot !== 0) this.pos += alignment - overshoot;
  }

  /**
   * Sum of `unit`-bit words over the bit range [from, to), used by the
   * checksum aggregate `[+;0;@label;8;$]`.
   */
  sumRange(from: number, to: number, unit: number): number {
    const saved = this.pos;
    try {
      this.pos = from;
      let total = 0;
      while (this.pos + unit <= to) total += this.read(unit);
      return total;
    } finally {
      this.pos = saved;
    }
  }
}

export class BitWriter {
  private chunks: number[] = [];
  /** Absolute position in bits written so far. */
  pos = 0;

  write(value: number, width: number): void {
    if (width === 0) return;
    if (width < 0 || width > 32) {
      throw new RangeError(`bit width out of range: ${width}`);
    }
    let need = width;
    while (need > 0) {
      const byteIndex = this.pos >> 3;
      const bitOffset = this.pos & 7;
      const available = 8 - bitOffset;
      const take = Math.min(available, need);
      if (this.chunks.length <= byteIndex) this.chunks.push(0);
      const chunk = (value >>> (need - take)) & ((1 << take) - 1);
      this.chunks[byteIndex] |= chunk << (available - take);
      this.pos += take;
      need -= take;
    }
  }

  /** Pad with zero bits up to the next multiple of `alignment`. */
  align(alignment: number): void {
    if (alignment <= 0) return;
    const overshoot = this.pos % alignment;
    if (overshoot !== 0) this.write(0, alignment - overshoot);
  }

  /** Overwrite an already-written field, for back-patching checksums. */
  patch(bitPos: number, value: number, width: number): void {
    const saved = this.pos;
    // Clear the target bits first, then OR the new value in.
    for (let i = 0; i < width; i++) {
      const abs = bitPos + i;
      this.chunks[abs >> 3] &= ~(1 << (7 - (abs & 7)));
    }
    this.pos = bitPos;
    this.write(value, width);
    this.pos = saved;
  }

  sumRange(from: number, to: number, unit: number): number {
    const reader = new BitReader(this.toBytes());
    return reader.sumRange(from, to, unit);
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

export class BitStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BitStreamError';
  }
}
