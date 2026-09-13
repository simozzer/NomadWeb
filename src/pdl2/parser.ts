import type { BinaryOp, Expr, Grammar, Item, Rule, SwitchCase } from './ast.ts';

type TokenKind = 'ident' | 'number' | 'string' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  text: string;
  value?: number;
  line: number;
}

// Longest-first, so ':=' wins over ':' and '$$' over '$'.
const PUNCT = [
  ':=', '>>', '<<', '$$',
  ':', ';', '%', '=', '$', '?', '*', '/', '(', ')', '{', '}', '|', '@', '[', ']',
  '&', '^', '+', '-', '~', ',',
];

export class Pdl2SyntaxError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = 'Pdl2SyntaxError';
    this.line = line;
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;

  while (i < source.length) {
    const ch = source[i];

    if (ch === '\n') { line++; i++; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }

    // Comments: block and line.
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (let j = i; j < stop; j++) if (source[j] === '\n') line++;
      i = stop;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      let text = '';
      while (j < source.length && source[j] !== '"') {
        text += source[j] === '\\' ? source[++j] : source[j];
        j++;
      }
      tokens.push({ kind: 'string', text, line });
      i = j + 1;
      continue;
    }

    if (/[0-9]/.test(ch)) {
      const rest = source.slice(i);
      const hex = /^0[xX][0-9a-fA-F]+/.exec(rest);
      const match = hex ?? /^[0-9]+/.exec(rest)!;
      tokens.push({
        kind: 'number',
        text: match[0],
        value: hex ? parseInt(match[0], 16) : parseInt(match[0], 10),
        line,
      });
      i += match[0].length;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i))!;
      tokens.push({ kind: 'ident', text: match[0], line });
      i += match[0].length;
      continue;
    }

    const punct = PUNCT.find((p) => source.startsWith(p, i));
    if (punct) {
      tokens.push({ kind: 'punct', text: punct, line });
      i += punct.length;
      continue;
    }

    throw new Pdl2SyntaxError(`unexpected character ${JSON.stringify(ch)}`, line);
  }

  tokens.push({ kind: 'eof', text: '<eof>', line });
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private get current(): Token {
    return this.tokens[this.pos];
  }

  private at(text: string): boolean {
    return this.current.kind !== 'string' && this.current.text === text;
  }

  private atIdent(text: string): boolean {
    return this.current.kind === 'ident' && this.current.text === text;
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expect(text: string): Token {
    if (!this.at(text)) {
      throw new Pdl2SyntaxError(
        `expected ${JSON.stringify(text)} but found ${JSON.stringify(this.current.text)}`,
        this.current.line,
      );
    }
    return this.next();
  }

  private expectNumber(): number {
    if (this.current.kind !== 'number') {
      throw new Pdl2SyntaxError(
        `expected a number but found ${JSON.stringify(this.current.text)}`,
        this.current.line,
      );
    }
    return this.next().value!;
  }

  parseGrammar(): Grammar {
    let start = '';
    const rules = new Map<string, Rule>();

    while (this.current.kind !== 'eof') {
      if (this.atIdent('start')) {
        this.next();
        start = this.next().text;
        this.expect(';');
        continue;
      }
      const rule = this.parseRule();
      rules.set(rule.name, rule);
    }

    if (!start) throw new Pdl2SyntaxError('grammar has no start declaration', 0);
    return { start, rules };
  }

  private parseRule(): Rule {
    const name = this.next().text;
    let alignment: number | undefined;

    // Rule-level bit alignment, as in `Section % 8 :=`.
    if (this.at('%')) {
      this.next();
      alignment = this.expectNumber();
    }

    this.expect(':=');
    const body = this.parseItems(() => this.at(';'));
    this.expect(';');
    return { name, alignment, body };
  }

  private parseItems(stop: () => boolean): Item[] {
    const items: Item[] = [];
    while (!stop() && this.current.kind !== 'eof') {
      items.push(this.parseItem());
    }
    return items;
  }

  private parseItem(): Item {
    const token = this.current;

    if (token.kind === 'punct') {
      switch (token.text) {
        case '@': {
          this.next();
          return { kind: 'label', name: this.next().text };
        }
        case '%': {
          // Implicit variable with a computed value, e.g. `%first:1 = (cc&1)`.
          this.next();
          const name = this.next().text;
          this.expect(':');
          const width = this.expectNumber();
          let value: Expr | undefined;
          if (this.at('=')) {
            this.next();
            value = this.parseExpr();
          }
          return { kind: 'var', name, width, implicit: true, value };
        }
        case '?':
          this.next();
          return this.parseRuleRef(true);
        case '(':
          return this.parseAlternatives();
        case '{': {
          // A bare block just groups items; model it as a single-branch alt.
          this.next();
          const body = this.parseItems(() => this.at('}'));
          this.expect('}');
          return { kind: 'alt', alternatives: [body] };
        }
        default:
          throw new Pdl2SyntaxError(
            `unexpected ${JSON.stringify(token.text)}`,
            token.line,
          );
      }
    }

    if (token.kind === 'number') {
      // Either a constant such as `0xf0:8`, or a counted repeat such as `16*chars:8/0`.
      const value = this.expectNumber();
      if (this.at('*')) {
        this.next();
        return this.parseRepeatBody({ kind: 'num', value });
      }
      this.expect(':');
      const width = this.expectNumber();
      return { kind: 'const', value, width };
    }

    if (token.kind === 'ident') {
      if (token.text === 'switch') return this.parseSwitch();
      if (token.text === 'fail') { this.next(); return { kind: 'fail' }; }
      if (token.text === 'messageId') {
        this.next();
        this.expect('(');
        const id = this.next().text;
        this.expect(')');
        return { kind: 'messageId', id };
      }

      const name = this.next().text;

      // A constant annotation, e.g. `manufacturer := "Clavia Digital Instruments"`.
      if (this.at(':=')) {
        this.next();
        return { kind: 'annotation', name, value: this.next().text };
      }

      // A repeat driven by a previously read field, e.g. `nmodules*Module$modules`.
      if (this.at('*')) {
        this.next();
        return this.parseRepeatBody({ kind: 'ref', name });
      }

      // A named bit field, e.g. `cc:5`.
      if (this.at(':')) {
        this.next();
        const width = this.expectNumber();
        let value: Expr | undefined;
        if (this.at('=')) {
          this.next();
          value = this.parseExpr();
        }
        return { kind: 'var', name, width, implicit: false, value };
      }

      // Otherwise a rule reference: back up and let parseRuleRef read the name.
      this.pos--;
      return this.parseRuleRef(false);
    }

    throw new Pdl2SyntaxError(
      `unexpected token ${JSON.stringify(token.text)}`,
      token.line,
    );
  }

  /** Parses what follows `N*`: either `Rule$item` or `field:width[/terminator]`. */
  private parseRepeatBody(count: Expr): Item {
    this.next();

    if (this.at(':')) {
      this.pos--;
      const name = this.next().text;
      this.expect(':');
      const width = this.expectNumber();
      let terminator: number | undefined;
      if (this.at('/')) {
        this.next();
        terminator = this.expectNumber();
      }
      return {
        kind: 'repeat',
        count,
        terminator,
        body: { kind: 'var', name, width, implicit: false },
      };
    }

    this.pos--;
    return { kind: 'repeat', count, body: this.parseRuleRef(false) };
  }

  private parseRuleRef(optional: boolean): Item {
    const rule = this.next().text;
    if (this.at('$$')) {
      this.next();
      return { kind: 'rule', rule, item: '', optional };
    }
    this.expect('$');
    return { kind: 'rule', rule, item: this.next().text, optional };
  }

  private parseAlternatives(): Item {
    this.expect('(');
    const alternatives: Item[][] = [];
    let branch: Item[] = [];
    while (!this.at(')') && this.current.kind !== 'eof') {
      if (this.at('|')) {
        this.next();
        alternatives.push(branch);
        branch = [];
        continue;
      }
      branch.push(this.parseItem());
    }
    this.expect(')');
    alternatives.push(branch);
    return { kind: 'alt', alternatives };
  }

  private parseSwitch(): Item {
    this.expect('switch');
    this.expect('(');
    const selector = this.parseBinary(0);
    this.expect(')');
    this.expect('{');

    const cases: SwitchCase[] = [];
    let fallback: 'fail' | 'none' | Item[] = 'none';

    while (!this.at('}') && this.current.kind !== 'eof') {
      if (this.atIdent('default')) {
        this.next();
        this.expect(':');
        const body = this.parseCaseBody();
        fallback = body.length === 1 && body[0].kind === 'fail' ? 'fail' : body;
        continue;
      }
      this.expect('case');
      const value = this.expectNumber();
      this.expect(':');
      cases.push({ value, body: this.parseCaseBody() });
    }

    this.expect('}');
    return { kind: 'switch', selector, cases, fallback };
  }

  /** A case body is either a braced block or a single item. */
  private parseCaseBody(): Item[] {
    if (this.at('{')) {
      this.next();
      const body = this.parseItems(() => this.at('}'));
      this.expect('}');
      return body;
    }
    return [this.parseItem()];
  }

  // ---- expressions ----

  private parseExpr(): Expr {
    if (this.at('(')) {
      this.next();
      const expr = this.parseBinary(0);
      this.expect(')');
      return expr;
    }
    return this.parseBinary(0);
  }

  private static readonly PRECEDENCE: Record<string, number> = {
    '|': 1, '^': 2, '&': 3,
    '<<': 4, '>>': 4,
    '+': 5, '-': 5,
    '*': 6, '/': 6, '%': 6,
  };

  private parseBinary(minPrecedence: number): Expr {
    let left = this.parseUnary();
    for (;;) {
      const op = this.current.text;
      const precedence = Parser.PRECEDENCE[op];
      if (
        this.current.kind !== 'punct' ||
        precedence === undefined ||
        precedence < minPrecedence
      ) {
        return left;
      }
      this.next();
      left = { kind: 'binary', op: op as BinaryOp, left, right: this.parseBinary(precedence + 1) };
    }
  }

  private parseUnary(): Expr {
    if (this.at('-') || this.at('~')) {
      const op = this.next().text as '-' | '~';
      return { kind: 'unary', op, operand: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    if (this.at('(')) {
      this.next();
      const expr = this.parseBinary(0);
      this.expect(')');
      return expr;
    }

    // Aggregate over a bit range, e.g. the checksum's `[+;0;@lblDataEnd;8;$]`.
    if (this.at('[')) {
      this.next();
      const op = this.next().text;
      if (op !== '+') {
        throw new Pdl2SyntaxError(
          `unsupported aggregate operator ${JSON.stringify(op)}`,
          this.current.line,
        );
      }
      this.expect(';');
      const from = this.parseAggregateOperand();
      this.expect(';');
      const to = this.parseAggregateOperand();
      this.expect(';');
      const unit = this.expectNumber();
      this.expect(';');
      // Trailing marker for "up to here"; the `to` operand already says it.
      if (this.at('$')) this.next();
      this.expect(']');
      return { kind: 'aggregate', op: '+', from, to, unit };
    }

    if (this.current.kind === 'number') {
      return { kind: 'num', value: this.expectNumber() };
    }

    if (this.at('@')) {
      this.next();
      return { kind: 'ref', name: '@' + this.next().text };
    }

    if (this.current.kind === 'ident') {
      return { kind: 'ref', name: this.next().text };
    }

    throw new Pdl2SyntaxError(
      `unexpected token ${JSON.stringify(this.current.text)} in expression`,
      this.current.line,
    );
  }

  private parseAggregateOperand(): Expr {
    if (this.at('@')) {
      this.next();
      return { kind: 'ref', name: '@' + this.next().text };
    }
    return { kind: 'num', value: this.expectNumber() };
  }
}

export function parsePdl2(source: string): Grammar {
  return new Parser(tokenize(source)).parseGrammar();
}
