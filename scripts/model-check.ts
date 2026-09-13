import { readFileSync } from 'node:fs';
import { DOMParser } from 'linkedom';

// The model loaders target the browser; give them a DOMParser before importing.
(globalThis as any).DOMParser = DOMParser;

const { parseModuleCatalogue, controlParameters, morphParameters } = await import(
  '../src/model/modules.ts'
);
const { parseTheme } = await import('../src/model/theme.ts');
const { FormatterTable } = await import('../src/model/formatters.ts');

const read = (name: string) =>
  readFileSync(new URL(`../public/data/${name}`, import.meta.url), 'utf8');

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = '') {
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}\n`);
  ok ? pass++ : fail++;
}

process.stdout.write('\nModule catalogue (modules.xml)\n');
const catalogue = parseModuleCatalogue(read('modules.xml'));
// 110 live definitions. A raw grep finds 113 `<module` tags, but the extras are
// container references and commented-out drafts, which carry no `index`.
check('modules parsed', catalogue.modules.size === 110, `${catalogue.modules.size} modules`);
check('signal types parsed', catalogue.signals.size === 7, `${catalogue.signals.size} signals`);
check('categories found', catalogue.categories.length > 5, catalogue.categories.join(', '));

const adsr = catalogue.modules.get(20);
process.stdout.write('\nADSR (index 20), checked against the raw XML\n');
check('found by type index', adsr?.name === 'ADSR', adsr?.name);
check('6 connectors', adsr?.connectors.length === 6, `${adsr?.connectors.length}`);
check('6 controls + 6 morphs',
  controlParameters(adsr!).length === 6 && morphParameters(adsr!).length === 6,
  `${controlParameters(adsr!).length} + ${morphParameters(adsr!).length}`);
check('gate input is a logic signal',
  adsr?.connectors.find((c) => c.name === 'gate')?.signal === 'logic',
  adsr?.connectors.find((c) => c.name === 'gate')?.signal);
check('sustain defaults to 64',
  controlParameters(adsr!).find((p) => p.name === 'sustain')?.defaultValue === 64, '');
check('invert is a 0..1 switch',
  controlParameters(adsr!).find((p) => p.name === 'invert')?.maxValue === 1, '');
check('morph range is signed',
  morphParameters(adsr!).find((p) => p.name === 'morph:attack')?.minValue === -127, '');
check('background colour carried', adsr?.background === '#f6e2b8', adsr?.background);
check('one LED', adsr?.lights.length === 1, `${adsr?.lights.length}`);

process.stdout.write('\nTheme (classic-theme.xml)\n');
const theme = parseTheme(read('classic-theme.xml'));
check('module layouts parsed', theme.modules.size === 109, `${theme.modules.size} layouts`);
check('stylesheet captured', theme.css.includes('cAUDIO'), `${theme.css.length} chars`);

// Every module that has a panel must have a layout. The one exception is
// `morph`, a pseudo-module representing morph assignments rather than hardware.
const unthemed = Array.from(catalogue.modules.values())
  .filter((def) => !theme.modules.has(def.componentId))
  .map((def) => def.componentId);
check('only `morph` lacks a layout',
  unthemed.length === 1 && unthemed[0] === 'morph', unthemed.join(', ') || 'none');

const adsrTheme = theme.modules.get('m20');
process.stdout.write('\nADSR layout, checked against the raw XML\n');
check('panel is 255x75', adsrTheme?.width === 255 && adsrTheme?.height === 75,
  `${adsrTheme?.width}x${adsrTheme?.height}`);
const knobs = adsrTheme!.widgets.filter((w) => w.kind === 'knob');
check('4 knobs (A, D, S, R)', knobs.length === 4, `${knobs.length}`);
check('first knob at x=64 y=51 size=21',
  knobs[0].x === 64 && knobs[0].y === 51 && knobs[0].size === 21,
  `x=${knobs[0].x} y=${knobs[0].y} size=${knobs[0].size}`);
check('knobs bind to parameters',
  knobs.every((k) => k.parameterId), knobs.map((k) => k.parameterId).join(','));
check('6 connectors laid out',
  adsrTheme!.widgets.filter((w) => w.kind === 'connector').length === 6, '');
check('attack-shape button has 3 image faces',
  adsrTheme!.widgets.find((w) => w.kind === 'button' && w.faces?.length === 3)
    ?.faces?.every((f) => f.image?.endsWith('.png')) === true, '');

// Every widget binding must resolve against the catalogue, or the panel would
// render controls wired to nothing.
process.stdout.write('\nCross-check: every theme binding resolves\n');
let dangling = 0;
let bound = 0;
for (const [componentId, layout] of theme.modules) {
  const def = catalogue.byComponentId.get(componentId);
  if (!def) { dangling++; continue; }
  const paramIds = new Set(def.parameters.map((p) => p.componentId));
  const connIds = new Set(def.connectors.map((c) => c.componentId));
  for (const widget of layout.widgets) {
    if (widget.parameterId) {
      bound++;
      if (!paramIds.has(widget.parameterId)) {
        if (dangling < 5) process.stdout.write(`       ${def.name}: no parameter ${widget.parameterId}\n`);
        dangling++;
      }
    }
    if (widget.connectorId) {
      bound++;
      if (!connIds.has(widget.connectorId)) {
        if (dangling < 5) process.stdout.write(`       ${def.name}: no connector ${widget.connectorId}\n`);
        dangling++;
      }
    }
  }
}
check('no dangling bindings', dangling === 0, `${bound} bindings checked, ${dangling} dangling`);

process.stdout.write('\nFormatters (nmformat.js)\n');
const formatters = new FormatterTable(read('nmformat.js'));
const referenced = new Set<string>();
for (const def of catalogue.modules.values()) {
  for (const p of def.parameters) if (p.formatter) referenced.add(p.formatter);
}
const unresolved = Array.from(referenced).filter((r) => formatters.get(r) === null);
check('every referenced formatter compiles',
  unresolved.length === 0,
  `${referenced.size} referenced${unresolved.length ? `, unresolved: ${unresolved.join(', ')}` : ''}`);

process.stdout.write(`  sample: fmtOffOn(0)=${formatters.format('fmtOffOn', 0)}, ` +
  `fmtOffOn(1)=${formatters.format('fmtOffOn', 1)}, ` +
  `fmtAdsrTime(64)=${formatters.format('fmtAdsrTime', 64)}, ` +
  `fmtNote(60)=${formatters.format('fmtNote', 60)}, ` +
  `"value-64"(100)=${formatters.format('value-64', 100)}\n`);

process.stdout.write(`\n${pass} ok, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
