import type { Expr, Grammar, Item, Rule } from './ast.ts';
import { BitReader, BitWriter } from './bitstream.ts';

/** A decoded packet node. Nested rules appear under `items`. */
export interface Decoded {
  rule: string;
  values: Map<string, number>;
  items: Map<string, Decoded | Decoded[]>;
  annotations: Map<string, string>;
}

export interface DecodeResult {
  root: Decoded;
  /** The most specific `messageId(...)` reached during the parse. */
  messageId?: string;
  /** Bits consumed. Less than the buffer length means trailing data. */
  bitsConsumed: number;
}

export class Pdl2DecodeError extends Error {
  readonly rulePath: string[];

  constructor(message: string, rulePath: string[]) {
    super(rulePath.length ? `${message} [in ${rulePath.join(' > ')}]` : message);
    this.name = 'Pdl2DecodeError';
    this.rulePath = rulePath;
  }
}

/** Dynamic scope: nested rules can read fields declared by their callers. */
class Scope {
  private readonly values = new Map<string, number>();
  private readonly parent: Scope | null;
  readonly labels = new Map<string, number>();

  constructor(parent: Scope | null) {
    this.parent = parent;
  }

  set(name: string, value: number): void {
    this.values.set(name, value);
  }

  setLabel(name: string, bitPos: number): void {
    this.labels.set(name, bitPos);
  }

  lookup(name: string): number | undefined {
    if (name.startsWith('@')) {
      const label = name.slice(1);
      for (let s: Scope | null = this; s; s = s.parent) {
        const pos = s.labels.get(label);
        if (pos !== undefined) return pos;
      }
      return undefined;
    }
    for (let s: Scope | null = this; s; s = s.parent) {
      const value = s.values.get(name);
      if (value !== undefined) return value;
    }
    return undefined;
  }
}

function evaluate(
  expr: Expr,
  scope: Scope,
  sum: (from: number, to: number, unit: number) => number,
): number {
  switch (expr.kind) {
    case 'num':
      return expr.value;
    case 'ref': {
      const value = scope.lookup(expr.name);
      if (value === undefined) throw new Error(`undefined reference ${expr.name}`);
      return value;
    }
    case 'unary': {
      const v = evaluate(expr.operand, scope, sum);
      return expr.op === '-' ? -v : ~v;
    }
    case 'aggregate': {
      const from = evaluate(expr.from, scope, sum);
      const to = evaluate(expr.to, scope, sum);
      return sum(from, to, expr.unit);
    }
    case 'binary': {
      const a = evaluate(expr.left, scope, sum);
      const b = evaluate(expr.right, scope, sum);
      switch (expr.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return Math.floor(a / b);
        case '%': return a % b;
        case '&': return a & b;
        case '|': return a | b;
        case '^': return a ^ b;
        case '<<': return a << b;
        case '>>': return a >>> b;
      }
    }
  }
}

export interface DecodeOptions {
  /**
   * Values that override a rule's own computed assignment.
   *
   * Needed for `PatchPacket`, whose upstream definition pins its payload
   * length to zero (`%HACK:16 = (0)`) and expects the host to supply the
   * real length. See the comment above `PatchPacket` in midi.pdl2.
   */
  overrides?: Record<string, number>;
  /** Reject a computed field whose stream value disagrees (e.g. a bad checksum). */
  validateComputed?: boolean;
}

export class Pdl2Decoder {
  private readonly grammar: Grammar;

  constructor(grammar: Grammar) {
    this.grammar = grammar;
  }

  decode(bytes: Uint8Array, options: DecodeOptions = {}): DecodeResult {
    const reader = new BitReader(bytes);
    const state = { messageId: undefined as string | undefined };
    const root = this.decodeRule(
      this.requireRule(this.grammar.start),
      reader,
      new Scope(null),
      state,
      options,
      [],
    );
    return { root, messageId: state.messageId, bitsConsumed: reader.pos };
  }

  private requireRule(name: string): Rule {
    const rule = this.grammar.rules.get(name);
    if (!rule) throw new Pdl2DecodeError(`no such rule: ${name}`, []);
    return rule;
  }

  private decodeRule(
    rule: Rule,
    reader: BitReader,
    parentScope: Scope,
    state: { messageId?: string },
    options: DecodeOptions,
    path: string[],
  ): Decoded {
    if (rule.alignment) reader.align(rule.alignment);

    const scope = new Scope(parentScope);
    const node: Decoded = {
      rule: rule.name,
      values: new Map(),
      items: new Map(),
      annotations: new Map(),
    };
    const rulePath = [...path, rule.name];

    this.decodeItems(rule.body, reader, scope, node, state, options, rulePath);
    return node;
  }

  private decodeItems(
    items: Item[],
    reader: BitReader,
    scope: Scope,
    node: Decoded,
    state: { messageId?: string },
    options: DecodeOptions,
    path: string[],
  ): void {
    const sum = (from: number, to: number, unit: number) => reader.sumRange(from, to, unit);

    for (const item of items) {
      switch (item.kind) {
        case 'const': {
          const actual = reader.read(item.width);
          if (actual !== item.value) {
            throw new Pdl2DecodeError(
              `expected constant 0x${item.value.toString(16)} (${item.width} bits) ` +
                `but read 0x${actual.toString(16)} at bit ${reader.pos - item.width}`,
              path,
            );
          }
          break;
        }

        case 'var': {
          const override = options.overrides?.[item.name];
          let value: number;

          if (item.implicit) {
            // Consumes no bits; the value is computed (or overridden).
            value = override ?? (item.value ? evaluate(item.value, scope, sum) : 0);
          } else {
            value = reader.read(item.width);
            if (item.value && options.validateComputed) {
              const expected = evaluate(item.value, scope, sum) & ((1 << item.width) - 1);
              if (expected !== value) {
                throw new Pdl2DecodeError(
                  `field ${item.name} is 0x${value.toString(16)} but the grammar ` +
                    `computes 0x${expected.toString(16)}`,
                  path,
                );
              }
            }
          }

          scope.set(item.name, value);
          node.values.set(item.name, value);
          break;
        }

        case 'rule': {
          const target = this.requireRule(item.rule);
          const saved = reader.pos;
          try {
            const child = this.decodeRule(target, reader, scope, state, options, path);
            if (item.item === '') {
              // Inline form: merge the child's fields into this node.
              for (const [k, v] of child.values) {
                node.values.set(k, v);
                scope.set(k, v);
              }
              for (const [k, v] of child.items) node.items.set(k, v);
              for (const [k, v] of child.annotations) node.annotations.set(k, v);
            } else {
              node.items.set(item.item, child);
            }
          } catch (error) {
            if (!item.optional) throw error;
            reader.pos = saved;
          }
          break;
        }

        case 'switch': {
          const selector = evaluate(item.selector, scope, sum);
          const matched = item.cases.find((c) => c.value === selector);
          if (matched) {
            this.decodeItems(matched.body, reader, scope, node, state, options, path);
          } else if (item.fallback === 'fail') {
            throw new Pdl2DecodeError(
              `no case for selector value 0x${selector.toString(16)}`,
              path,
            );
          } else if (Array.isArray(item.fallback)) {
            this.decodeItems(item.fallback, reader, scope, node, state, options, path);
          }
          break;
        }

        case 'alt': {
          let lastError: unknown;
          let ok = false;
          for (const branch of item.alternatives) {
            const saved = reader.pos;
            // Work on a scratch node so a failed branch leaves nothing behind.
            const scratch: Decoded = {
              rule: node.rule,
              values: new Map(),
              items: new Map(),
              annotations: new Map(),
            };
            try {
              this.decodeItems(branch, reader, scope, scratch, state, options, path);
              for (const [k, v] of scratch.values) {
                node.values.set(k, v);
                scope.set(k, v);
              }
              for (const [k, v] of scratch.items) node.items.set(k, v);
              for (const [k, v] of scratch.annotations) node.annotations.set(k, v);
              ok = true;
              break;
            } catch (error) {
              lastError = error;
              reader.pos = saved;
            }
          }
          if (!ok) throw lastError;
          break;
        }

        case 'repeat': {
          const count = evaluate(item.count, scope, sum);
          const collected: Decoded[] = [];
          const scalars: number[] = [];

          for (let i = 0; i < count; i++) {
            if (item.terminator !== undefined && item.body.kind === 'var') {
              if (reader.remaining < item.body.width) break;
              const value = reader.read(item.body.width);
              if (value === item.terminator) break;
              scalars.push(value);
              continue;
            }
            if (item.body.kind === 'var') {
              scalars.push(reader.read(item.body.width));
              continue;
            }
            if (item.body.kind === 'rule') {
              collected.push(
                this.decodeRule(this.requireRule(item.body.rule), reader, scope, state, options, path),
              );
            }
          }

          if (item.body.kind === 'var') {
            // A terminated byte run is a string; keep both forms.
            node.values.set(`${item.body.name}$length`, scalars.length);
            node.items.set(
              item.body.name,
              scalars.map((v) => ({
                rule: 'scalar',
                values: new Map([['value', v]]),
                items: new Map(),
                annotations: new Map(),
              })),
            );
          } else if (item.body.kind === 'rule' && item.body.item) {
            node.items.set(item.body.item, collected);
          }
          break;
        }

        case 'label':
          scope.setLabel(item.name, reader.pos);
          break;

        case 'messageId':
          state.messageId = item.id;
          break;

        case 'annotation':
          node.annotations.set(item.name, item.value);
          break;

        case 'fail':
          throw new Pdl2DecodeError('reached an explicit fail', path);
      }
    }
  }
}

/** Plain-object shape accepted by the encoder. */
export type MessageInit = {
  [field: string]: number | string | number[] | MessageInit | MessageInit[];
};

export class Pdl2EncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Pdl2EncodeError';
  }
}

export class Pdl2Encoder {
  private readonly grammar: Grammar;

  constructor(grammar: Grammar) {
    this.grammar = grammar;
  }

  encode(data: MessageInit, startRule?: string): Uint8Array {
    const writer = new BitWriter();
    const rule = this.requireRule(startRule ?? this.grammar.start);
    this.encodeRule(rule, data, writer, new Scope(null));
    return writer.toBytes();
  }

  private requireRule(name: string): Rule {
    const rule = this.grammar.rules.get(name);
    if (!rule) throw new Pdl2EncodeError(`no such rule: ${name}`);
    return rule;
  }

  private encodeRule(rule: Rule, data: MessageInit, writer: BitWriter, parent: Scope): void {
    if (rule.alignment) writer.align(rule.alignment);
    this.encodeItems(rule.body, data, writer, new Scope(parent));
  }

  private encodeItems(
    items: Item[],
    data: MessageInit,
    writer: BitWriter,
    scope: Scope,
  ): void {
    const sum = (from: number, to: number, unit: number) => writer.sumRange(from, to, unit);

    for (const item of items) {
      switch (item.kind) {
        case 'const':
          writer.write(item.value, item.width);
          break;

        case 'var': {
          let value: number;
          const supplied = data[item.name];

          if (item.value) {
            // Computed fields (checksums, derived flags) always win.
            value = evaluate(item.value, scope, sum);
          } else if (typeof supplied === 'number') {
            value = supplied;
          } else {
            throw new Pdl2EncodeError(`missing value for field ${item.name}`);
          }

          scope.set(item.name, value);
          if (!item.implicit) {
            writer.write(value & ((1 << item.width) - 1), item.width);
          }
          break;
        }

        case 'rule': {
          const target = this.requireRule(item.rule);
          const child = item.item === '' ? data : (data[item.item] as MessageInit | undefined);
          if (child === undefined) {
            if (item.optional) break;
            throw new Pdl2EncodeError(`missing nested value for ${item.rule}$${item.item}`);
          }
          this.encodeRule(target, child, writer, scope);
          break;
        }

        case 'switch': {
          const selector = evaluate(item.selector, scope, sum);
          const matched = item.cases.find((c) => c.value === selector);
          if (matched) {
            this.encodeItems(matched.body, data, writer, scope);
          } else if (item.fallback === 'fail') {
            throw new Pdl2EncodeError(
              `no case for selector value 0x${selector.toString(16)}`,
            );
          } else if (Array.isArray(item.fallback)) {
            this.encodeItems(item.fallback, data, writer, scope);
          }
          break;
        }

        case 'alt':
          // Deterministic choice is not recoverable from the data alone, so
          // the first branch is taken; callers needing the other branch should
          // encode its rule directly.
          this.encodeItems(item.alternatives[0], data, writer, scope);
          break;

        case 'repeat': {
          if (item.body.kind === 'var') {
            const values = (data[item.body.name] as number[] | undefined) ?? [];
            for (const value of values) writer.write(value, item.body.width);
            if (item.terminator !== undefined) {
              writer.write(item.terminator, item.body.width);
            }
          } else if (item.body.kind === 'rule') {
            const list = (data[item.body.item] as MessageInit[] | undefined) ?? [];
            const target = this.requireRule(item.body.rule);
            for (const entry of list) this.encodeRule(target, entry, writer, scope);
          }
          break;
        }

        case 'label':
          scope.setLabel(item.name, writer.pos);
          break;

        case 'messageId':
        case 'annotation':
          break;

        case 'fail':
          throw new Pdl2EncodeError('reached an explicit fail');
      }
    }
  }
}

/** Convenience: read a terminated byte run back as a string. */
export function decodedString(node: Decoded, field: string): string {
  const chars = node.items.get(field);
  if (!Array.isArray(chars)) return '';
  return chars.map((c) => String.fromCharCode(c.values.get('value')!)).join('');
}
