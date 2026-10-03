import {
  parseModuleCatalogue,
  controlParameters,
  type ModuleDef,
  type ParameterDef,
} from './model/modules.ts';
import { parseTheme, type Theme } from './model/theme.ts';
import { FormatterTable } from './model/formatters.ts';
import {
  PatchReader,
  PatchWriter,
  describeLayoutScheme,
  areaOf,
  areaBit,
  type KnobTarget,
  type Patch,
  type PatchArea,
  type PatchModule,
} from './model/patch.ts';
import type { Decoded } from './pdl2/interpreter.ts';
import { ModuleView } from './ui/moduleView.ts';
import { patchLoad, moduleCycles, formatLoad, MAX_LOAD } from './model/load.ts';
import { PatchView } from './ui/patchView.ts';
import { ModuleToolbar, type ToolbarLayout } from './ui/moduleToolbar.ts';
import { WebMidiTransport, MidiUnavailableError } from './midi/webmidi.ts';
import {
  NordModular,
  CC,
  MAX_BANKS,
  KNOB_NAMES,
  knobsFor,
  type PatchListEntry,
  type PatchDumpReport,
} from './midi/nord.ts';
import { formatSysex } from './midi/framing.ts';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const logEl = $<HTMLPreElement>('log');

function log(kind: 'in' | 'out' | 'err' | 'info', text: string): void {
  const line = document.createElement('span');
  line.className = kind;
  const time = new Date().toLocaleTimeString();
  line.textContent = `${time}  ${kind.toUpperCase().padEnd(4)} ${text}\n`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(text: string, kind: 'idle' | 'ok' | 'bad'): void {
  const el = $('device-status');
  el.textContent = text;
  el.className = `status status--${kind}`;
}

const PORT_CHOICE_KEY = 'nomad-web.ports';

/** Port ids are stable per machine, so the last working pair is worth keeping. */
function loadPortChoice(): { inputId?: string; outputId?: string } | null {
  try {
    const raw = localStorage.getItem(PORT_CHOICE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function savePortChoice(inputId: string, outputId: string): void {
  try {
    localStorage.setItem(PORT_CHOICE_KEY, JSON.stringify({ inputId, outputId }));
  } catch {
    // Storage can be unavailable (private window, blocked site data); the app
    // works without it, the picker just will not pre-select.
  }
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return response.text();
}

async function main(): Promise<void> {
  // ---- data ----
  const [modulesXml, themeXml, nmformatSrc, midiGrammar, patchGrammar, toolbarJson] = await Promise.all([
    fetchText('/data/modules.xml'),
    fetchText('/data/classic-theme.xml'),
    fetchText('/data/nmformat.js'),
    fetchText('/data/midi.pdl2'),
    fetchText('/data/patch.pdl2'),
    fetchText('/data/module-toolbar.json'),
  ]);
  const toolbarLayout = JSON.parse(toolbarJson) as ToolbarLayout;

  const catalogue = parseModuleCatalogue(modulesXml);
  const theme: Theme = parseTheme(themeXml);
  const formatters = new FormatterTable(nmformatSrc);
  const patchReader = new PatchReader(patchGrammar);
  const patchWriter = new PatchWriter(patchGrammar);

  log('info', `${catalogue.modules.size} modules, ${theme.modules.size} themed layouts`);

  // ---- MIDI ----
  const countersEl = $('counters');
  const showStream = $<HTMLInputElement>('show-stream');
  const showRaw = $<HTMLInputElement>('show-raw');

  const transport = new WebMidiTransport();
  const nord = new NordModular(transport, midiGrammar);
  let connected = false;

  // MIDI ports are exclusive. A page teardown that does not release them leaves
  // the device unopenable — which a dev server's reload-on-save hits constantly.
  const release = () => {
    nord.stop();
    transport.releaseSync();
  };
  window.addEventListener('pagehide', release);
  import.meta.hot?.dispose(release);

  nord.addListener((message, raw) => {
    const streaming = message.messageId === 'meters' || message.messageId === 'lights';
    if (streaming && !showStream.checked) return;
    log('in', `${message.messageId ?? 'unknown'}  ${formatSysex(raw, 24)}`);
  });

  // Anything that framed but would not decode is a protocol finding, not noise.
  nord.onDecodeError = (raw, error) => {
    log('err', `undecodable  ${formatSysex(raw, 24)}  ${error}`);
  };

  const portPickers = $('port-pickers');
  const inputSelect = $<HTMLSelectElement>('input-port');
  const outputSelect = $<HTMLSelectElement>('output-port');

  function refreshPorts(): void {
    const fill = (select: HTMLSelectElement, ports: { id: string; name: string }[]) => {
      const previous = select.value;
      select.replaceChildren();
      for (const port of ports) {
        const option = document.createElement('option');
        option.value = port.id;
        option.textContent = port.name;
        select.appendChild(option);
      }
      if (previous) select.value = previous;
    };
    fill(inputSelect, transport.listInputs());
    fill(outputSelect, transport.listOutputs());

    // Prefer the last working pair, then a name that looks like a Nord.
    const remembered = loadPortChoice();
    const suggestion = transport.suggestPorts();
    const pick = (select: HTMLSelectElement, remembered?: string, guess?: string) => {
      const has = (id?: string) => !!id && Array.from(select.options).some((o) => o.value === id);
      if (has(remembered)) select.value = remembered!;
      else if (has(guess)) select.value = guess!;
    };
    pick(inputSelect, remembered?.inputId, suggestion.inputId);
    pick(outputSelect, remembered?.outputId, suggestion.outputId);
  }

  transport.onPortsChanged = () => {
    refreshPorts();
    log('info', 'MIDI ports changed');
  };

  $('request-access').addEventListener('click', async () => {
    try {
      await transport.requestAccess();
      portPickers.hidden = false;
      refreshPorts();
      $('connection-hint').textContent =
        'Access granted. Choose the Nord’s ports and connect.';
      log('info', 'MIDI access granted with SysEx');
    } catch (error) {
      const message = error instanceof MidiUnavailableError
        ? error.message
        : (error as Error).message;
      $('connection-hint').textContent = message;
      setStatus('no MIDI access', 'bad');
      log('err', message);
    }
  });

  // ---- diagnostics ----
  function refreshCounters(): void {
    const framing = transport.framingStats;
    const cells: [string, string | number][] = [
      ['MIDI events in', transport.rawEventsReceived],
      ['bytes in', transport.rawBytesReceived],
      ['SysEx framed', framing.framed],
      ['truncated', framing.truncated],
      ['stray bytes', framing.stray],
    ];
    countersEl.replaceChildren();
    for (const [label, value] of cells) {
      const cell = document.createElement('div');
      cell.className = 'counter' + (label === 'bytes in' && value === 0 ? ' counter--zero' : '');
      const v = document.createElement('strong');
      v.textContent = String(value);
      const l = document.createElement('span');
      l.textContent = label;
      cell.append(v, l);
      countersEl.appendChild(cell);
    }
  }

  transport.addRawListener((data) => {
    if (showRaw.checked) log('in', `raw  ${formatSysex(data, 24)}`);
    refreshCounters();
  });

  $('probe').addEventListener('click', () => {
    try {
      const message = nord.send(CC.IAm, 0, {
        data: { sender: 0, versionHigh: 0, versionLow: 0 },
      });
      log('out', `identify request  ${formatSysex(message)}`);
    } catch (error) {
      log('err', (error as Error).message);
    }
  });

  $('clear-log').addEventListener('click', () => logEl.replaceChildren());

  $('identify').addEventListener('click', async () => {
    try {
      setStatus('identifying…', 'idle');
      const identity = await nord.identify();
      connected = true;

      // The model already shows in the status badge, so the bar carries only
      // what the badge does not.
      const identityEl = $('identity');
      identityEl.hidden = false;
      identityEl.textContent =
        `OS ${identity.version} · serial ${identity.serial} · ` +
        `${identity.slotCount} slot${identity.slotCount === 1 ? '' : 's'}`;

      setStatus(identity.deviceName, 'ok');
      log('info', `identified ${identity.deviceName}, OS ${identity.version}`);

      // The Micro Modular has one slot; the keyboard and rack have four.
      // Offering slots the device does not have would just send them nowhere.
      const slots = ['Slot A', 'Slot B', 'Slot C', 'Slot D'].slice(0, identity.slotCount);
      slotSelect.replaceChildren();
      slots.forEach((name, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = identity.slotCount === 1 ? 'Patch slot' : name;
        slotSelect.appendChild(option);
      });
      slotSelect.disabled = identity.slotCount === 1;

      $<HTMLButtonElement>('fetch-patches').disabled = false;
      $('patch-hint').textContent =
        'Ready. Reading all banks takes a moment; a single bank is quicker.';
    } catch (error) {
      connected = false;
      setStatus('identify failed', 'bad');
      log('err', (error as Error).message);
      log(
        'info',
        transport.rawBytesReceived === 0
          ? 'Nothing has arrived on the input port at all. Turn a knob on the Nord: ' +
            'if the counters stay at zero, the input port is wrong.'
          : `${transport.rawBytesReceived} bytes did arrive, so the input path works. ` +
            'The device is not answering this particular request.',
      );
    }
  });

  $('connect').addEventListener('click', async () => {
    try {
      await transport.open(inputSelect.value, outputSelect.value);
      savePortChoice(inputSelect.value, outputSelect.value);
      nord.start();
      $<HTMLButtonElement>('identify').disabled = false;
      $('diagnostics').hidden = false;
      refreshCounters();
      setStatus('ports open', 'idle');
      log(
        'info',
        `opened in="${inputSelect.selectedOptions[0]?.textContent}" ` +
          `out="${outputSelect.selectedOptions[0]?.textContent}"`,
      );
      log('info', 'Listening. Turn a knob on the Nord to confirm the input path.');
    } catch (error) {
      setStatus('could not open ports', 'bad');
      log('err', (error as Error).message);
    }
  });

  // A reload should not mean starting from scratch. If ports were opened before,
  // the SysEx permission is already granted, so this re-opens without prompting.
  if (loadPortChoice()) {
    try {
      await transport.requestAccess();
      portPickers.hidden = false;
      refreshPorts();
      $('connection-hint').textContent = 'Access granted. Choose the Nord’s ports and connect.';
      if (inputSelect.value && outputSelect.value) {
        await transport.open(inputSelect.value, outputSelect.value);
        nord.start();
        $<HTMLButtonElement>('identify').disabled = false;
        $('diagnostics').hidden = false;
        refreshCounters();
        setStatus('ports open', 'idle');
        log('info', 'reopened the previous MIDI ports after reload');
      }
    } catch (error) {
      log('info', `could not restore the previous session: ${(error as Error).message}`);
    }
  }

  // ---- patch list ----
  const bankSelect = $<HTMLSelectElement>('patch-bank');
  const fetchButton = $<HTMLButtonElement>('fetch-patches');
  const cancelButton = $<HTMLButtonElement>('cancel-patches');
  const hideEmpty = $<HTMLInputElement>('hide-empty');
  const patchListEl = $('patch-list');
  const patchHint = $('patch-hint');

  for (let bank = 0; bank < MAX_BANKS; bank++) {
    const option = document.createElement('option');
    option.value = String(bank);
    option.textContent = `Bank ${bank + 1}`;
    bankSelect.appendChild(option);
  }

  let patches: PatchListEntry[] = [];
  let cancelled = false;

  function renderPatches(): void {
    const shown = hideEmpty.checked
      ? patches.filter((p) => !p.empty && p.name)
      : patches;

    patchListEl.replaceChildren();

    const byBank = new Map<number, PatchListEntry[]>();
    for (const entry of shown) {
      const list = byBank.get(entry.bank) ?? [];
      list.push(entry);
      byBank.set(entry.bank, list);
    }

    for (const bank of Array.from(byBank.keys()).sort((a, b) => a - b)) {
      const group = document.createElement('div');
      group.className = 'patch-bank';

      const heading = document.createElement('h3');
      heading.textContent = `Bank ${bank + 1}`;
      group.appendChild(heading);

      const table = document.createElement('div');
      table.className = 'patch-rows';
      for (const entry of byBank.get(bank)!.sort((a, b) => a.position - b.position)) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'patch-row' + (entry.empty ? ' patch-row--empty' : '');
        row.disabled = entry.empty || !entry.name;
        const pos = document.createElement('span');
        pos.className = 'patch-pos';
        pos.textContent = String(entry.position + 1).padStart(2, '0');
        const name = document.createElement('span');
        name.textContent = entry.empty ? '—' : entry.name || '(unnamed)';
        row.append(pos, name);
        if (!row.disabled) {
          row.addEventListener('click', () => void selectPatch(entry, row));
        }
        table.appendChild(row);
      }
      group.appendChild(table);
      patchListEl.appendChild(group);
    }

    const named = patches.filter((p) => !p.empty && p.name).length;
    $('patch-count').textContent = patches.length
      ? `${named} named, ${patches.length} slots seen`
      : '';
  }

  hideEmpty.addEventListener('change', renderPatches);

  const slotSelect = $<HTMLSelectElement>('target-slot');
  const loadedPanel = $('current-patch');
  const placeholder = $('editor-placeholder');
  const showEditor = (visible: boolean) => {
    loadedPanel.hidden = !visible;
    placeholder.hidden = visible;
  };
  /** The voice area's canvas; the common/FX area has its own below it. */
  const canvasHost = $('patch-canvas-host');
  const commonHost = $('common-canvas-host');
  const hostFor = (area: PatchArea) => (area === 'voice' ? canvasHost : commonHost);
  const panes = $('patch-panes');
  const paneSplitter = $('pane-splitter');
  const loadedHint = $('loaded-hint');
  let loading = false;

  let currentPatch: Patch | null = null;
  /** One canvas per patch area, both on screen at once as in the original. */
  const views = new Map<PatchArea, PatchView>();

  const zoomLevel = $('zoom-level');

  /**
   * Fits both areas at one shared scale, so a module is the same size in each,
   * with the grid origin at the top-left the way the original shows it.
   */
  const fitView = () => {
    const shown = [...views].filter(([area, view]) =>
      !view.isEmpty && hostFor(area).clientWidth > 0 && hostFor(area).clientHeight > 0);
    const voice = views.get('voice');
    const scale = shown.length
      ? Math.min(...shown.map(([area, view]) =>
          view.fitScale(hostFor(area).clientWidth, hostFor(area).clientHeight)))
      : voice?.fitScale(canvasHost.clientWidth, canvasHost.clientHeight) ?? 1;
    for (const view of views.values()) view.showOrigin(scale);
  };

  $('fit-view').addEventListener('click', fitView);
  $('zoom-reset').addEventListener('click', () => {
    for (const view of views.values()) view.resetZoom();
  });
  const zoomAll = (factor: number) => {
    for (const [area, view] of views) {
      view.zoomBy(factor, hostFor(area).clientWidth, hostFor(area).clientHeight);
    }
  };
  $('zoom-in').addEventListener('click', () => zoomAll(1.25));
  $('zoom-out').addEventListener('click', () => zoomAll(1 / 1.25));

  // ---- the divider between the voice and common/FX areas ----
  const MIN_PANE = 60;
  let commonOpenHeight = 220;

  /** Sizes the common/FX pane; zero closes it down to the divider. */
  const setCommonHeight = (px: number) => {
    const max = Math.max(MIN_PANE, panes.clientHeight - paneSplitter.offsetHeight - MIN_PANE);
    const height = px < MIN_PANE / 2 ? 0 : Math.round(Math.min(max, Math.max(MIN_PANE, px)));
    commonHost.hidden = height === 0;
    commonHost.style.flexBasis = `${height}px`;
    paneSplitter.classList.toggle('pane-splitter--closed', height === 0);
    paneSplitter.setAttribute('aria-expanded', String(height > 0));
    if (height > 0) commonOpenHeight = height;
  };
  const toggleCommon = () => setCommonHeight(commonHost.hidden ? commonOpenHeight : 0);

  paneSplitter.addEventListener('pointerdown', (event: PointerEvent) => {
    event.preventDefault();
    paneSplitter.setPointerCapture(event.pointerId);
    paneSplitter.classList.add('pane-splitter--active');
    const move = (moveEvent: PointerEvent) => {
      const bottom = panes.getBoundingClientRect().bottom;
      setCommonHeight(bottom - moveEvent.clientY - paneSplitter.offsetHeight / 2);
    };
    const up = () => {
      paneSplitter.releasePointerCapture(event.pointerId);
      paneSplitter.classList.remove('pane-splitter--active');
      paneSplitter.removeEventListener('pointermove', move);
      paneSplitter.removeEventListener('pointerup', up);
    };
    paneSplitter.addEventListener('pointermove', move);
    paneSplitter.addEventListener('pointerup', up);
  });
  paneSplitter.addEventListener('dblclick', toggleCommon);
  paneSplitter.addEventListener('keydown', (event: KeyboardEvent) => {
    const current = commonHost.hidden ? 0 : commonHost.clientHeight;
    const step = event.shiftKey ? 60 : 20;
    if (event.key === 'ArrowUp') setCommonHeight(Math.max(MIN_PANE, current + step));
    else if (event.key === 'ArrowDown') setCommonHeight(current - step);
    else if (event.key === 'Enter' || event.key === ' ') toggleCommon();
    else return;
    event.preventDefault();
  });

  // ---- sidebar splitter ----
  const SIDEBAR_KEY = 'nomad-web.sidebar';
  const app = document.querySelector('.app') as HTMLElement;
  const splitter = $('splitter');
  const MIN_SIDEBAR = 220;
  const MAX_SIDEBAR = 640;

  const setSidebarWidth = (px: number, persist = true) => {
    const width = Math.round(Math.min(MAX_SIDEBAR, Math.max(0, px)));
    app.style.gridTemplateColumns = `${width}px 6px 1fr`;
    $('sidebar').hidden = width === 0;
    if (persist) {
      try { localStorage.setItem(SIDEBAR_KEY, String(width)); } catch { /* not essential */ }
    }
  };

  const storedWidth = Number(localStorage.getItem(SIDEBAR_KEY) ?? NaN);
  setSidebarWidth(Number.isFinite(storedWidth) ? storedWidth : 320, false);

  splitter.addEventListener('pointerdown', (event: PointerEvent) => {
    event.preventDefault();
    splitter.setPointerCapture(event.pointerId);
    splitter.classList.add('splitter--active');

    const move = (moveEvent: PointerEvent) => {
      const width = moveEvent.clientX - app.getBoundingClientRect().left;
      // Snap shut rather than leaving an unusably narrow sidebar.
      setSidebarWidth(width < MIN_SIDEBAR / 2 ? 0 : Math.max(MIN_SIDEBAR, width));
    };
    const up = () => {
      splitter.releasePointerCapture(event.pointerId);
      splitter.classList.remove('splitter--active');
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
  });

  // Double-click collapses, or restores a sensible width.
  splitter.addEventListener('dblclick', () => {
    const current = $('sidebar').getBoundingClientRect().width;
    setSidebarWidth(current < 40 ? 320 : 0);
  });

  splitter.addEventListener('keydown', (event: KeyboardEvent) => {
    const current = $('sidebar').getBoundingClientRect().width;
    const step = event.shiftKey ? 48 : 16;
    if (event.key === 'ArrowLeft') setSidebarWidth(Math.max(MIN_SIDEBAR, current - step));
    else if (event.key === 'ArrowRight') setSidebarWidth(current + step);
    else return;
    event.preventDefault();
  });

  // The canvas now sizes itself to the workspace, so a window or sidebar
  // resize needs the view refitted rather than left cropped.
  // Only the whole editor's size is watched, not each pane's: moving the
  // divider should show more or less of an area, as in the original, rather
  // than rescale everything.
  let refit: ReturnType<typeof setTimeout>;
  new ResizeObserver(() => {
    clearTimeout(refit);
    refit = setTimeout(() => {
      if (views.size && canvasHost.clientWidth > 0) fitView();
    }, 120);
  }).observe(panes);

  const monitorToggle = $<HTMLButtonElement>('toggle-monitor');
  monitorToggle.addEventListener('click', () => {
    const open = monitorToggle.getAttribute('aria-expanded') === 'true';
    monitorToggle.setAttribute('aria-expanded', String(!open));
    logEl.hidden = open;
    if (!open) logEl.scrollTop = logEl.scrollHeight;
  });

  /** Builds the canvas for one patch area, wired to send its edits. */
  function makeView(patch: Patch, area: PatchArea): PatchView {
    const slot = Number(slotSelect.value);
    const bit = areaBit(area);
    const where = area === 'voice' ? '' : 'FX ';

    const view = new PatchView({
      patch,
      area,
      catalogue,
      theme,
      format: (parameter, value) => formatters.format(parameter.formatter, value),

      onParameterChange: (module, parameter, value) => {
        send(
          () => nord.setParameter(slot, bit, module.index, parameter.index, value),
          `${where}#${module.index} ${parameter.name} = ${value} ` +
            `(${formatters.format(parameter.formatter, value)})`,
        );
      },

      onModuleMove: (module, x, y) => {
        send(
          () => nord.moveModule(slot, bit, module.index, x, y),
          `move ${where}#${module.index} to column ${x}, row ${y}`,
        );
      },

      onCableAdd: (from, to, color) => {
        send(
          () => nord.addCable(
            slot, bit, color,
            { module: from.moduleIndex, connector: from.connectorIndex, isOutput: from.isOutput },
            { module: to.moduleIndex, connector: to.connectorIndex, isOutput: to.isOutput },
          ),
          `patch #${from.moduleIndex}:${from.connectorIndex} → ` +
            `#${to.moduleIndex}:${to.connectorIndex}`,
        );
      },

      onParameterMenu: (module, parameter, event) =>
        openKnobMenu({ area, module: module.index, parameter: parameter.index }, event),

      badgeFor: (module, parameter) => {
        const knob = knobOf({ area, module: module.index, parameter: parameter.index });
        return knob === undefined ? null : shortKnobName(knob);
      },

      onCableDelete: (cable) => {
        send(
          () => nord.deleteCable(
            slot, bit,
            {
              module: cable.sourceModule,
              connector: cable.sourceConnector,
              isOutput: cable.sourceIsOutput,
            },
            { module: cable.destModule, connector: cable.destConnector, isOutput: 0 },
          ),
          `cut #${cable.sourceModule}:${cable.sourceConnector} → ` +
            `#${cable.destModule}:${cable.destConnector}`,
        );
      },

      onSelect: (module) => {
        selection = module ? { area, index: module.index } : selection?.area === area ? null : selection;
      },

      onModuleMenu: (module, event) => openModuleMenu(area, module, event),

      onModuleDelete: (module) => {
        send(
          () => nord.deleteModule(slot, bit, module.index),
          `delete ${where}#${module.index} ${module.name ?? ''}`.trim(),
        );
        forgetModule(patch, area, module.index);
      },
    });

    view.onZoomChanged = (scale) => {
      zoomLevel.textContent = `${Math.round(scale * 100)}%`;
    };
    return view;
  }

  /**
   * Draws both patch areas: voice above, common/FX below the divider. The
   * divider starts closed when the common area is empty, as it usually is.
   */
  function renderLoadedPatch(): void {
    if (!currentPatch) return;
    const patch = currentPatch;

    views.clear();
    for (const area of ['voice', 'common'] as const) {
      const view = makeView(patch, area);
      views.set(area, view);
      hostFor(area).replaceChildren(view.element);
    }

    const commonModules = patch.modules.filter((m) => m.area === 'common').length;
    setCommonHeight(commonModules ? commonOpenHeight : 0);
    // Fit once the panes have been laid out, so the measurements are real.
    requestAnimationFrame(fitView);

    const undrawn = patch.modules.filter((m) => {
      const def = catalogue.modules.get(m.type);
      return !def || !theme.modules.get(def.componentId);
    }).length;

    renderKnobStrip();
    renderLayoutWarning();
    updateSummary();
    loadedHint.textContent = undrawn
      ? `${undrawn} module(s) have no themed layout and are not drawn.`
      : '';
    showEditor(true);
  }

  /** "House Bass — 5 voice + 2 FX modules, 9 cables", and the FX divider's count. */
  function updateSummary(): void {
    const patch = currentPatch;
    if (!patch) return;
    const commonModules = patch.modules.filter((m) => m.area === 'common').length;
    const voiceModules = patch.modules.length - commonModules;
    $('loaded-summary').textContent =
      `${patch.name || '(unnamed)'} — ${voiceModules} voice` +
      (commonModules ? ` + ${commonModules} FX` : '') + ` modules, ${patch.cables.length} cables`;
    $('common-count').textContent = commonModules
      ? `${commonModules} module${commonModules === 1 ? '' : 's'}`
      : 'empty';
    updateLoad();
  }

  /** The two load bars: the voice area, and both areas together. */
  function updateLoad(): void {
    if (!currentPatch) return;
    const load = patchLoad(currentPatch, catalogue);
    for (const [id, value] of [['dsp-voice', load.voice], ['dsp-total', load.total]] as const) {
      const meter = $(id);
      (meter.querySelector('.dsp-fill') as HTMLElement).style.width = `${Math.min(100, value)}%`;
      meter.querySelector('.dsp-text')!.textContent = formatLoad(value);
      meter.classList.toggle('dsp-meter--high', value >= 90 && value <= MAX_LOAD);
      meter.classList.toggle('dsp-meter--full', value > MAX_LOAD);
    }
    $('dsp-load').title =
      `DSP load — voice area ${formatLoad(load.voice)}, common/FX ${formatLoad(load.common)}, ` +
      `total ${formatLoad(load.total)} of ${MAX_LOAD}%`;
  }

  // ---- overlapping modules ----

  const layoutWarning = $('layout-warning');

  /**
   * Modules that share grid cells sit on top of one another in the original
   * editor. Earlier versions of this one wrote positions that do exactly that,
   * so a patch it moved modules in may need spreading out once.
   */
  function renderLayoutWarning(): void {
    const overlaps = [...views.values()].reduce((n, view) => n + view.overlapCount, 0);
    layoutWarning.hidden = overlaps === 0;
    $('layout-warning-text').textContent = overlaps === 1
      ? 'Two modules overlap, so they sit on top of each other in the original editor.'
      : `${overlaps} pairs of modules overlap, so they sit on top of each other in the original editor.`;
  }

  $('fix-overlaps').addEventListener('click', () => {
    let moved = 0;
    for (const view of views.values()) moved += view.fixOverlaps();
    log('info', `spread out overlapping modules: ${moved} moved`);
    renderLayoutWarning();
  });

  /** Sends an edit, logging the wire bytes and surfacing any failure. */
  function send(build: () => Uint8Array, description: string): boolean {
    try {
      const message = build();
      log('out', `${description}  ${formatSysex(message)}`);
      return true;
    } catch (error) {
      log('err', `${description}: ${(error as Error).message}`);
      return false;
    }
  }

  // ---- hardware knob assignments ----

  const knobStrip = $('knob-strip');
  const knobName = (knob: number) => KNOB_NAMES.get(knob) ?? `Knob id ${knob}`;
  /** "K1" for the badge on a control; the pedal and friends keep a short word. */
  const shortKnobName = (knob: number) =>
    knob < 18 ? `K${knob + 1}` : ({ 19: 'Pedal', 20: 'AT', 22: 'Sw' } as Record<number, string>)[knob] ?? `#${knob}`;
  const sameTarget = (a: KnobTarget, b: KnobTarget) =>
    a.area === b.area && a.module === b.module && a.parameter === b.parameter;

  /** The knob a parameter is on, if any. */
  function knobOf(target: KnobTarget): number | undefined {
    for (const [knob, assigned] of currentPatch?.knobs ?? []) {
      if (sameTarget(assigned, target)) return knob;
    }
    return undefined;
  }

  /** "OscA Freq", for menus and the strip. */
  function describeTarget(target: KnobTarget): string {
    const module = currentPatch?.modules.find(
      (m) => m.area === target.area && m.index === target.module,
    );
    const def = module && catalogue.modules.get(module.type);
    const parameter = def?.parameters.find(
      (p) => p.className === 'parameter' && p.index === target.parameter,
    );
    const label = `${module?.name || def?.name || `module #${target.module}`} ` +
      `${parameter?.name ?? `param ${target.parameter}`}`;
    return target.area === 'voice' ? label : `${label} (FX)`;
  }

  /** The knobs worth offering: the three on a Micro, all of them otherwise. */
  const availableKnobs = () => knobsFor(nord.identity?.deviceId);

  function refreshKnobs(): void {
    for (const view of views.values()) view.refreshBadges();
    renderKnobStrip();
  }

  /**
   * Puts a parameter on a knob.
   *
   * A knob drives one parameter and a parameter rides on one knob, so whatever
   * the knob held is cleared first, and a parameter already on another knob is
   * moved rather than duplicated — which is what `prevknob` in 0x26 is for.
   */
  function assignKnob(knob: number, target: KnobTarget): void {
    const patch = currentPatch;
    if (!patch) return;
    const slot = Number(slotSelect.value);
    const previous = knobOf(target);
    if (previous === knob) return;

    const occupant = patch.knobs.get(knob);
    if (occupant) {
      if (!send(() => nord.assignKnob(slot, knob, null),
        `clear ${knobName(knob)} (was ${describeTarget(occupant)})`)) return;
      patch.knobs.delete(knob);
    }

    const sent = send(
      () => nord.assignKnob(slot, previous ?? null, {
        knob, area: areaBit(target.area), module: target.module, parameter: target.parameter,
      }),
      `${knobName(knob)} → ${describeTarget(target)}` +
        (previous === undefined ? '' : ` (moved from ${knobName(previous)})`),
    );
    if (sent) {
      if (previous !== undefined) patch.knobs.delete(previous);
      patch.knobs.set(knob, target);
    }
    refreshKnobs();
  }

  function clearKnob(knob: number): void {
    const patch = currentPatch;
    const target = patch?.knobs.get(knob);
    if (!patch || !target) return;
    const slot = Number(slotSelect.value);
    if (send(() => nord.assignKnob(slot, knob, null),
      `clear ${knobName(knob)} (was ${describeTarget(target)})`)) {
      patch.knobs.delete(knob);
    }
    refreshKnobs();
  }

  /**
   * The strip above the canvas. On a Micro all three knobs are always shown,
   * free or not; with eighteen-plus knobs only the assigned ones are.
   */
  function renderKnobStrip(): void {
    knobStrip.replaceChildren();
    const patch = currentPatch;
    if (!patch) return;

    const knobs = availableKnobs();
    const assignedElsewhere = [...patch.knobs.keys()].filter((k) => !knobs.includes(k));
    const shown = (knobs.length <= 3 ? knobs : knobs.filter((k) => patch.knobs.has(k)))
      .concat(assignedElsewhere);

    const title = document.createElement('span');
    title.className = 'knob-strip-title';
    title.textContent = 'Knobs';
    knobStrip.appendChild(title);

    for (const knob of shown) {
      const target = patch.knobs.get(knob);
      const chip = document.createElement('span');
      chip.className = 'knob-chip' + (target ? '' : ' knob-chip--free');

      const name = document.createElement('span');
      name.className = 'knob-chip-name';
      name.textContent = knobName(knob);
      const what = document.createElement('span');
      what.className = 'knob-chip-target';
      what.textContent = target ? describeTarget(target) : 'unassigned';
      chip.append(name, what);

      if (target) {
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.textContent = '×';
        clear.title = `Clear ${knobName(knob)}`;
        clear.setAttribute('aria-label', `Clear ${knobName(knob)}`);
        clear.addEventListener('click', () => clearKnob(knob));
        chip.appendChild(clear);
      }
      knobStrip.appendChild(chip);
    }

    if (!shown.length || patch.knobs.size === 0) {
      const hint = document.createElement('span');
      hint.className = 'hint hint--inline';
      hint.textContent = 'Right-click any knob, slider or button on a module to assign it.';
      knobStrip.appendChild(hint);
    }
  }

  let openMenu: HTMLElement | null = null;

  function closeKnobMenu(): void {
    openMenu?.remove();
    openMenu = null;
  }

  document.addEventListener('pointerdown', (event) => {
    if (openMenu && !openMenu.contains(event.target as Node)) closeKnobMenu();
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeKnobMenu();
  });
  window.addEventListener('blur', closeKnobMenu);
  canvasHost.addEventListener('wheel', closeKnobMenu, { passive: true });
  commonHost.addEventListener('wheel', closeKnobMenu, { passive: true });

  function openKnobMenu(target: KnobTarget, event: MouseEvent): void {
    closeKnobMenu();
    if (!currentPatch) return;
    const patch = currentPatch;
    const current = knobOf(target);

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.setAttribute('role', 'menu');

    const title = document.createElement('div');
    title.className = 'context-menu-title';
    title.textContent = `Assign ${describeTarget(target)} to`;
    menu.appendChild(title);

    const item = (label: string, detail: string, action: (() => void) | null) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      const main = document.createElement('span');
      main.textContent = label;
      const extra = document.createElement('span');
      extra.className = 'menu-detail';
      extra.textContent = detail;
      button.append(main, extra);
      if (action) {
        button.addEventListener('click', () => { closeKnobMenu(); action(); });
      } else {
        button.disabled = true;
      }
      menu.appendChild(button);
      return button;
    };

    for (const knob of availableKnobs()) {
      const occupant = patch.knobs.get(knob);
      if (knob === current) {
        item(`✓ ${knobName(knob)}`, 'assigned', null);
      } else {
        item(knobName(knob), occupant ? `replaces ${describeTarget(occupant)}` : 'free',
          () => assignKnob(knob, target));
      }
    }

    if (current !== undefined) {
      menu.appendChild(document.createElement('hr'));
      item(`Remove from ${knobName(current)}`, '', () => clearKnob(current));
    }

    document.body.appendChild(menu);
    // Keep the whole menu on screen near the pointer.
    const { width, height } = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(event.clientX, innerWidth - width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(event.clientY, innerHeight - height - 4))}px`;
    openMenu = menu;
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }

  /**
   * Assignments the device reports itself, e.g. one made from its own front
   * panel. Same shapes as the ones sent: 0x25 is a fresh assignment, 0x26
   * clears `prevknob` and optionally carries the replacement.
   */
  nord.addListener((message) => {
    if (message.messageId !== 'knobAssignment' || !currentPatch) return;
    if (message.root.values.get('slot') !== Number(slotSelect.value)) return;
    const info = message.root.items.get('data');
    if (!info || Array.isArray(info)) return;
    const body = info.items.get('data');
    if (!body || Array.isArray(body)) return;

    let fresh: Decoded | undefined = body;
    if (info.values.get('sc') === 0x26) {
      const prev = body.values.get('prevknob');
      if (prev !== undefined) currentPatch.knobs.delete(prev);
      // NewKnobAssignmentPacket$data, which wraps KnobAssignment$data.
      const packet = body.items.get('data');
      const nested = packet && !Array.isArray(packet) ? packet.items.get('data') : undefined;
      fresh = nested && !Array.isArray(nested) ? nested : undefined;
    }
    const knob = fresh?.values.get('knob');
    const section = fresh?.values.get('section');
    if (fresh && knob !== undefined && (section === 0 || section === 1)) {
      currentPatch.knobs.set(knob, {
        area: areaOf(section),
        module: fresh.values.get('module') ?? -1,
        parameter: fresh.values.get('parameter') ?? -1,
      });
    }
    refreshKnobs();
  });

  /**
   * A knob turned on the device. It reports the new value as `KnobChange`
   * (NMInfo, sc 0x40), and a value change can also arrive as `ParameterChange`
   * (Parameter, sc 0x40); both carry section, module, parameter and value.
   * The control on screen follows without sending anything back.
   */
  nord.addListener((message) => {
    const patch = currentPatch;
    if (!patch) return;
    const cc = message.root.values.get('cc');
    if (cc !== CC.Parameter && cc !== CC.NMInfo) return;
    if (message.root.values.get('slot') !== Number(slotSelect.value)) return;
    const info = message.root.items.get('data');
    if (!info || Array.isArray(info) || info.values.get('sc') !== 0x40) return;
    const body = info.items.get('data');
    if (!body || Array.isArray(body)) return;

    const section = body.values.get('section');
    const index = body.values.get('module');
    const parameterIndex = body.values.get('parameter');
    const value = body.values.get('value');
    if ((section !== 0 && section !== 1) || index === undefined ||
        parameterIndex === undefined || value === undefined) return;

    const area = areaOf(section);
    const module = patch.modules.find((m) => m.area === area && m.index === index);
    const def = module && catalogue.modules.get(module.type);
    if (!def) return;
    const controls = controlParameters(def);
    const position = controls.findIndex((p) => p.index === parameterIndex);
    if (position < 0) return;

    views.get(area)?.setParameter(index, controls[position].componentId, value);
    const stored = patch.parameters.find((p) => p.area === area)?.byModule.get(index);
    if (stored) stored[position] = value;
  });

  /** The device's patch id for the patch on screen, to recognise a change. */
  let shownPid: number | null = null;

  /**
   * Puts a fetched patch on screen, or explains why nothing came back.
   * Returns the patch, or null when the device sent no patch data.
   */
  function showFetched(report: PatchDumpReport, slotName: string): Patch | null {
    log(
      'info',
      `patch fetch via ${report.method}: ${report.packets} packets in ${report.runs} run(s), ` +
        `${report.payloadBytes} payload bytes, first=${report.sawFirst} last=${report.sawLast}` +
        (report.otherMessages.length
          ? `, also saw: ${[...new Set(report.otherMessages)].join(', ')}`
          : ''),
    );

    if (report.payloadBytes === 0) {
      showFetchDiagnostic(report, slotName);
      return null;
    }

    log('info', `part sizes: ${report.parts.map((p) => p.length).join(', ')} bytes`);

    const patch = patchReader.readParts(report.parts);
    currentPatch = patch;
    log(
      'info',
      `patch "${patch.name}": sections ${[...patch.sections.keys()].sort((a, b) => a - b).join(', ')} · ` +
        `${patch.modules.length} modules, ${patch.cables.length} cables`,
    );

    // ypos is an absolute row (Nomad's PBasicModuleMetrics). A patch whose
    // columns read as consecutive ranks was most likely rewritten by an
    // earlier version of this editor, and will overlap in the original.
    const scheme = describeLayoutScheme(patch);
    log('info', `ypos looks ${scheme.verdict} — ${scheme.detail}`);

    renderLoadedPatch();
    return patch;
  }

  // ---- following the device: a patch chosen on the Nord itself ----

  let followTimer: ReturnType<typeof setTimeout> | undefined;
  let followPid: number | null = null;

  /**
   * The device says a slot has a new patch: `NewPatchInSlot` (NMInfo, sc
   * 0x38), sent when one is chosen on its own front panel. Nomad's
   * NmMessageHandler answers it by reading the whole patch back
   * (`NmSlot.requestPatch`), and so does this.
   *
   * Loading from the patch list makes the device send one too; that is
   * ignored while the load runs, and afterwards because it names the patch
   * already on screen.
   */
  nord.addListener((message) => {
    if (message.messageId !== 'newPatchInSlot' || !connected) return;
    const slot = message.root.values.get('slot');
    if (slot !== Number(slotSelect.value)) return;
    const info = message.root.items.get('data');
    if (!info || Array.isArray(info)) return;
    const pid = info.values.get('pid');
    if (pid === undefined || (pid === shownPid && !loading)) return;
    followPid = pid;
    // A run of these can arrive together; read the patch back once they settle.
    clearTimeout(followTimer);
    followTimer = setTimeout(() => void followDevice(), 250);
  });

  async function followDevice(): Promise<void> {
    if (loading) {
      // A load from the list is running. When it ends, look again: if the
      // device's patch is still not the one shown, it changed meanwhile.
      followTimer = setTimeout(() => {
        if (followPid !== null && followPid !== shownPid) void followDevice();
      }, 400);
      return;
    }
    loading = true;
    const slot = Number(slotSelect.value);
    const slotName = slotSelect.selectedOptions[0]?.textContent ?? `slot ${slot}`;
    const device = nord.identity?.deviceName ?? 'Nord';
    patchHint.textContent = `The ${device} changed patch; reading it…`;
    log('info', `new patch in ${slotName} on the device (pid ${followPid}); reading it back`);
    showEditor(true);

    // Recorded as the id the device announced: the transfer handshake reports
    // an id of its own, which need not be the same.
    const announced = followPid;
    try {
      const report = await nord.fetchPatch(slot);
      const patch = showFetched(report, slotName);
      shownPid = announced;
      if (!patch) {
        patchHint.textContent = `The ${device} changed patch, but sent no patch data for it.`;
        return;
      }
      // The list only knows names, so mark the entry when exactly one matches.
      const rows = Array.from(patchListEl.querySelectorAll<HTMLElement>('.patch-row'));
      for (const row of rows) row.classList.remove('patch-row--active');
      const matches = rows.filter((row) => row.lastElementChild?.textContent === patch.name);
      if (matches.length === 1) matches[0].classList.add('patch-row--active');
      patchHint.textContent =
        `The ${device} switched to "${patch.name || '(unnamed)'}" — ` +
        `${patch.modules.length} modules, ${patch.cables.length} cables.`;
    } catch (error) {
      clearCanvases();
      loadedHint.textContent = `The ${device} changed patch, but reading it failed: ${(error as Error).message}`;
      log('err', (error as Error).message);
    } finally {
      loading = false;
    }
  }

  async function selectPatch(entry: PatchListEntry, row: HTMLElement): Promise<void> {
    if (loading) return;
    loading = true;

    for (const other of patchListEl.querySelectorAll('.patch-row--active')) {
      other.classList.remove('patch-row--active');
    }
    row.classList.add('patch-row--active');

    const slot = Number(slotSelect.value);
    const slotName = slotSelect.selectedOptions[0]?.textContent ?? `slot ${slot}`;
    patchHint.textContent = `Loading "${entry.name}" into ${slotName}…`;

    // The panel is shown up front so a failure is visible rather than silent.
    showEditor(true);

    // Loading makes the device announce the new patch; whatever id it names
    // during the load is the one now on screen.
    followPid = null;
    try {
      const report = await nord.loadAndFetchPatch(slot, entry.bank, entry.position);
      const patch = showFetched(report, slotName);
      shownPid = followPid ?? nord.getActivePid(slot);
      if (!patch) {
        patchHint.textContent =
          `Loaded "${entry.name}" into ${slotName}, but the device sent no patch data.`;
        return;
      }
      patchHint.textContent =
        `Loaded "${patch.name || entry.name}" into ${slotName} — ` +
        `${patch.modules.length} modules, ${patch.cables.length} cables.`;
    } catch (error) {
      clearCanvases();
      loadedHint.textContent =
        `The patch loaded on the device, but this could not read it back: ` +
        `${(error as Error).message}`;
      patchHint.textContent = `Loaded into ${slotName}; reading it back failed.`;
      log('err', (error as Error).message);
    } finally {
      loading = false;
    }
  }

  /** Empties both areas, leaving the voice pane free for a message. */
  function clearCanvases(): void {
    views.clear();
    canvasHost.replaceChildren();
    commonHost.replaceChildren();
    setCommonHeight(0);
    knobStrip.replaceChildren();
    layoutWarning.hidden = true;
  }

  /** Explains an empty patch fetch using what actually came back. */
  function showFetchDiagnostic(report: PatchDumpReport, slotName: string): void {
    clearCanvases();
    currentPatch = null;

    const box = document.createElement('div');
    box.className = 'diagnostic';

    const heading = document.createElement('strong');
    heading.textContent = `No patch data came back from ${slotName}.`;
    box.appendChild(heading);

    const lines = [
      `Tried: ${report.method}.`,
      `Patch packets seen: ${report.packets} in ${report.runs} run(s).`,
      `Transfer patch id from the ACK: ${report.patchId ?? '(none)'}`,
      report.otherMessages.length
        ? `The device did reply with: ${[...new Set(report.otherMessages)].join(', ')}.`
        : 'Nothing at all arrived during the wait.',
      report.packets > 0 && !report.sawLast
        ? 'Packets arrived but none was flagged as the last of the run, so the ' +
          'first/last flags may not be where the grammar says.'
        : '',
      'The MIDI monitor below has the raw bytes.',
    ].filter(Boolean);

    for (const text of lines) {
      const p = document.createElement('p');
      p.textContent = text;
      box.appendChild(p);
    }

    canvasHost.appendChild(box);
    $('loaded-summary').textContent = '';
    loadedHint.textContent = '';
  }

  cancelButton.addEventListener('click', () => {
    cancelled = true;
    patchHint.textContent = 'Cancelled.';
  });

  fetchButton.addEventListener('click', async () => {
    patches = [];
    cancelled = false;
    fetchButton.disabled = true;
    cancelButton.hidden = false;
    renderPatches();

    const selected = bankSelect.value;
    const banks = selected === 'all'
      ? Array.from({ length: MAX_BANKS }, (_, i) => i)
      : [Number(selected)];

    patchHint.textContent = `Reading ${banks.length === 1 ? `bank ${banks[0] + 1}` : 'all banks'}…`;

    try {
      patches = await nord.fetchPatchList({
        banks,
        timeoutMs: 1500,
        shouldStop: () => cancelled,
        onProgress: (entries) => {
          patches = entries;
          renderPatches();
        },
      });
      renderPatches();
      patchHint.textContent = patches.length
        ? `Read ${patches.length} slots.`
        : 'The device returned no patch list. Check the MIDI monitor for what came back.';
    } catch (error) {
      patchHint.textContent = `Patch list failed: ${(error as Error).message}`;
      log('err', (error as Error).message);
    } finally {
      fetchButton.disabled = false;
      cancelButton.hidden = true;
    }
  });

  // ---- module toolbar ----

  function onParameterChange(def: ModuleDef, parameter: ParameterDef, value: number): void {
    // Without a loaded patch there is no module instance index to address, so
    // the message is built and shown rather than sent. Wiring this to the
    // device is what loading a patch unlocks.
    const message = nord.build(CC.Parameter, 0, {
      data: {
        pid: 0,
        sc: 0x40,
        data: { section: 0, module: def.index, parameter: parameter.index, value },
      },
    });
    const shown = formatters.format(parameter.formatter, value);
    log(
      'out',
      `${def.name}.${parameter.name} = ${value}${shown !== String(value) ? ` (${shown})` : ''}` +
        `  ${formatSysex(message)}${connected ? '' : '  [preview]'}`,
    );
  }

  /** A click on a module button opens its panel in a popover, to look at and try. */
  let popover: { element: HTMLElement; button: HTMLButtonElement } | null = null;

  function closePreview(): void {
    popover?.button.classList.remove('module-button--open');
    popover?.element.remove();
    popover = null;
  }

  function openPreview(def: ModuleDef, button: HTMLButtonElement): void {
    const reopening = popover?.button === button;
    closePreview();
    if (reopening) return;

    const element = document.createElement('div');
    element.className = 'module-popover';
    element.setAttribute('role', 'dialog');
    element.setAttribute('aria-label', def.name);

    const header = document.createElement('header');
    const name = document.createElement('strong');
    name.textContent = def.name;
    const meta = document.createElement('span');
    meta.className = 'count';
    meta.textContent = `${def.category} · type ${def.index}`;
    header.append(name, meta);
    element.appendChild(header);

    const moduleTheme = theme.modules.get(def.componentId);
    if (moduleTheme) {
      element.appendChild(new ModuleView({
        def,
        theme: moduleTheme,
        imageBase: '/data/theme-images',
        title: def.name,
        format: (parameter, value) => formatters.format(parameter.formatter, value),
        onParameterChange: (parameter, value) => onParameterChange(def, parameter, value),
      }).element);
    }
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = 'Drag the button onto the patch to add one.';
    element.appendChild(note);

    document.body.appendChild(element);
    const anchor = button.getBoundingClientRect();
    const { width } = element.getBoundingClientRect();
    element.style.left = `${Math.max(4, Math.min(anchor.left, innerWidth - width - 4))}px`;
    element.style.top = `${anchor.bottom + 4}px`;
    button.classList.add('module-button--open');
    popover = { element, button };
  }

  document.addEventListener('pointerdown', (event) => {
    const target = event.target as Node;
    if (popover && !popover.element.contains(target) && !popover.button.contains(target)) {
      closePreview();
    }
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closePreview();
  });

  // ---- deleting modules: right-click a module, or select it and press Delete ----

  /** The module last selected, in whichever area. */
  let selection: { area: PatchArea; index: number } | null = null;

  /**
   * Drops a deleted module from the model. Its knob assignments go too: the
   * device clears those itself, as Nomad's VoiceArea.unregisterAssignments
   * does locally, so nothing more is sent.
   */
  function forgetModule(patch: Patch, area: PatchArea, index: number): void {
    patch.modules = patch.modules.filter((m) => !(m.area === area && m.index === index));
    patch.parameters.find((p) => p.area === area)?.byModule.delete(index);
    for (const [knob, target] of [...patch.knobs]) {
      if (target.area === area && target.module === index) patch.knobs.delete(knob);
    }
    if (selection?.area === area && selection.index === index) selection = null;
    refreshKnobs();
    updateSummary();
    renderLayoutWarning();
  }

  function deleteModule(area: PatchArea, index: number): void {
    views.get(area)?.removeModule(index);
  }

  function openModuleMenu(area: PatchArea, module: PatchModule, event: MouseEvent): void {
    closeKnobMenu();
    const def = catalogue.modules.get(module.type);
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.setAttribute('role', 'menu');

    const title = document.createElement('div');
    title.className = 'context-menu-title';
    title.textContent = `${module.name || def?.name} (${def?.name ?? 'module'} #${module.index})`;
    menu.appendChild(title);

    const cables = currentPatch?.cables.filter((c) =>
      c.area === area && (c.sourceModule === module.index || c.destModule === module.index)).length ?? 0;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.setAttribute('role', 'menuitem');
    const label = document.createElement('span');
    label.textContent = 'Delete module';
    const detail = document.createElement('span');
    detail.className = 'menu-detail';
    detail.textContent = cables ? `and its ${cables} cable${cables === 1 ? '' : 's'} · Del` : 'Del';
    remove.append(label, detail);
    remove.addEventListener('click', () => { closeKnobMenu(); deleteModule(area, module.index); });
    menu.appendChild(remove);

    document.body.appendChild(menu);
    const { width, height } = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(event.clientX, innerWidth - width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(event.clientY, innerHeight - height - 4))}px`;
    openMenu = menu;
    remove.focus();
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable]')) return;
    if (!selection || !currentPatch) return;
    event.preventDefault();
    deleteModule(selection.area, selection.index);
  });

  // ---- adding modules: drag from the toolbar onto either area ----

  /** Lowest instance index not in use in an area; the device numbers from 1. */
  function freeIndex(patch: Patch, area: PatchArea): number | null {
    const used = new Set(patch.modules.filter((m) => m.area === area).map((m) => m.index));
    for (let index = 1; index <= 127; index++) if (!used.has(index)) return index;
    return null;
  }

  /**
   * "ADSR1", "ADSR2"… — the type name with the first number not yet taken.
   * A bracketed part is dropped, so "Mixer (3)" gives "Mixer1", not "Mixer (3)1".
   */
  function freshName(patch: Patch, def: ModuleDef): string {
    const taken = new Set(patch.modules.map((m) => m.name));
    const base = def.name.replace(/\s*\([^)]*\)/g, '').trim() || def.name;
    for (let n = 1; ; n++) {
      const suffix = String(n);
      const name = base.slice(0, 16 - suffix.length) + suffix;
      if (!taken.has(name)) return name;
    }
  }

  /** Why a module cannot go into this patch, or null if it can. */
  function refusalFor(patch: Patch, def: ModuleDef, area: PatchArea): string | null {
    const limit = Number(def.attributes.get('limit') ?? NaN);
    if (Number.isFinite(limit) && patch.modules.filter((m) => m.type === def.index).length >= limit) {
      return `a patch can only have ${limit === 1 ? 'one' : limit} ${def.name}`;
    }
    if (freeIndex(patch, area) === null) return 'this area already has 127 modules';
    // The device refuses a module that would take the DSP past 100%.
    const total = patchLoad(patch, catalogue).total;
    const needs = moduleCycles(def);
    if (total + needs > MAX_LOAD) {
      return `not enough DSP: it needs ${formatLoad(needs)} and ${formatLoad(Math.max(0, MAX_LOAD - total))} is free`;
    }
    return null;
  }

  /**
   * Adds a module at a cell: to the model, to the device (one patch packet,
   * as NewModuleMessage sends it), then to the canvas, which pushes down
   * anything it lands on and sends those moves.
   */
  function addModuleAt(def: ModuleDef, area: PatchArea, cell: { x: number; y: number }): void {
    const patch = currentPatch;
    const view = views.get(area);
    if (!patch || !view) return;

    const refusal = refusalFor(patch, def, area);
    if (refusal) {
      log('err', `cannot add ${def.name}: ${refusal}`);
      loadedHint.textContent = `Could not add ${def.name}: ${refusal}.`;
      return;
    }

    const index = freeIndex(patch, area)!;
    const name = freshName(patch, def);
    const parameters = controlParameters(def).map((p) => p.defaultValue);
    const customs = def.parameters.filter((p) => p.className === 'custom').map((p) => p.defaultValue);
    const slot = Number(slotSelect.value);

    const sent = send(
      () => nord.addModule(slot, patchWriter.newModule({
        type: def.index, area, index, x: cell.x, y: cell.y, name, parameters, customs,
      })),
      `add ${name} (${def.name}) as ${area === 'voice' ? '' : 'FX '}#${index} at column ${cell.x}, row ${cell.y}`,
    );
    if (!sent) return;

    const module = { area, type: def.index, index, x: cell.x, y: cell.y, name };
    patch.modules.push(module);
    let dump = patch.parameters.find((p) => p.area === area);
    if (!dump) {
      dump = { area, byModule: new Map() };
      patch.parameters.push(dump);
    }
    dump.byModule.set(index, parameters);
    view.addModule(module);

    loadedHint.textContent = '';
    updateSummary();
    renderLayoutWarning();
  }

  /** The visible area a point is over, if any. */
  function areaAt(clientX: number, clientY: number): PatchArea | null {
    for (const area of ['voice', 'common'] as const) {
      const host = hostFor(area);
      if (host.hidden) continue;
      const r = host.getBoundingClientRect();
      if (clientX >= r.left && clientX < r.right && clientY >= r.top && clientY < r.bottom) return area;
    }
    return null;
  }

  /**
   * Follows a drag out of the toolbar. A ghost of the module's panel rides
   * with the pointer at the canvas's own scale; over an area the cell it
   * would land on is outlined, snapped to the grid, and a release there adds
   * the module.
   */
  function dragModule(def: ModuleDef, start: PointerEvent): void {
    closePreview();
    const moduleTheme = theme.modules.get(def.componentId);
    if (!moduleTheme) return;
    const rows = Math.round(moduleTheme.height / 15);
    const scale = views.get('voice')?.zoom ?? 1;

    const ghost = document.createElement('div');
    ghost.className = 'module-ghost';
    ghost.appendChild(new ModuleView({
      def, theme: moduleTheme, imageBase: '/data/theme-images', title: def.name,
    }).element);
    ghost.style.transform = `scale(${scale})`;
    document.body.appendChild(ghost);
    document.body.classList.add('dragging-module');

    // The pointer holds the panel a little in from its top-left corner, so the
    // corner — which decides the cell — sits just up and left of it.
    const grab = { x: 12 * scale, y: 8 * scale };
    let target: { area: PatchArea; cell: { x: number; y: number } } | null = null;

    const move = (event: PointerEvent) => {
      const left = event.clientX - grab.x;
      const top = event.clientY - grab.y;
      ghost.style.left = `${left}px`;
      ghost.style.top = `${top}px`;

      const area = currentPatch ? areaAt(event.clientX, event.clientY) : null;
      const refused = area && currentPatch ? refusalFor(currentPatch, def, area) : null;
      for (const view of views.values()) view.showDropTarget(null);
      target = null;
      if (area && !refused) {
        const cell = views.get(area)!.cellAt(left, top);
        views.get(area)!.showDropTarget(cell, rows);
        target = { area, cell };
      }
      ghost.classList.toggle('module-ghost--refused', !!refused || (!!area && !target));
      // A tooltip cannot be read mid-drag, so the reason goes in the hint line.
      loadedHint.textContent = refused ? `Can't add ${def.name}: ${refused}.` : '';
    };

    const end = (event: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('keydown', cancel);
      ghost.remove();
      loadedHint.textContent = '';
      document.body.classList.remove('dragging-module');
      for (const view of views.values()) view.showDropTarget(null);
      if (event.type === 'pointerup' && target) addModuleAt(def, target.area, target.cell);
      else if (event.type === 'pointerup' && !currentPatch) {
        log('info', `load a patch first to add ${def.name}`);
      }
    };
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      target = null;
      end(new PointerEvent('pointercancel'));
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('keydown', cancel);
    move(start);
  }

  const toolbar = new ModuleToolbar({
    layout: toolbarLayout,
    catalogue,
    dataBase: '/data',
    onPick: openPreview,
    onDragStart: dragModule,
  });
  $('module-toolbar-host').appendChild(toolbar.element);
}

main().catch((error) => {
  log('err', `startup failed: ${(error as Error).message}`);
  setStatus('startup failed', 'bad');
});
