import type { ModuleCatalogue, ModuleDef } from './modules.ts';
import type { Patch } from './patch.ts';

/**
 * DSP load, as the original editors show it ("Load: PVA 41.4%  Σ 41.4%").
 *
 * Each module's `cycles` attribute in modules.xml is already a percentage of
 * the DSP. Nomad's `JTPatchSettingsBar.updateCyclesInfo` shows the poly voice
 * area's sum, and the sum of both areas, on 0-100 bars; the device refuses a
 * module that would take the total past 100%. Checked against the Clavia
 * editor: a patch it shows at 41.4% sums to 41.44 here.
 */
export interface PatchLoad {
  /** Poly voice area, the original's "PVA". */
  voice: number;
  common: number;
  /** Both areas together, the original's "Σ". */
  total: number;
}

export const MAX_LOAD = 100;

export function moduleCycles(def: ModuleDef | undefined): number {
  const cycles = def?.cycles ?? 0;
  return Number.isFinite(cycles) ? cycles : 0;
}

export function patchLoad(patch: Patch, catalogue: ModuleCatalogue): PatchLoad {
  let voice = 0;
  let common = 0;
  for (const module of patch.modules) {
    const cycles = moduleCycles(catalogue.modules.get(module.type));
    if (module.area === 'voice') voice += cycles;
    else common += cycles;
  }
  return { voice, common, total: voice + common };
}

/** One decimal place, as the original shows it. */
export const formatLoad = (percent: number) => `${(Math.round(percent * 10) / 10).toFixed(1)}%`;
