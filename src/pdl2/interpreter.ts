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

/** Runaway guard: a malformed packet must fail rather than spin. */
const MAX_STEPS = 2_000_000;

const NOOP = () => {};

type Continuation = () => void;

interface DecodeState {
  messageId?: string;
  steps: number;
}

interface Ctx {
  reader: BitReader;
  scope: Scope;
  node: Decoded;
  state: DecodeState;
  options: DecodeOptions;
  path: string[];
}

/** A failure that backtracking must not swallow. */
class Pdl2Fatal extends Error {}

/** Signals that an optional rule matched without consuming anything. */
class EmptyMatch extends Error {}

function newNode(rule: string): Decoded {
  return { rule, values: new Map(), items: new Map(), annotations: new Map() };
}

type NodeSnapshot = [Map<string, number>, Map<string, Decoded | Decoded[]>, Map<string, string>];

function snapshotNode(node: Decoded): NodeSnapshot {
  return [new Map(node.values), new Map(node.items), new Map(node.annotations)];
}

function restoreNode(node: Decoded, [values, items, annotations]: NodeSnapshot): void {
  node.values.clear();
  for (const [k, v] of values) node.values.set(k, v);
  node.items.clear();
  for (const [k, v] of items) node.items.set(k, v);
  node.annotations.clear();
  for (const [k, v] of annotations) node.annotations.set(k, v);
}

export class Pdl2Decoder {
  private readonly grammar: Grammar;

  constructor(grammar: Grammar) {
    this.grammar = grammar;
  }

  decode(bytes: Uint8Array, options: DecodeOptions = {}): DecodeResult {
    const reader = new BitReader(bytes);
    const state: DecodeState = { steps: 0 };
    const rule = this.requireRule(this.grammar.start);
    const root = newNode(rule.name);

    if (rule.alignment) reader.align(rule.alignment);
    this.seq(rule.body, 0, {
      reader,
      scope: new Scope(null),
      node: root,
      state,
      options,
      path: [rule.name],
    }, NOOP);

    return { root, messageId: state.messageId, bitsConsumed: reader.pos };
  }

  private requireRule(name: string): Rule {
    const rule = this.grammar.rules.get(name);
    if (!rule) throw new Pdl2DecodeError(`no such rule: ${name}`, []);
    return rule;
  }

  /**
   * Parses `items[index..]`, then calls `cont` for everything that follows it.
   *
   * Continuation-passing is what makes backtracking possible: an optional or an
   * alternative commits only once the *rest of the packet* has parsed, so a
   * choice that looks right locally but strands later fields gets retried.
   *
   * The patch list needs this. `StringList` is a recursive optional chain whose
   * final element is indistinguishable from the trailing endmarker, so a greedy
   * match swallows the endmarker and checksum and the packet fails to close.
   */
  private seq(items: Item[], index: number, ctx: Ctx, cont: Continuation): void {
    if (++ctx.state.steps > MAX_STEPS) {
      throw new Pdl2Fatal('parse did not converge');
    }
    if (index >= items.length) {
      cont();
      return;
    }
    this.item(items[index], ctx, () => this.seq(items, index + 1, ctx, cont));
  }

  private item(item: Item, ctx: Ctx, cont: Continuation): void {
    const { reader, scope, node, state, options, path } = ctx;
    const sum = (from: number, to: number, unit: number) => reader.sumRange(from, to, unit);

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
        return cont();
      }

      case 'var': {
        const override = options.overrides?.[item.name];
        let value: number;

        if (item.implicit) {
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
        return cont();
      }

      case 'rule': {
        const target = this.requireRule(item.rule);
        const start = reader.pos;

        const run = () => {
          const child = newNode(target.name);
          if (target.alignment) reader.align(target.alignment);

          this.seq(
            target.body,
            0,
            { ...ctx, scope: new Scope(scope), node: child, path: [...path, target.name] },
            () => {
              // A self-referential optional that consumed nothing would recurse
              // forever, e.g. `?StringList$next` at the end of the buffer.
              if (item.optional && reader.pos === start) throw new EmptyMatch();

              // Attach only once the child is complete, so a branch that is
              // later rolled back leaves nothing behind.
              if (item.item === '') {
                for (const [k, v] of child.values) {
                  node.values.set(k, v);
                  scope.set(k, v);
                }
                for (const [k, v] of child.items) node.items.set(k, v);
                for (const [k, v] of child.annotations) node.annotations.set(k, v);
              } else {
                node.items.set(item.item, child);
              }
              cont();
            },
          );
        };

        if (!item.optional) return run();

        const snapshot = snapshotNode(node);
        try {
          return run();
        } catch (error) {
          if (error instanceof Pdl2Fatal) throw error;
          reader.pos = start;
          restoreNode(node, snapshot);
          return cont();
        }
      }

      case 'switch': {
        const selector = evaluate(item.selector, scope, sum);
        const matched = item.cases.find((c) => c.value === selector);
        if (matched) return this.seq(matched.body, 0, ctx, cont);
        if (item.fallback === 'fail') {
          throw new Pdl2DecodeError(
            `no case for selector value 0x${selector.toString(16)}`,
            path,
          );
        }
        if (Array.isArray(item.fallback)) return this.seq(item.fallback, 0, ctx, cont);
        return cont();
      }

      case 'alt': {
        const start = reader.pos;
        const snapshot = snapshotNode(node);
        let lastError: unknown;

        for (const branch of item.alternatives) {
          try {
            return this.seq(branch, 0, ctx, cont);
          } catch (error) {
            if (error instanceof Pdl2Fatal) throw error;
            lastError = error;
            reader.pos = start;
            restoreNode(node, snapshot);
          }
        }
        throw lastError ?? new Pdl2DecodeError('no alternative matched', path);
      }

      case 'repeat': {
        const count = evaluate(item.count, scope, sum);

        if (item.body.kind === 'var') {
          const { name, width } = item.body;
          const scalars: number[] = [];
          for (let i = 0; i < count; i++) {
            if (reader.remaining < width) break;
            const value = reader.read(width);
            if (item.terminator !== undefined && value === item.terminator) break;
            scalars.push(value);
          }
          node.values.set(`${name}$length`, scalars.length);
          node.items.set(
            name,
            scalars.map((v) => {
              const scalar = newNode('scalar');
              scalar.values.set('value', v);
              return scalar;
            }),
          );
          return cont();
        }

        if (item.body.kind === 'rule') {
          const target = this.requireRule(item.body.rule);
          const collected: Decoded[] = [];
          for (let i = 0; i < count; i++) {
            const child = newNode(target.name);
            if (target.alignment) reader.align(target.alignment);
            // A counted repeat is not a choice point: the count is explicit, so
            // every element must parse where it stands.
            this.seq(
              target.body,
              0,
              { ...ctx, scope: new Scope(scope), node: child, path: [...path, target.name] },
              NOOP,
            );
            collected.push(child);
          }
          if (item.body.item) node.items.set(item.body.item, collected);
        }
        return cont();
      }

      case 'label':
        scope.setLabel(item.name, reader.pos);
        return cont();

      case 'messageId':
        state.messageId = item.id;
        return cont();

      case 'annotation':
        node.annotations.set(item.name, item.value);
        return cont();

      case 'fail':
        throw new Pdl2DecodeError('reached an explicit fail', path);
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

        case 'alt': {
          // Which branch applies is implied by the fields present: PatchHandling
          // is `(PatchModification | PatchCommand)`, and only one of them can be
          // satisfied by a given payload. Try each, rolling the writer back after
          // a partial write, and keep the first that encodes completely.
          const start = writer.pos;
          let encoded = false;
          let lastError: unknown;

          for (const branch of item.alternatives) {
            try {
              this.encodeItems(branch, data, writer, scope);
              encoded = true;
              break;
            } catch (error) {
              lastError = error;
              writer.truncate(start);
            }
          }

          if (!encoded) {
            throw new Pdl2EncodeError(
              `no alternative could be encoded from the given fields: ` +
                `${(lastError as Error)?.message ?? 'unknown reason'}`,
            );
          }
          break;
        }

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
