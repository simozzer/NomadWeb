/**
 * Minimal Java .class constant-pool reader.
 *
 * Used to check this port's message construction against Nomad's compiled
 * protocol classes, which are the only surviving record of how the original
 * actually framed its messages.
 *
 *   node scripts/inspect-class.ts <file.class> [--code]
 */
import { readFileSync } from 'node:fs';

const path = process.argv[2];
const showCode = process.argv.includes('--code');
if (!path) {
  process.stdout.write('usage: inspect-class.ts <file.class> [--code]\n');
  process.exit(1);
}

const buf = readFileSync(path);
let p = 0;
const u1 = () => buf.readUInt8(p++);
const u2 = () => { const v = buf.readUInt16BE(p); p += 2; return v; };
const u4 = () => { const v = buf.readUInt32BE(p); p += 4; return v; };

if (u4() !== 0xcafebabe) throw new Error('not a class file');
u2(); u2(); // minor, major

type Entry = { tag: number; text?: string; int?: number; a?: number; b?: number };
const pool: (Entry | null)[] = [null];
const count = u2();

for (let i = 1; i < count; i++) {
  const tag = u1();
  switch (tag) {
    case 1: { const len = u2(); pool.push({ tag, text: buf.subarray(p, p + len).toString('utf8') }); p += len; break; }
    case 3: pool.push({ tag, int: buf.readInt32BE(p) }); p += 4; break;
    case 4: pool.push({ tag, int: buf.readFloatBE(p) }); p += 4; break;
    case 5: pool.push({ tag, int: Number(buf.readBigInt64BE(p)) }); p += 8; pool.push(null); i++; break;
    case 6: pool.push({ tag, int: buf.readDoubleBE(p) }); p += 8; pool.push(null); i++; break;
    case 7: case 8: case 16: case 19: case 20: pool.push({ tag, a: u2() }); break;
    case 15: { const k = u1(); pool.push({ tag, a: k, b: u2() }); break; }
    case 9: case 10: case 11: case 12: case 17: case 18:
      pool.push({ tag, a: u2(), b: u2() }); break;
    default: throw new Error(`unknown constant tag ${tag} at index ${i}`);
  }
}

const utf8 = (i: number) => pool[i]?.text ?? `#${i}`;

process.stdout.write(`\n=== ${path} ===\n`);

process.stdout.write('\n-- string literals --\n');
for (const e of pool) {
  if (e?.tag === 8) process.stdout.write(`  ${JSON.stringify(utf8(e.a!))}\n`);
}

process.stdout.write('\n-- integer constants --\n');
const ints = pool.filter((e) => e?.tag === 3).map((e) => e!.int!);
process.stdout.write(`  ${ints.map((n) => `${n} (0x${(n >>> 0).toString(16)})`).join(', ') || '(none)'}\n`);

process.stdout.write('\n-- referenced methods --\n');
const seen = new Set<string>();
for (const e of pool) {
  if (e?.tag !== 10 && e?.tag !== 9) continue;
  const cls = utf8(pool[e.a!]!.a!);
  const nt = pool[e.b!]!;
  const line = `${cls}.${utf8(nt.a!)}${e.tag === 10 ? utf8(nt.b!) : `  : ${utf8(nt.b!)}`}`;
  if (!seen.has(line)) { seen.add(line); process.stdout.write(`  ${line}\n`); }
}

if (showCode) {
  // Skip past access/this/super/interfaces/fields to reach methods, then dump
  // the small integer pushes in each Code attribute.
  u2(); u2(); u2();
  const ifaceCount = u2(); p += ifaceCount * 2;

  const skipAttributes = () => {
    const n = u2();
    for (let i = 0; i < n; i++) { u2(); const len = u4(); p += len; }
  };
  const skipMembers = () => {
    const n = u2();
    for (let i = 0; i < n; i++) { u2(); u2(); u2(); skipAttributes(); }
  };
  skipMembers(); // fields

  process.stdout.write('\n-- methods: literal byte pushes --\n');
  const methodCount = u2();
  for (let i = 0; i < methodCount; i++) {
    u2();
    const name = utf8(u2());
    const desc = utf8(u2());
    const attrCount = u2();
    const pushes: number[] = [];
    for (let a = 0; a < attrCount; a++) {
      const attrName = utf8(u2());
      const len = u4();
      const end = p + len;
      if (attrName === 'Code') {
        u2(); u2();
        const codeLen = u4();
        const code = buf.subarray(p, p + codeLen);
        for (let c = 0; c < code.length; c++) {
          const op = code[c];
          if (op === 0x10) { pushes.push(code[c + 1]); c += 1; }          // bipush
          else if (op === 0x11) { pushes.push(code.readInt16BE(c + 1)); c += 2; } // sipush
        }
      }
      p = end;
    }
    if (pushes.length) {
      process.stdout.write(
        `  ${name}${desc}\n    ${pushes.map((n) => `0x${(n & 0xff).toString(16).padStart(2, '0')}`).join(' ')}\n`,
      );
    }
  }
}
