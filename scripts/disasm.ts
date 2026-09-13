/**
 * A correct Java bytecode disassembler for the protocol classes.
 *
 * The earlier `inspect-class --code` scanned for `bipush`/`sipush` bytes
 * linearly, which cannot distinguish an instruction from an operand, so the
 * "constants" it printed were partly noise. Sending commands derived from that
 * to real hardware modified a patch. This walks instructions properly — correct
 * operand widths, and the variable-length `tableswitch` / `lookupswitch` /
 * `wide` forms — so what it prints is actually what the method does.
 *
 *   node scripts/disasm.ts <file.class> [methodName]
 */
import { readFileSync } from 'node:fs';

const path = process.argv[2];
const wanted = process.argv[3];
if (!path) {
  process.stdout.write('usage: disasm.ts <file.class> [methodName]\n');
  process.exit(1);
}

const buf = readFileSync(path);
let p = 0;
const u1 = () => buf.readUInt8(p++);
const u2 = () => { const v = buf.readUInt16BE(p); p += 2; return v; };
const u4 = () => { const v = buf.readUInt32BE(p); p += 4; return v; };

if (u4() !== 0xcafebabe) throw new Error('not a class file');
u2(); u2();

type Entry = { tag: number; text?: string; num?: number; a?: number; b?: number };
const pool: (Entry | null)[] = [null];
const poolCount = u2();

for (let i = 1; i < poolCount; i++) {
  const tag = u1();
  switch (tag) {
    case 1: { const n = u2(); pool.push({ tag, text: buf.subarray(p, p + n).toString('utf8') }); p += n; break; }
    case 3: pool.push({ tag, num: buf.readInt32BE(p) }); p += 4; break;
    case 4: pool.push({ tag, num: buf.readFloatBE(p) }); p += 4; break;
    case 5: pool.push({ tag, num: Number(buf.readBigInt64BE(p)) }); p += 8; pool.push(null); i++; break;
    case 6: pool.push({ tag, num: buf.readDoubleBE(p) }); p += 8; pool.push(null); i++; break;
    case 7: case 8: case 16: case 19: case 20: pool.push({ tag, a: u2() }); break;
    case 15: pool.push({ tag, a: u1(), b: u2() }); break;
    case 9: case 10: case 11: case 12: case 17: case 18: pool.push({ tag, a: u2(), b: u2() }); break;
    default: throw new Error(`unknown constant tag ${tag} at ${i}`);
  }
}

const utf8 = (i: number) => pool[i]?.text ?? `#${i}`;

/** Renders a constant-pool entry the way it would read in source. */
function describe(index: number): string {
  const e = pool[index];
  if (!e) return `#${index}`;
  switch (e.tag) {
    case 1: return JSON.stringify(e.text);
    case 3: case 4: case 5: case 6: return String(e.num);
    case 7: return utf8(e.a!);
    case 8: return JSON.stringify(utf8(e.a!));
    case 9: case 10: case 11: {
      const cls = utf8(pool[e.a!]!.a!);
      const nt = pool[e.b!]!;
      return `${cls}.${utf8(nt.a!)}`;
    }
    case 12: return `${utf8(e.a!)}:${utf8(e.b!)}`;
    default: return `#${index}`;
  }
}

// Operand byte-count per opcode (excluding the opcode itself). -1 marks the
// variable-length forms, handled explicitly below.
const OPERANDS = new Int8Array(256).fill(0);
const set = (n: number, codes: number[]) => codes.forEach((c) => { OPERANDS[c] = n; });
set(1, [0x10, 0x12, 0x15, 0x16, 0x17, 0x18, 0x19, 0x36, 0x37, 0x38, 0x39, 0x3a, 0xa9, 0xbc]);
set(2, [
  0x11, 0x13, 0x14, 0x84,
  0x99, 0x9a, 0x9b, 0x9c, 0x9d, 0x9e, 0x9f,
  0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8,
  0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8,
  0xbb, 0xbd, 0xc0, 0xc1, 0xc6, 0xc7,
]);
set(3, [0xc5]);
set(4, [0xb9, 0xba, 0xc8, 0xc9]);
OPERANDS[0xaa] = -1; // tableswitch
OPERANDS[0xab] = -1; // lookupswitch
OPERANDS[0xc4] = -1; // wide

const NAMES: Record<number, string> = {
  0x02: 'iconst_m1', 0x03: 'iconst_0', 0x04: 'iconst_1', 0x05: 'iconst_2',
  0x06: 'iconst_3', 0x07: 'iconst_4', 0x08: 'iconst_5',
  0x10: 'bipush', 0x11: 'sipush', 0x12: 'ldc', 0x13: 'ldc_w', 0x14: 'ldc2_w',
  0x59: 'dup', 0xbb: 'new', 0xb7: 'invokespecial', 0xb6: 'invokevirtual',
  0xb8: 'invokestatic', 0xb9: 'invokeinterface', 0xb2: 'getstatic', 0xb3: 'putstatic',
  0xb4: 'getfield', 0xb5: 'putfield', 0xbd: 'anewarray', 0x53: 'aastore',
  0xaa: 'tableswitch', 0xab: 'lookupswitch', 0xb1: 'return', 0xac: 'ireturn',
  0xb0: 'areturn', 0x2a: 'aload_0', 0x2b: 'aload_1', 0x2c: 'aload_2', 0x2d: 'aload_3',
  0x1a: 'iload_0', 0x1b: 'iload_1', 0x1c: 'iload_2', 0x1d: 'iload_3',
};

function disassemble(code: Buffer): string[] {
  const lines: string[] = [];
  let i = 0;

  while (i < code.length) {
    const pc = i;
    const op = code[i++];
    const name = NAMES[op] ?? `0x${op.toString(16).padStart(2, '0')}`;
    let text = name;

    if (op === 0xaa) {
      i += (4 - (i % 4)) % 4; // padding to a 4-byte boundary
      const dflt = code.readInt32BE(i); i += 4;
      const low = code.readInt32BE(i); i += 4;
      const high = code.readInt32BE(i); i += 4;
      const targets: string[] = [];
      for (let k = low; k <= high; k++) {
        targets.push(`${k}->${pc + code.readInt32BE(i)}`);
        i += 4;
      }
      text = `tableswitch default->${pc + dflt} ${targets.join(' ')}`;
    } else if (op === 0xab) {
      i += (4 - (i % 4)) % 4;
      const dflt = code.readInt32BE(i); i += 4;
      const n = code.readInt32BE(i); i += 4;
      const pairs: string[] = [];
      for (let k = 0; k < n; k++) {
        const match = code.readInt32BE(i); i += 4;
        const offset = code.readInt32BE(i); i += 4;
        pairs.push(`${match}(0x${match.toString(16)})->${pc + offset}`);
      }
      text = `lookupswitch default->${pc + dflt} ${pairs.join(' ')}`;
    } else if (op === 0xc4) {
      const inner = code[i++];
      i += inner === 0x84 ? 4 : 2;
      text = `wide ${NAMES[inner] ?? inner}`;
    } else {
      const n = OPERANDS[op];
      if (n === 1) {
        const v = op === 0x12 ? code.readUInt8(i) : code.readInt8(i);
        text += op === 0x12 ? ` ${describe(v)}` : ` ${v}`;
        i += 1;
      } else if (n === 2) {
        const v = code.readUInt16BE(i);
        const isRef = [0x13, 0x14, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xbb, 0xbd, 0xc0, 0xc1].includes(op);
        text += isRef ? ` ${describe(v)}` : ` ${v}`;
        i += 2;
      } else if (n === 3) {
        text += ` ${code.readUInt8(i)} ${code.readInt8(i + 1)}`;
        i += 3;
      } else if (n === 4) {
        text += ` ${describe(code.readUInt16BE(i))}`;
        i += 4;
      }
    }

    lines.push(`${String(pc).padStart(5)}: ${text}`);
  }

  return lines;
}

// Class header, then fields, then methods.
u2(); const thisClass = u2(); u2();
const ifaces = u2(); p += ifaces * 2;

const skipAttributes = () => {
  const n = u2();
  for (let i = 0; i < n; i++) { u2(); const len = u4(); p += len; }
};

process.stdout.write(`\n=== ${utf8(pool[thisClass]!.a!)} ===\n`);

process.stdout.write('\n-- fields --\n');
const fieldCount = u2();
for (let i = 0; i < fieldCount; i++) {
  u2();
  const name = utf8(u2());
  const desc = utf8(u2());
  skipAttributes();
  process.stdout.write(`  ${name} : ${desc}\n`);
}

const methodCount = u2();
for (let i = 0; i < methodCount; i++) {
  u2();
  const name = utf8(u2());
  const desc = utf8(u2());
  const attrCount = u2();

  for (let a = 0; a < attrCount; a++) {
    const attrName = utf8(u2());
    const len = u4();
    const end = p + len;
    if (attrName === 'Code' && (!wanted || name === wanted)) {
      u2(); u2();
      const codeLen = u4();
      const code = buf.subarray(p, p + codeLen);
      process.stdout.write(`\n-- ${name}${desc} --\n`);
      for (const line of disassemble(code)) process.stdout.write(`  ${line}\n`);
    }
    p = end;
  }
}
