/**
 * Bridge to `nmformat.js`.
 *
 * That file is Nomad's original parameter-display logic, written as plain ES3
 * for the Rhino interpreter the Java build embedded. It has no Java or Rhino
 * dependencies, so it runs unmodified here — the tables mapping a raw 0-127
 * parameter to "1.2 kHz" or "Sine" are carried over rather than reimplemented.
 *
 * `modules.xml` names a formatter either as a function (`fmtAdsrTime`) or as a
 * small inline expression over `value` (`value+1`, `value-64`).
 */

export type Formatter = (value: number) => string;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export class FormatterTable {
  private readonly cache = new Map<string, Formatter | null>();
  private readonly source: string;

  constructor(nmformatSource: string) {
    this.source = nmformatSource;
  }

  /**
   * Resolves a formatter reference to a callable.
   * Returns `null` when the reference cannot be compiled, so callers can fall
   * back to showing the raw value rather than breaking the panel.
   */
  get(reference: string | undefined): Formatter | null {
    if (!reference) return null;

    const cached = this.cache.get(reference);
    if (cached !== undefined) return cached;

    const formatter = this.compile(reference);
    this.cache.set(reference, formatter);
    return formatter;
  }

  format(reference: string | undefined, value: number): string {
    const formatter = this.get(reference);
    if (!formatter) return String(value);
    try {
      const result = formatter(value);
      return result === undefined || result === null ? String(value) : String(result);
    } catch {
      return String(value);
    }
  }

  private compile(reference: string): Formatter | null {
    // A bare identifier names a function defined in nmformat.js; anything else
    // is an expression over `value`.
    const body = IDENTIFIER.test(reference)
      ? `${this.source}\n;return typeof ${reference} === 'function' ? ${reference}(value) : undefined;`
      : `${this.source}\n;return (${reference});`;

    try {
      const fn = new Function('value', body) as Formatter;
      // Compile-time success is not enough; a bad reference only shows up on call.
      fn(0);
      return fn;
    } catch {
      return null;
    }
  }
}

export async function loadFormatters(url: string): Promise<FormatterTable> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not load ${url}: ${response.status}`);
  return new FormatterTable(await response.text());
}
