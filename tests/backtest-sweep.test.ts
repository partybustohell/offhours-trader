import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config.js';
import { SIGNAL_ENABLERS, cellConfig, signalToggleCells } from '../scripts/backtest.js';
import { loadTrialRegistry, unregisteredSweepFlags } from '../src/trial-registry.js';

// The signal-toggle sweep MECHANISM (docs/QUANT-TESTING-PLAN.md Stage 1/2).
// NOTE: for a toggle to actually move backtest results, the episode driver must
// feed that signal its inputs (mi features / regime / return series) — that
// driver wiring is the remaining Stage-1 work; this covers the cell machinery.
const cfg = ConfigSchema.parse({});

describe('signal-toggle sweep cells', () => {
  it('the baseline cell applies threshold + bear only, no signal patch', () => {
    const baseline = signalToggleCells(0.55, 1.2).find((c) => c.id === 'baseline')!;
    const c = cellConfig(cfg, baseline);
    expect(c.conviction_threshold).toBe(0.55);
    expect(c.agent_weights.bear).toBe(1.2);
    expect(c.signals.anti_chase.enabled).toBe(false);
  });

  it('is baseline + one cell per enabler, each enabling exactly its flag', () => {
    const cells = signalToggleCells();
    expect(cells).toHaveLength(SIGNAL_ENABLERS.length + 1);

    const ac = cellConfig(cfg, cells.find((c) => c.id === 'sig-signals.anti_chase')!);
    expect(ac.signals.anti_chase.enabled).toBe(true);
    expect(ac.signals.amihud.enabled).toBe(false); // only its own flag

    const iv = cellConfig(cfg, cells.find((c) => c.id === 'sig-portfolio.inverse_vol')!);
    expect(iv.portfolio.sizing_mode).toBe('inverse_vol');
  });

  it('every toggled cell produces a schema-valid config', () => {
    for (const cell of signalToggleCells()) {
      expect(() => ConfigSchema.parse(cellConfig(cfg, cell))).not.toThrow();
    }
  });

  it('every non-baseline cell carries its flag for the registry gate', () => {
    for (const cell of signalToggleCells()) {
      if (cell.id === 'baseline') expect(cell.flag).toBeUndefined();
      else expect(cell.flag).toBe(cell.id.replace(/^sig-/, ''));
    }
  });

  it('the checked-in registry covers the current sweep flags (gate stays in sync)', () => {
    const trials = loadTrialRegistry();
    const signalFlags = signalToggleCells()
      .map((c) => c.flag)
      .filter((f): f is string => f !== undefined);
    expect(unregisteredSweepFlags(signalFlags, trials)).toEqual([]);
    expect(unregisteredSweepFlags(['conviction_threshold', 'agent_weights.bear'], trials)).toEqual([]);
  });
});
