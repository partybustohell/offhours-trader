import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../src/config.js';
import type { EpisodeResult } from '../src/backtest/metrics.js';
import {
  SIGNAL_ENABLERS,
  aggregateSweep,
  cellConfig,
  signalToggleCells,
  writeSignalAttribution,
  type SweepResultsFile,
  type SignalAttributionFile,
} from '../scripts/backtest.js';
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

// ---------- aggregation (intersection-restricted totals + attribution artifact) ----------

const episode = (day: string, netUsd: number, over: Partial<EpisodeResult> = {}): EpisodeResult => ({
  day,
  stratum: 'R',
  trades: [
    {
      ticker: 'NVDA',
      side: 'long',
      qty: 1,
      entryPrice: 100,
      exitPrice: 100 + netUsd,
      feesUsd: 0,
      borrowUsd: 0,
      pnlUsd: netUsd,
      analystsAgreeing: [],
      exitReason: 'judge exit',
    },
  ],
  abstained: false,
  ordersPlaced: 1,
  ordersFilled: 1,
  rejectionsByReason: {},
  judgeVetoes: 0,
  halts: 0,
  danglingAtFlatten: 0,
  llmCostUsd: 0,
  ...over,
});

describe('aggregateSweep / writeSignalAttribution', () => {
  let outDir: string;
  const TAG = 'test-tag';

  const writeEpisode = (cellId: string, e: EpisodeResult): void => {
    const dir = path.join(outDir, TAG, 'sweep', cellId, e.day);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'episode-result.json'), JSON.stringify(e));
  };

  beforeEach(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-agg-'));
    process.env.BACKTEST_OUT_DIR = outDir;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.BACKTEST_OUT_DIR;
    fs.rmSync(outDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('restricts every cell to the shared-day intersection and records the mismatch', () => {
    // baseline completed 2 of 3 days; the signal cell completed all 3.
    writeEpisode('baseline', episode('2026-01-05', 100));
    writeEpisode('baseline', episode('2026-01-06', -50));
    writeEpisode('sig-signals.amihud', episode('2026-01-05', 100));
    writeEpisode('sig-signals.amihud', episode('2026-01-06', -50));
    writeEpisode('sig-signals.amihud', episode('2026-01-07', -34));

    const cells = [
      { id: 'baseline', threshold: 0.55, bearWeight: 1.2 },
      { id: 'sig-signals.amihud', threshold: 0.55, bearWeight: 1.2 },
    ];
    const file = aggregateSweep(TAG, cells, 'signals', new Map([['baseline', 11]]));

    expect(file.sharedDays).toEqual(['2026-01-05', '2026-01-06']);
    expect(file.missingByCell).toEqual({ baseline: ['2026-01-07'] });
    const base = file.cells.find((r) => r.cell === 'baseline')!;
    const sig = file.cells.find((r) => r.cell === 'sig-signals.amihud')!;
    // identical episodes on shared days -> identical totals; no phantom -$34 delta
    expect(base.episodes).toBe(2);
    expect(sig.episodes).toBe(2);
    expect(sig.completedEpisodes).toBe(3);
    expect(base.netPnlTotalUsd).toBe(sig.netPnlTotalUsd);
    expect(base.judgeMissBudget).toBe(11);

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(outDir, TAG, 'sweep-results.json'), 'utf8'),
    ) as SweepResultsFile;
    expect(onDisk.cells).toEqual(file.cells);
    expect(onDisk.sharedDays).toEqual(file.sharedDays);
  });

  it('persists the paired per-day diff series + CI and counts dropped days', () => {
    writeEpisode('baseline', episode('2026-01-05', 100));
    writeEpisode('baseline', episode('2026-01-06', -50));
    writeEpisode('sig-signals.amihud', episode('2026-01-05', 90));
    writeEpisode('sig-signals.amihud', episode('2026-01-06', -60));
    writeEpisode('sig-signals.amihud', episode('2026-01-07', 1));

    const file = writeSignalAttribution(TAG)!;
    expect(file.baselineEpisodes).toBe(2);
    const s = file.signals.find((x) => x.cell === 'sig-signals.amihud')!;
    expect(s.nPairs).toBe(2);
    expect(s.droppedDays).toEqual({ baselineOnly: [], signalOnly: ['2026-01-07'] });
    expect(s.perDay).toEqual([
      { day: '2026-01-05', baselineNetUsd: 100, signalNetUsd: 90, marginalUsd: -10 },
      { day: '2026-01-06', baselineNetUsd: -50, signalNetUsd: -60, marginalUsd: -10 },
    ]);
    expect(s.meanMarginalUsd).toBeCloseTo(-10, 10);
    expect(s.bootstrap).toMatchObject({ low: -10, high: -10 });
    expect(s.verdict).toBe('unfavorable → KILL');

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(outDir, TAG, 'signal-attribution.json'), 'utf8'),
    ) as SignalAttributionFile;
    expect(onDisk.signals).toEqual(file.signals);
  });

  it('returns null (writes nothing) without a baseline cell', () => {
    writeEpisode('sig-signals.amihud', episode('2026-01-05', 1));
    expect(writeSignalAttribution(TAG)).toBeNull();
    expect(fs.existsSync(path.join(outDir, TAG, 'signal-attribution.json'))).toBe(false);
  });
});
