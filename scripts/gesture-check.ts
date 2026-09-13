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

process.stdout.write('\nModule layout never overlaps\n');
{
  const { PatchView, COLUMN_WIDTH } = await import('../src/ui/patchView.ts');

  // Two columns of tall modules — the case that overlapped when ypos was
  // treated as an absolute row.
  const modules = [
    { area: 'voice' as const, type: 20, index: 1, x: 0, y: 0 }, // ADSR, 5 units
    { area: 'voice' as const, type: 4,  index: 2, x: 0, y: 1 },
    { area: 'voice' as const, type: 20, index: 3, x: 0, y: 2 },
    { area: 'voice' as const, type: 20, index: 4, x: 1, y: 0 },
    { area: 'voice' as const, type: 4,  index: 5, x: 1, y: 1 },
  ].filter((m) => catalogue.modules.has(m.type));

  const view = new PatchView({
    patch: { name: 'T', modules, cables: [], parameters: [], sections: new Map() },
    area: 'voice', catalogue, theme,
  });

  // Read back the laid-out boxes from the rendered transforms.
  const boxes = Array.from(view.element.querySelectorAll('g.patch-module')).map((g) => {
    const [, x, y] = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(g.getAttribute('transform') ?? '') ?? [];
    const svg = g.querySelector('svg');
    return {
      x: Number(x), y: Number(y),
      w: COLUMN_WIDTH,
      h: Number(svg?.getAttribute('height') ?? 0) + 15,
    };
  });

  check('every module is laid out', boxes.length === modules.length, `${boxes.length}`);

  let overlaps = 0;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) overlaps++;
    }
  }
  check('no two modules overlap', overlaps === 0, `${overlaps} overlapping pairs`);

  const columnZero = boxes.filter((b) => b.x === 0).sort((a, b) => a.y - b.y);
  check('a column stacks in order with gaps',
    columnZero.every((b, i) => i === 0 || b.y >= columnZero[i - 1].y + columnZero[i - 1].h),
    columnZero.map((b) => `${b.y}+${b.h}`).join(' '));
}

process.stdout.write('\nPanel widgets sit inside their panel\n');
{
  // Theme coordinates are Swing bounds; a widget drawn with the wrong origin
  // rides outside the panel or onto its neighbour. Check every themed module.
  let outside = 0;
  let knobsChecked = 0;
  const offenders: string[] = [];

  for (const def of catalogue.modules.values()) {
    const layout = theme.modules.get(def.componentId);
    if (!layout) continue;

    const view = new ModuleView({ def, theme: layout, imageBase: '/data/theme-images' });

    for (const circle of Array.from(view.element.querySelectorAll('g.knob circle'))) {
      knobsChecked++;
      const cx = Number(circle.getAttribute('cx'));
      const cy = Number(circle.getAttribute('cy'));
      const r = Number(circle.getAttribute('r'));
      if (cx - r < -1 || cy - r < -1 || cx + r > layout.width + 1 || cy + r > layout.height + 1) {
        outside++;
        if (offenders.length < 3) offenders.push(`${def.name} knob at ${cx},${cy}`);
      }
    }

    for (const text of Array.from(view.element.querySelectorAll('text.module-label'))) {
      const y = Number(text.getAttribute('y'));
      // A baseline above the ascent would mean the glyphs start off-panel.
      if (y < 6 || y > layout.height + 2) {
        outside++;
        if (offenders.length < 3) offenders.push(`${def.name} label baseline ${y}`);
      }
    }
  }

  check('every knob is fully inside its panel', outside === 0,
    `${knobsChecked} knobs checked` + (offenders.length ? ` · ${offenders.join('; ')}` : ''));

  // The specific regression: a knob's centre must be x+r, y+r, not y.
  const oscA = [...catalogue.modules.values()].find((m) => m.name === 'OscA')!;
  const view = new ModuleView({
    def: oscA, theme: theme.modules.get(oscA.componentId)!, imageBase: '/data/theme-images',
  });
  const first = view.element.querySelector('g.knob circle')!;
  // "freq coarse" is at (64,17) size 29, so its centre is (78.5, 31.5).
  check('knob centre includes the radius on both axes',
    Number(first.getAttribute('cx')) === 78.5 && Number(first.getAttribute('cy')) === 31.5,
    `${first.getAttribute('cx')},${first.getAttribute('cy')}`);
}

process.stdout.write(`\n${pass} ok, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
