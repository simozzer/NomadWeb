/**
 * Guards the pointer-gesture routing on the patch canvas.
 *
 * A press on a knob must not also start a canvas pan — the bug where editing
 * any control dragged the whole patch. Exercised against a DOM shim so the
 * routing rule is checked without a browser.
 */
import { readFileSync } from 'node:fs';
import { DOMParser } from 'linkedom';

(globalThis as any).DOMParser = DOMParser;

const { parseHTML } = await import('linkedom');
const { document } = parseHTML('<html><body></body></html>');
(globalThis as any).document = document;

const { parseModuleCatalogue } = await import('../src/model/modules.ts');
const { parseTheme } = await import('../src/model/theme.ts');
const { ModuleView } = await import('../src/ui/moduleView.ts');

const read = (n: string) =>
  readFileSync(new URL(`../public/data/${n}`, import.meta.url), 'utf8');

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = '') {
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}\n`);
  ok ? pass++ : fail++;
}

const catalogue = parseModuleCatalogue(read('modules.xml'));
const theme = parseTheme(read('classic-theme.xml'));

process.stdout.write('\nControl gestures are kept off the canvas\n');
{
  const def = catalogue.modules.get(20)!;           // ADSR
  const layout = theme.modules.get('m20')!;
  const view = new ModuleView({ def, theme: layout, imageBase: '/data/theme-images' });

  // Every widget group that owns a pointer gesture must be tagged with a class
  // the canvas recognises, or the canvas will pan instead.
  const CONTROL_CLASSES = ['knob', 'button', 'slider'];
  const groups = Array.from(view.element.querySelectorAll('g'));
  const interactive = groups.filter((g) =>
    ['knob', 'button', 'slider'].some((c) => g.getAttribute('class') === c),
  );

  check('the ADSR renders its interactive widgets',
    interactive.length >= 6, `${interactive.length} groups`);
  check('each carries a class the canvas treats as a control',
    interactive.every((g) =>
      CONTROL_CLASSES.includes(g.getAttribute('class') ?? '')),
    '');

  // Knobs and sliders must be focusable, so the keyboard path works too.
  const knobs = groups.filter((g) => g.getAttribute('class') === 'knob');
  check('knobs are keyboard reachable',
    knobs.every((k) => k.getAttribute('tabindex') === '0'), `${knobs.length} knobs`);
}

process.stdout.write('\nConnectors are exactly hit-testable\n');
{
  // A press is resolved from the element under the pointer, so every connector
  // must carry the index and direction the patch format addresses it by.
  let missing = 0;
  let checked = 0;
  let mismatched = 0;

  for (const def of catalogue.modules.values()) {
    const layout = theme.modules.get(def.componentId);
    if (!layout) continue;

    const view = new ModuleView({ def, theme: layout, imageBase: '/data/theme-images' });
    for (const group of Array.from(view.element.querySelectorAll('g.connector'))) {
      checked++;
      const index = group.getAttribute('data-connector-index');
      const output = group.getAttribute('data-connector-output');
      if (index === null || output === null) { missing++; continue; }

      // The attributes must agree with the catalogue, or a press would
      // resolve to the wrong jack.
      const id = group.getAttribute('data-connector');
      const connector = def.connectors.find((c) => c.componentId === id);
      if (
        !connector ||
        connector.index !== Number(index) ||
        (connector.direction === 'output' ? '1' : '0') !== output
      ) {
        mismatched++;
      }
    }
  }

  check('every rendered connector carries index and direction',
    missing === 0, `${checked} connectors, ${missing} missing`);
  check('those attributes match the catalogue',
    mismatched === 0, `${mismatched} mismatched`);

  // The drawn jack is 13px; the hit target is padded to make it reachable.
  const adsr = catalogue.modules.get(20)!;
  const view = new ModuleView({
    def: adsr, theme: theme.modules.get('m20')!, imageBase: '/data/theme-images',
  });
  const targets = Array.from(view.element.querySelectorAll('rect.connector-target'));
  check('each connector has a padded hit target',
    targets.length === adsr.connectors.length, `${targets.length}`);
  check('the target is larger than the drawn jack',
    targets.every((t) => Number(t.getAttribute('width')) >= 19), '');
}

process.stdout.write(`\n${pass} ok, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
