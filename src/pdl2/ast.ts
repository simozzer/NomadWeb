/** AST for JPDL2 — the packet-description language used by Nomad's codecs. */

export type Expr =
  | { kind: 'num'; value: number }
  | { kind: 'ref'; name: string }
  | { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr }
  | { kind: 'unary'; op: '-' | '~'; operand: Expr }
  /**
   * Aggregate over a bit range, written `[+;0;@label;8;$]`:
   * fold `op` over `unit`-bit words from `from` to `to`.
   * The trailing `$` marks the current position as the implicit terminator.
   */
  | { kind: 'aggregate'; op: '+'; from: Expr; to: Expr; unit: number };

export type BinaryOp =
  | '+' | '-' | '*' | '/' | '%'
  | '&' | '|' | '^'
  | '<<' | '>>';

export type Item =
  /** A fixed bit pattern that must match on read and is emitted on write: `0xf0:8`. */
  | { kind: 'const'; value: number; width: number }
  /** A named field: `cc:5`, optionally computed: `checksum:7 = (expr)`. */
  | { kind: 'var'; name: string; width: number; implicit: boolean; value?: Expr }
  /** A nested rule: `IAm$data`; `item` is `''` for the inline form `Rule$$`. */
  | { kind: 'rule'; rule: string; item: string; optional: boolean }
  /** `switch (expr) { case N: ... default: fail }` */
  | { kind: 'switch'; selector: Expr; cases: SwitchCase[]; fallback: 'fail' | 'none' | Item[] }
  /** `( A$$ | B$$ )` — first alternative that parses wins. */
  | { kind: 'alt'; alternatives: Item[][] }
  /**
   * Repetition. `count` is the bound (literal or variable);
   * `terminator` set means "read until this value" as in `16*chars:8/0`.
   */
  | { kind: 'repeat'; count: Expr; body: Item; terminator?: number }
  /** `@name` — records the current bit position for later aggregates. */
  | { kind: 'label'; name: string }
  /** `messageId("iam")` — tags the decoded message. */
  | { kind: 'messageId'; id: string }
  /** `manufacturer := "Clavia Digital Instruments"` — a constant annotation. */
  | { kind: 'annotation'; name: string; value: string }
  /** `fail` — unconditional parse failure. */
  | { kind: 'fail' };

export interface SwitchCase {
  /** Match values; a `case` block may carry several items. */
  value: number;
  body: Item[];
}

export interface Rule {
  name: string;
  /** From `Section % 8 :=` — align the cursor before parsing the rule. */
  alignment?: number;
  body: Item[];
}

export interface Grammar {
  start: string;
  rules: Map<string, Rule>;
}
