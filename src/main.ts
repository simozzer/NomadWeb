import { parseModuleCatalogue, type ModuleDef, type ParameterDef } from './model/modules.ts';
import { parseTheme, type Theme } from './model/theme.ts';
import { FormatterTable } from './model/formatters.ts';
import { ModuleView } from './ui/moduleView.ts';
import { WebMidiTransport, MidiUnavailableError } from './midi/webmidi.ts';
import { NordModular, CC, MAX_BANKS, type PatchListEntry } from './midi/nord.ts';
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

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return response.text();
}

async function main(): Promise<void> {
  // ---- data ----
  const [modulesXml, themeXml, nmformatSrc, midiGrammar] = await Promise.all([
    fetchText('/data/modules.xml'),
    fetchText('/data/classic-theme.xml'),
    fetchText('/data/nmformat.js'),
    fetchText('/data/midi.pdl2'),
  ]);

  const catalogue = parseModuleCatalogue(modulesXml);
  const theme: Theme = parseTheme(themeXml);
  const formatters = new FormatterTable(nmformatSrc);

  log('info', `${catalogue.modules.size} modules, ${theme.modules.size} themed layouts`);

  // ---- MIDI ----
  const countersEl = $('counters');
  const showStream = $<HTMLInputElement>('show-stream');
  const showRaw = $<HTMLInputElement>('show-raw');

  const transport = new WebMidiTransport();
  const nord = new NordModular(transport, midiGrammar);
  let connected = false;

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

    const suggestion = transport.suggestPorts();
    if (suggestion.inputId) inputSelect.value = suggestion.inputId;
    if (suggestion.outputId) outputSelect.value = suggestion.outputId;
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
        const row = document.createElement('div');
        row.className = 'patch-row' + (entry.empty ? ' patch-row--empty' : '');
        const pos = document.createElement('span');
        pos.className = 'patch-pos';
        pos.textContent = String(entry.position + 1).padStart(2, '0');
        const name = document.createElement('span');
        name.textContent = entry.empty ? '—' : entry.name || '(unnamed)';
        row.append(pos, name);
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
