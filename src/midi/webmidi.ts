import { SysexFramer, chunkSysex } from './framing.ts';

// Web MIDI types come from lib.dom; only the app-facing shape is declared here.
export interface MidiPortInfo {
  id: string;
  name: string;
  manufacturer: string;
}

export class MidiUnavailableError extends Error {
  readonly reason: 'unsupported' | 'insecure-context' | 'denied';

  constructor(reason: 'unsupported' | 'insecure-context' | 'denied', message: string) {
    super(message);
    this.name = 'MidiUnavailableError';
    this.reason = reason;
  }
}

export type SysexListener = (message: Uint8Array) => void;

/**
 * Web MIDI transport for a single input/output pair, with SysEx reassembly.
 *
 * SysEx access requires a secure context (HTTPS, or localhost during
 * development) and a user permission grant; both failure modes surface as
 * `MidiUnavailableError` with a distinguishing `reason`.
 */
export class WebMidiTransport {
  private access: MIDIAccess | null = null;
  private input: MIDIInput | null = null;
  private output: MIDIOutput | null = null;
  private readonly framer = new SysexFramer();
  private readonly listeners = new Set<SysexListener>();

  /** Fired when ports appear or disappear, so the UI can refresh its lists. */
  onPortsChanged: (() => void) | null = null;

  get framingStats() {
    return this.framer.stats;
  }

  get isOpen(): boolean {
    return this.input !== null && this.output !== null;
  }

  async requestAccess(): Promise<void> {
    if (typeof navigator === 'undefined' || typeof navigator.requestMIDIAccess !== 'function') {
      // A non-secure page is the usual cause: the API is hidden entirely.
      const insecure =
        typeof window !== 'undefined' && !window.isSecureContext;
      throw new MidiUnavailableError(
        insecure ? 'insecure-context' : 'unsupported',
        insecure
          ? 'Web MIDI needs a secure context. Serve the page over HTTPS or from localhost.'
          : 'This browser does not expose Web MIDI. Chrome, Edge and Opera support it.',
      );
    }

    try {
      this.access = await navigator.requestMIDIAccess({ sysex: true });
    } catch (error) {
      throw new MidiUnavailableError(
        'denied',
        'Permission to use MIDI with system-exclusive messages was refused. ' +
          'The Nord Modular is driven entirely over SysEx, so it is required.',
      );
    }

    if (!this.access.sysexEnabled) {
      throw new MidiUnavailableError(
        'denied',
        'MIDI access was granted without SysEx. The Nord Modular cannot be controlled without it.',
      );
    }

    this.access.onstatechange = () => this.onPortsChanged?.();
  }

  listInputs(): MidiPortInfo[] {
    return this.describe(this.access?.inputs);
  }

  listOutputs(): MidiPortInfo[] {
    return this.describe(this.access?.outputs);
  }

  private describe(ports: ReadonlyMap<string, MIDIPort> | undefined): MidiPortInfo[] {
    if (!ports) return [];
    return Array.from(ports.values()).map((port) => ({
      id: port.id,
      name: port.name ?? '(unnamed)',
      manufacturer: port.manufacturer ?? '',
    }));
  }

  /** Heuristic: pick the port pair whose name looks like a Nord Modular. */
  suggestPorts(): { inputId?: string; outputId?: string } {
    const looksLikeNord = (p: MidiPortInfo) => /nord|clavia|modular/i.test(`${p.manufacturer} ${p.name}`);
    return {
      inputId: this.listInputs().find(looksLikeNord)?.id,
      outputId: this.listOutputs().find(looksLikeNord)?.id,
    };
  }

  async open(inputId: string, outputId: string): Promise<void> {
    if (!this.access) throw new Error('requestAccess() must be called first');

    const input = this.access.inputs.get(inputId);
    const output = this.access.outputs.get(outputId);
    if (!input) throw new Error(`no MIDI input with id ${inputId}`);
    if (!output) throw new Error(`no MIDI output with id ${outputId}`);

    await input.open();
    await output.open();

    this.framer.reset();
    input.onmidimessage = (event: MIDIMessageEvent) => {
      // `data` is nullable in the spec; a null payload carries nothing to frame.
      if (!event.data) return;
      for (const message of this.framer.push(event.data)) {
        for (const listener of this.listeners) listener(message);
      }
    };

    this.input = input;
    this.output = output;
  }

  async close(): Promise<void> {
    if (this.input) {
      this.input.onmidimessage = null;
      await this.input.close();
      this.input = null;
    }
    if (this.output) {
      await this.output.close();
      this.output = null;
    }
    this.framer.reset();
  }

  send(message: Uint8Array): void {
    if (!this.output) throw new Error('no MIDI output is open');
    for (const chunk of chunkSysex(message)) this.output.send(chunk);
  }

  addListener(listener: SysexListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
