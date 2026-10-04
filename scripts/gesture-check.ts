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
const { createPatch } = await import('../src/model/patch.ts');

const read = (n: string) =>
  readFileSync(new URL(`../public/data/${n}`, import.meta.url), 'utf8');

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = '') {
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}\n`);
  ok ? pass++ : fail++;
}

const catalogue = parseModuleCatalogue(read('modules.xml'));
const theme = parseTheme(read('classic-theme.xml'));

process.stdout.write('\nRight-click on a control opens the knob menu, and badges show\n');
{
  const def = catalogue.modules.get(20)!;           // ADSR
  const layout = theme.modules.get('m20')!;
  const menus: string[] = [];
  const view = new ModuleView({
    def, theme: layout, imageBase: '/data/theme-images',
    onParameterMenu: (parameter) => menus.push(parameter.name),
  });

  const knob = view.element.querySelector('g.knob')!;
  const event = new (document.defaultView as any).Event('contextmenu', { bubbles: true, cancelable: true });
  knob.dispatchEvent(event);
  check('a right-clicked knob reports its parameter', menus.length === 1, menus.join(','));
  check('the browser menu is suppressed', event.defaultPrevented === true);

  const knobs = Array.from(view.element.querySelectorAll('g.knob'));
  const firstId = def.parameters.find((p) => p.name === menus[0])!.componentId;
  view.setBadge(firstId, 'K2');
  const badges = () => Array.from(view.element.querySelectorAll('g.knob-badge'));
  check('a badge is drawn', badges().length === 1 && badges()[0].textContent === 'K2',
    badges().map((b) => b.textContent).join(','));
  check('the badge sits above the controls', view.element.lastElementChild === badges()[0]);
  view.setBadge(firstId, 'K3');
  check('re-badging replaces rather than stacks', badges().length === 1 && badges()[0].textContent === 'K3');
  view.setBadge(firstId, null);
  check('a null badge clears it', badges().length === 0);
  check('every ADSR knob takes a menu', knobs.length === 4, `${knobs.length}`);
}

process.stdout.write('\nDeleting a module takes its cables with it\n');
{
  const { PatchView } = await import('../src/ui/patchView.ts');
  const events: string[] = [];
  const patch = createPatch({
    name: 'T',
    modules: [
      { area: 'voice' as const, type: 7, index: 1, x: 0, y: 0 },   // OscA
      { area: 'voice' as const, type: 20, index: 2, x: 0, y: 6 },  // ADSR
      { area: 'voice' as const, type: 4, index: 3, x: 1, y: 0 },   // 2Output
    ],
    cables: [
      { area: 'voice' as const, color: 0, sourceModule: 1, sourceConnector: 0, sourceIsOutput: 1, destModule: 3, destConnector: 0 },
      { area: 'voice' as const, color: 1, sourceModule: 2, sourceConnector: 0, sourceIsOutput: 1, destModule: 1, destConnector: 1 },
      { area: 'voice' as const, color: 0, sourceModule: 2, sourceConnector: 0, sourceIsOutput: 1, destModule: 3, destConnector: 1 },
    ],
  });
  const view = new PatchView({
    patch, area: 'voice', catalogue, theme,
    onCableDelete: (c) => events.push(`cable ${c.sourceModule}->${c.destModule}`),
    onModuleDelete: (m) => events.push(`module ${m.index}`),
    onModuleMenu: (m) => events.push(`menu ${m.index}`),
    onParameterMenu: () => events.push('knob menu'),
  });

  const Event = (document.defaultView as any).Event;
  const adsr = view.element.querySelector('g.patch-module[data-module-index="2"]')!;
  adsr.querySelector('rect')!.dispatchEvent(new Event('contextmenu', { bubbles: true, cancelable: true }));
  adsr.querySelector('g.knob')!.dispatchEvent(new Event('contextmenu', { bubbles: true, cancelable: true }));
  check('right-click on the panel opens the module menu; on a knob, only the knob menu',
    events.join(' | ') === 'menu 2 | knob menu', events.join(' | '));

  events.length = 0;
  check('removing a module reports success', view.removeModule(1) === true);
  check('its cables are cut first, each reported, then the module',
    events.join(' | ') === 'cable 1->3 | cable 2->1 | module 1', events.join(' | '));
  check('it is gone from the canvas', !view.element.querySelector('g.patch-module[data-module-index="1"]'));
  check('only cables not touching it remain', patch.cables.length === 1 && patch.cables[0].sourceModule === 2,
    `${patch.cables.length} left`);
  check('removing it again does nothing', view.removeModule(1) === false);
}

process.stdout.write('\nModule toolbar renders the original\'s tabs and groups\n');
{
  const { ModuleToolbar } = await import('../src/ui/moduleToolbar.ts');
  const layout = JSON.parse(read('module-toolbar.json'));
  const picked: string[] = [];
  const toolbar = new ModuleToolbar({
    layout, catalogue, dataBase: '/data', onPick: (def) => picked.push(def.name),
  });
  const tabs = Array.from(toolbar.element.querySelectorAll('.module-tab'));
  check('ten tabs', tabs.length === 10, tabs.map((t) => t.textContent).join(' '));

  toolbar.show('Env');
  const row = () => Array.from(toolbar.element.querySelector('.module-row')!.children);
  const env = row().map((n) => n.classList.contains('module-separator') ? '|' : n.getAttribute('aria-label'));
  check('Env in the original order, with its separator',
    env.join(' ') === 'ADSR AD-Env Mod-Env AHD Multi-Env | EnvFollower', env.join(' '));
  check('buttons carry their icon',
    row().filter((n) => n.tagName === 'BUTTON').every((b) => b.querySelector('img')?.getAttribute('src')?.startsWith('/data/img/icons/16x16/')));
  check('only the chosen tab is selected',
    tabs.filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.textContent).join() === 'Env');

  (row()[0] as HTMLElement).click();
  check('a button reports its module', picked.join() === 'ADSR', picked.join());
}

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

process.stdout.write('\nModules sit on the grid exactly as the original places them\n');
{
  const { PatchView, COLUMN_WIDTH, ROW_HEIGHT } = await import('../src/ui/patchView.ts');

  // ypos is an absolute row (PBasicModuleMetrics: screenY = ypos * gridHeight),
  // so gaps in the patch are real and must survive. ADSR is 5 rows tall.
  const modules = [
    { area: 'voice' as const, type: 20, index: 1, x: 0, y: 0 },
    { area: 'voice' as const, type: 4,  index: 2, x: 0, y: 9 },  // gap of 4 rows
    { area: 'voice' as const, type: 20, index: 3, x: 2, y: 3 },  // empty column 1
  ];
  const patch = createPatch({ name: 'T', modules });
  const view = new PatchView({ patch, area: 'voice', catalogue, theme });

  const boxes = new Map(Array.from(view.element.querySelectorAll('g.patch-module')).map((g) => {
    const [, x, y] = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(g.getAttribute('transform') ?? '') ?? [];
    return [Number(g.getAttribute('data-module-index')), { x: Number(x), y: Number(y) }];
  }));
  check('every module is drawn', boxes.size === 3, `${boxes.size}`);
  check('placed at xpos * 255, ypos * 15, with nothing added',
    modules.every((m) => boxes.get(m.index)?.x === m.x * COLUMN_WIDTH &&
      boxes.get(m.index)?.y === m.y * ROW_HEIGHT),
    [...boxes].map(([i, b]) => `#${i}@${b.x},${b.y}`).join(' '));
  check('the gap below the first module is kept', boxes.get(2)?.y === 135, `${boxes.get(2)?.y}`);
  check('no title strip makes a module taller than its rows',
    view.element.querySelectorAll('.module-strip').length === 0, '');
  check('the module name is on the panel',
    Array.from(view.element.querySelectorAll('text.panel-title')).map((t) => t.textContent).join(',') ===
      'ADSR,2Output,ADSR', '');
  check('nothing overlaps here', view.overlapCount === 0, `${view.overlapCount}`);

  // A patch written as ranks (0, 1, 2) by the earlier version of this editor.
  const ranked = [
    { area: 'voice' as const, type: 20, index: 1, x: 0, y: 0 },
    { area: 'voice' as const, type: 20, index: 2, x: 0, y: 1 },
    { area: 'voice' as const, type: 4,  index: 3, x: 0, y: 2 },
  ];
  const sent: string[] = [];
  const rankedView = new PatchView({
    patch: createPatch({ name: 'T', modules: ranked }), area: 'voice', catalogue, theme,
    onModuleMove: (m, x, y) => sent.push(`#${m.index}->${x},${y}`),
  });
  check('rank-written positions are detected as overlapping', rankedView.overlapCount === 3,
    `${rankedView.overlapCount} pairs`);
  const moved = rankedView.fixOverlaps();
  check('spreading them out stacks them in order, edge to edge',
    ranked.map((m) => m.y).join() === '0,5,10' && moved === 2, `${ranked.map((m) => m.y).join()}`);
  check('every move is sent to the device', sent.join(' ') === '#2->0,5 #3->0,10', sent.join(' '));
  check('and then nothing overlaps', rankedView.overlapCount === 0, '');
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
