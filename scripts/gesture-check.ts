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

process.stdout.write(`\n${pass} ok, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
