import { parseModuleCatalogue, type ModuleDef, type ParameterDef } from './model/modules.ts';
import { parseTheme, type Theme } from './model/theme.ts';
import { FormatterTable } from './model/formatters.ts';
import { PatchReader, type Patch, type PatchArea } from './model/patch.ts';
import { ModuleView } from './ui/moduleView.ts';
import { PatchView } from './ui/patchView.ts';
import { WebMidiTransport, MidiUnavailableError } from './midi/webmidi.ts';
import {
  NordModular,
  CC,
  MAX_BANKS,
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
  const [modulesXml, themeXml, nmformatSrc, midiGrammar, patchGrammar] = await Promise.all([
    fetchText('/data/modules.xml'),
    fetchText('/data/classic-theme.xml'),
    fetchText('/data/nmformat.js'),
    fetchText('/data/midi.pdl2'),
    fetchText('/data/patch.pdl2'),
  ]);

  const catalogue = parseModuleCatalogue(modulesXml);
  const theme: Theme = parseTheme(themeXml);
  const formatters = new FormatterTable(nmformatSrc);
  const patchReader = new PatchReader(patchGrammar);

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

      const dl = $('identity');
      dl.hidden = false;
      dl.replaceChildren();
      for (const [term, value] of [
        ['Model', identity.deviceName],
        ['OS version', identity.version],
        ['Serial (last 4)', String(identity.serial)],
      ]) {
        const dt = document.createElement('dt');
        dt.textContent = term;
        const dd = document.createElement('dd');
        dd.textContent = value;
        dl.append(dt, dd);
      }

      setStatus(identity.deviceName, 'ok');
      log('info', `identified ${identity.deviceName}, OS ${identity.version}`);

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
  const canvasHost = $('patch-canvas-host');
  const loadedHint = $('loaded-hint');
  let loading = false;

  let currentPatch: Patch | null = null;
  let currentArea: PatchArea = 'voice';
  let patchView: PatchView | null = null;

  for (const tab of Array.from($('area-tabs').querySelectorAll<HTMLButtonElement>('.tab'))) {
    tab.addEventListener('click', () => {
      currentArea = tab.dataset.area === 'common' ? 'common' : 'voice';
      for (const other of $('area-tabs').querySelectorAll('.tab')) {
        other.classList.toggle('tab--active', other === tab);
      }
      renderLoadedPatch();
    });
  }

  $('fit-view').addEventListener('click', () => {
    patchView?.fit(canvasHost.clientWidth, canvasHost.clientHeight);
  });

  /** Renders the patch on the canvas for the currently selected area. */
  function renderLoadedPatch(): void {
    if (!currentPatch) return;
    const patch = currentPatch;
    const area = currentArea;
    const slot = Number(slotSelect.value);
    const areaBit: 0 | 1 = area === 'common' ? 1 : 0;

    canvasHost.replaceChildren();
    patchView = new PatchView({
      patch,
      area,
      catalogue,
      theme,
      format: (parameter, value) => formatters.format(parameter.formatter, value),

      onParameterChange: (module, parameter, value) => {
        send(
          () => nord.setParameter(slot, areaBit, module.index, parameter.index, value),
          `#${module.index} ${parameter.name} = ${value} ` +
            `(${formatters.format(parameter.formatter, value)})`,
        );
      },

      onModuleMove: (module, x, y) => {
        send(
          () => nord.moveModule(slot, areaBit, module.index, x, y),
          `move #${module.index} to (${x}, ${y})`,
        );
      },

      onCableAdd: (from, to, color) => {
        send(
          () => nord.addCable(
            slot, areaBit, color,
            { module: from.moduleIndex, connector: from.connectorIndex, isOutput: from.isOutput },
            { module: to.moduleIndex, connector: to.connectorIndex, isOutput: to.isOutput },
          ),
          `patch #${from.moduleIndex}:${from.connectorIndex} → ` +
            `#${to.moduleIndex}:${to.connectorIndex}`,
        );
      },

      onCableDelete: (cable) => {
        send(
          () => nord.deleteCable(
            slot, areaBit,
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
    });

    canvasHost.appendChild(patchView.element);
    patchView.fit(canvasHost.clientWidth || 900, canvasHost.clientHeight || 460);

    const inArea = patch.modules.filter((m) => m.area === area);
    const undrawn = inArea.filter((m) => {
      const def = catalogue.modules.get(m.type);
      return !def || !theme.modules.get(def.componentId);
    }).length;

    $('loaded-summary').textContent =
      `${patch.name || '(unnamed)'} — ${inArea.length} modules, ` +
      `${patch.cables.filter((c) => c.area === area).length} cables`;
    loadedHint.textContent = undrawn
      ? `${undrawn} module(s) in this area have no themed layout and are not drawn.`
      : '';
    loadedPanel.hidden = false;
  }

  /** Sends an edit, logging the wire bytes and surfacing any failure. */
  function send(build: () => Uint8Array, description: string): void {
    try {
      const message = build();
      log('out', `${description}  ${formatSysex(message)}`);
    } catch (error) {
      log('err', `${description}: ${(error as Error).message}`);
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
    loadedPanel.hidden = false;

    try {
      const report = await nord.loadAndFetchPatch(slot, entry.bank, entry.position);
      log(
        'info',
        `patch fetch via ${report.method}: ${report.packets} packets, ` +
          `${report.payloadBytes} payload bytes, first=${report.sawFirst} last=${report.sawLast}` +
          (report.otherMessages.length
            ? `, also saw: ${[...new Set(report.otherMessages)].join(', ')}`
            : ''),
      );

      if (report.payloadBytes === 0) {
        showFetchDiagnostic(report, slotName);
        patchHint.textContent =
          `Loaded "${entry.name}" into ${slotName}, but the device sent no patch data.`;
        return;
      }

      const patch = patchReader.read(report.bitstream);
      currentPatch = patch;
      // Land on whichever area actually has modules.
      if (!patch.modules.some((m) => m.area === currentArea)) {
        currentArea = patch.modules.some((m) => m.area === 'common') ? 'common' : 'voice';
        for (const tab of $('area-tabs').querySelectorAll<HTMLElement>('.tab')) {
          tab.classList.toggle('tab--active', tab.dataset.area === currentArea);
        }
      }
      renderLoadedPatch();
      patchHint.textContent =
        `Loaded "${patch.name || entry.name}" into ${slotName} — ` +
        `${patch.modules.length} modules, ${patch.cables.length} cables.`;
    } catch (error) {
      canvasHost.replaceChildren();
      loadedHint.textContent =
        `The patch loaded on the device, but this could not read it back: ` +
        `${(error as Error).message}`;
      patchHint.textContent = `Loaded into ${slotName}; reading it back failed.`;
      log('err', (error as Error).message);
    } finally {
      loading = false;
    }
  }

  /** Explains an empty patch fetch using what actually came back. */
  function showFetchDiagnostic(report: PatchDumpReport, slotName: string): void {
    canvasHost.replaceChildren();
    currentPatch = null;

    const box = document.createElement('div');
    box.className = 'diagnostic';

    const heading = document.createElement('strong');
    heading.textContent = `No patch data came back from ${slotName}.`;
    box.appendChild(heading);

    const lines = [
      `Tried: ${report.method}.`,
      `Patch packets seen: ${report.packets}.`,
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

  // ---- module browser ----
  const grid = $('module-grid');
  const categorySelect = $<HTMLSelectElement>('category');
  const searchInput = $<HTMLInputElement>('search');

  categorySelect.replaceChildren();
  for (const category of ['All', ...catalogue.categories]) {
    const option = document.createElement('option');
    option.value = category;
    option.textContent = category;
    categorySelect.appendChild(option);
  }

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

  function render(): void {
    const category = categorySelect.value;
    const query = searchInput.value.trim().toLowerCase();

    const matches = Array.from(catalogue.modules.values())
      .filter((def) => category === 'All' || def.category === category)
      .filter((def) => !query || def.name.toLowerCase().includes(query))
      .sort((a, b) => a.name.localeCompare(b.name));

    grid.replaceChildren();
    let missingTheme = 0;

    for (const def of matches) {
      const moduleTheme = theme.modules.get(def.componentId);
      if (!moduleTheme) { missingTheme++; continue; }

      const card = document.createElement('div');
      card.className = 'module-card';

      const header = document.createElement('header');
      const name = document.createElement('span');
      name.textContent = def.name;
      const meta = document.createElement('span');
      meta.textContent = `#${def.index} · ${def.category}`;
      header.append(name, meta);
      card.appendChild(header);

      const view = new ModuleView({
        def,
        theme: moduleTheme,
        imageBase: '/data/theme-images',
        format: (parameter, value) => formatters.format(parameter.formatter, value),
        onParameterChange: (parameter, value) => onParameterChange(def, parameter, value),
      });
      card.appendChild(view.element);
      grid.appendChild(card);
    }

    $('module-count').textContent =
      `${matches.length - missingTheme} shown` +
      (missingTheme ? ` · ${missingTheme} without a themed layout` : '');
  }

  categorySelect.addEventListener('change', render);
  searchInput.addEventListener('input', render);
  render();
}

main().catch((error) => {
  log('err', `startup failed: ${(error as Error).message}`);
  setStatus('startup failed', 'bad');
});
