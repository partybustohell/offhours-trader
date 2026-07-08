import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTION_MIN_N,
  H_LABEL,
  INSUFFICIENT_N_NOTE,
  VALIDITY_PLACEHOLDER,
  attribution,
  behavior,
  bootstrapCi,
  computeAll,
  designWeightedEstimate,
  episodeNetUsd,
  hEconomics,
  headlineEconomics,
  mulberry32,
  renderReport,
  tbillPerEpisodeUsd,
  tradeNetUsd,
  wilson,
  type EpisodeResult,
  type EpisodeTrade,
} from '../src/backtest/metrics.js';

// Pure math: no network, no fs, no clocks. All randomness is the seeded
// mulberry32 bootstrap, pinned by exact expected intervals.

const trade = (over: Partial<EpisodeTrade> = {}): EpisodeTrade => ({
  ticker: 'NVDA',
  side: 'long',
  qty: 10,
  entryPrice: 100,
  exitPrice: 110,
  feesUsd: 0,
  borrowUsd: 0,
  pnlUsd: 100,
  analystsAgreeing: ['fundamental'],
  exitReason: 'judge exit',
  ...over,
});

const episode = (over: Partial<EpisodeResult> = {}): EpisodeResult => ({
  day: '2026-03-04',
  stratum: 'R',
  trades: [],
  abstained: false,
  ordersPlaced: 0,
  ordersFilled: 0,
  rejectionsByReason: {},
  judgeVetoes: 0,
  halts: 0,
  danglingAtFlatten: 0,
  llmCostUsd: 0,
  ...over,
});

// Hand-computed 5-episode fixture: per-episode nets [100, -50, 20, 0, 30]
// (mean 20, total 100), with fees/borrow split so the net contract
// (net = pnlUsd - feesUsd - borrowUsd, summed per episode) is exercised.
const fiveEpisodes: EpisodeResult[] = [
  episode({
    day: '2026-01-05',
    trades: [trade({ pnlUsd: 120, feesUsd: 15, borrowUsd: 5 })], // 100
    ordersPlaced: 2,
    ordersFilled: 1,
    llmCostUsd: 2,
  }),
  episode({
    day: '2026-01-12',
    trades: [trade({ pnlUsd: -40, feesUsd: 10 })], // -50
    ordersPlaced: 1,
    ordersFilled: 1,
    llmCostUsd: 2,
  }),
  episode({
    day: '2026-02-03',
    trades: [trade({ pnlUsd: 15, feesUsd: 5 }), trade({ pnlUsd: 10 })], // 10 + 10 = 20
    ordersPlaced: 2,
    ordersFilled: 2,
    llmCostUsd: 2,
  }),
  episode({ day: '2026-02-17', abstained: true, llmCostUsd: 2 }), // 0
  episode({
    day: '2026-03-09',
    trades: [trade({ pnlUsd: 32, feesUsd: 2 })], // 30
    ordersPlaced: 1,
    ordersFilled: 1,
    llmCostUsd: 2,
  }),
];
const NETS = [100, -50, 20, 0, 30];

describe('net P&L contract', () => {
  it('tradeNetUsd subtracts fees and borrow from gross pnlUsd', () => {
    expect(tradeNetUsd(trade({ pnlUsd: 120, feesUsd: 15, borrowUsd: 5 }))).toBe(100);
  });

  it('episodeNetUsd sums trade nets; empty episode is 0', () => {
    expect(fiveEpisodes.map(episodeNetUsd)).toEqual(NETS);
  });
});

describe('seeded bootstrap CI (mulberry32, episode resampling)', () => {
  it('pins the exact 95% interval on the 5-episode fixture (10k draws, seed 42)', () => {
    const ci = bootstrapCi(NETS, 10_000, 42);
    // Independently computed with a reference implementation of the same
    // spec (mulberry32, draw-major consumption, empirical percentiles at
    // indices floor(10000*0.025)=250 and ceil(10000*0.975)-1=9749).
    expect(ci).toEqual({ low: -20, high: 66, level: 0.95, draws: 10_000, seed: 42 });
  });

  it('matches an independent inline reference for a hand-traceable 2-draw case', () => {
    // Independent mulberry32 (different code shape, same algorithm).
    function refMulberry32(seed: number): () => number {
      let state = seed >>> 0;
      return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = Math.imul(state ^ (state >>> 15), state | 1);
        t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
      };
    }
    const rand = refMulberry32(7);
    const means: number[] = [];
    for (let d = 0; d < 2; d++) {
      let sum = 0;
      for (let i = 0; i < NETS.length; i++) sum += NETS[Math.floor(rand() * NETS.length)]!;
      means.push(sum / NETS.length);
    }
    means.sort((a, b) => a - b);
    // Hand trace of mulberry32(7): first five floats pick indices 0,0,4,3,2
    // -> values 100,100,30,0,20 -> mean 50; next five pick 2,2,1,2,3 ->
    // 20,20,-50,20,0 -> mean 2. Sorted means [2, 50]; with 2 draws the
    // percentile indices are 0 and 1, so the interval is [min, max].
    expect(means).toEqual([2, 50]);
    expect(bootstrapCi(NETS, 2, 7)).toEqual({ low: 2, high: 50, level: 0.95, draws: 2, seed: 7 });
  });

  it('is reproducible for a fixed seed and degenerate for constant values', () => {
    expect(bootstrapCi(NETS, 1000, 99)).toEqual(bootstrapCi(NETS, 1000, 99));
    expect(bootstrapCi([7, 7, 7], 500, 1)).toMatchObject({ low: 7, high: 7 });
  });

  it('throws on an empty series instead of fabricating an interval', () => {
    expect(() => bootstrapCi([], 100, 1)).toThrow(/at least one value/);
  });

  it('mulberry32 emits floats in [0, 1)', () => {
    const rand = mulberry32(123);
    for (let i = 0; i < 1000; i++) {
      const x = rand();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe('Wilson interval', () => {
  it('k=3 n=10 matches the published 0.108..0.603 interval', () => {
    const w = wilson(3, 10);
    expect(w.p).toBeCloseTo(0.3, 12);
    expect(w.low).toBeCloseTo(0.108, 3);
    expect(w.high).toBeCloseTo(0.603, 3);
    // full-precision pin against the closed-form Wilson score formula
    expect(w.low).toBeCloseTo(0.10778928748621183, 12);
    expect(w.high).toBeCloseTo(0.6032267800204347, 12);
  });

  it('stays inside [0, 1] at the extremes and returns [0, 1] for n=0', () => {
    expect(wilson(0, 10).low).toBe(0);
    expect(wilson(10, 10).high).toBe(1);
    expect(wilson(0, 0)).toEqual({ k: 0, n: 0, p: 0, low: 0, high: 1 });
  });
});

describe('headlineEconomics (stratum R only)', () => {
  const hOutlier = episode({
    day: '2026-04-01',
    stratum: 'H',
    trades: [trade({ pnlUsd: 10_000 })],
    ordersPlaced: 5,
    ordersFilled: 5,
    llmCostUsd: 100,
  });
  const all = [...fiveEpisodes, hOutlier];

  it('computes mean/total per-episode net P&L from R episodes only', () => {
    const econ = headlineEconomics(all, { seed: 42 });
    expect(econ.stratum).toBe('R');
    expect(econ.nEpisodes).toBe(5);
    expect(econ.nTrades).toBe(5);
    expect(econ.perEpisodeNetUsd).toEqual(NETS);
    expect(econ.netPnlTotalUsd).toBe(100);
    expect(econ.netPnlMeanUsd).toBe(20);
    expect(econ.grossPnlTotalUsd).toBe(137); // 120 - 40 + 15 + 10 + 32
    expect(econ.feesTotalUsd).toBe(32);
    expect(econ.borrowTotalUsd).toBe(5);
  });

  it('carries the pinned bootstrap CI for the fixed seed', () => {
    const econ = headlineEconomics(all, { seed: 42 });
    expect(econ.bootstrap).toEqual({ low: -20, high: 66, level: 0.95, draws: 10_000, seed: 42 });
  });

  it('exposes comparison inputs: tbillPerEpisodeUsd and LLM cost totals from R only', () => {
    const econ = headlineEconomics(all, { seed: 42, tbillAnnualRate: 0.05 });
    // 50_000 * 0.05 * 1.125 / 365 (default equity and 27h episode span)
    expect(econ.comparison.tbillPerEpisodeUsd).toBeCloseTo(7.705479452054795, 12);
    expect(econ.comparison.llmCostTotalUsd).toBe(10); // H outlier's $100 excluded
    expect(econ.comparison.llmCostMeanUsd).toBe(2);
    // no rate provided -> comparison not computed
    expect(headlineEconomics(all).comparison.tbillPerEpisodeUsd).toBeNull();
  });

  it('hEconomics is computed separately and carries the conditional label', () => {
    const econ = hEconomics(all, { seed: 42 });
    expect(econ.stratum).toBe('H');
    expect(econ.label).toBe(H_LABEL);
    expect(econ.nEpisodes).toBe(1);
    expect(econ.netPnlTotalUsd).toBe(10_000);
    expect(econ.comparison.llmCostTotalUsd).toBe(100);
  });
});

describe('tbillPerEpisodeUsd', () => {
  it('is equity * rate * days / 365', () => {
    expect(tbillPerEpisodeUsd(0.04, 50_000, 2)).toBeCloseTo(4000 / 365, 12);
    expect(tbillPerEpisodeUsd(0, 50_000, 2)).toBe(0);
  });
});

describe('designWeightedEstimate (H 20/124, R-complement 104/124)', () => {
  const hEps = [
    episode({ day: '2026-05-01', stratum: 'H', trades: [trade({ pnlUsd: 100 })] }), // 100
    episode({ day: '2026-05-02', stratum: 'H', trades: [trade({ pnlUsd: 24 })] }), // 24
  ];
  const rEps = [
    episode({ day: '2026-01-06', trades: [trade({ pnlUsd: 31 })] }),
    episode({ day: '2026-01-07', trades: [trade({ pnlUsd: 31 })] }),
  ];

  it('computes the weighted arithmetic exactly', () => {
    const est = designWeightedEstimate([...hEps, ...rEps]);
    expect(est.weightH).toBeCloseTo(20 / 124, 15);
    expect(est.weightRComplement).toBeCloseTo(104 / 124, 15);
    expect(est.meanHUsd).toBe(62);
    expect(est.meanRUsd).toBe(31);
    // (20 * 62 + 104 * 31) / 124 = 4464 / 124 = 36
    expect(est.estimatePerEpisodeUsd).toBeCloseTo(36, 12);
    expect(est.nH).toBe(2);
    expect(est.nR).toBe(2);
  });

  it('excludes R draws that fall inside an explicit H-stratum day set', () => {
    const rInsideH = episode({ day: '2026-05-09', trades: [trade({ pnlUsd: 1000 })] });
    const est = designWeightedEstimate(
      [...hEps, ...rEps, rInsideH],
      ['2026-05-01', '2026-05-02', '2026-05-09'],
    );
    expect(est.nR).toBe(2); // the 2026-05-09 R draw is excluded from the complement
    expect(est.meanRUsd).toBe(31);
    expect(est.estimatePerEpisodeUsd).toBeCloseTo(36, 12);
  });

  it('returns null when a stratum contributed zero episodes', () => {
    expect(designWeightedEstimate(rEps).estimatePerEpisodeUsd).toBeNull();
    expect(designWeightedEstimate(hEps).estimatePerEpisodeUsd).toBeNull();
  });
});

describe('behavior', () => {
  const rEps = [
    episode({
      day: '2026-01-05',
      abstained: true,
      llmCostUsd: 1,
    }),
    episode({ day: '2026-01-06', abstained: true }),
    episode({
      day: '2026-01-07',
      ordersPlaced: 6,
      ordersFilled: 2,
      rejectionsByReason: { 'exceeds max daily deployment': 2 },
      judgeVetoes: 3,
      danglingAtFlatten: 1,
    }),
    episode({
      day: '2026-01-08',
      ordersPlaced: 4,
      ordersFilled: 2,
      rejectionsByReason: { 'exceeds max daily deployment': 1, 'not shortable': 1 },
      halts: 1,
    }),
    episode({ day: '2026-01-09' }),
    episode({ day: '2026-01-12' }),
  ];
  const hEps = [
    episode({ day: '2026-02-02', stratum: 'H', abstained: true }),
    episode({
      day: '2026-02-03',
      stratum: 'H',
      abstained: true,
      rejectionsByReason: { 'not shortable': 3 },
      danglingAtFlatten: 2,
    }),
  ];
  const rep = behavior([...rEps, ...hEps]);

  it('abstention rate comes from stratum R alone, with Wilson 95% bounds', () => {
    expect(rep.abstention.k).toBe(2);
    expect(rep.abstention.n).toBe(6); // the 2 abstained H episodes never enter
    expect(rep.abstention.p).toBeCloseTo(1 / 3, 12);
    expect(rep.abstention.low).toBeCloseTo(0.09676933255921683, 12);
    expect(rep.abstention.high).toBeCloseTo(0.7000116786584712, 12);
  });

  it('computes fill rate per stratum and combined; null when nothing placed', () => {
    expect(rep.r.ordersPlaced).toBe(10);
    expect(rep.r.ordersFilled).toBe(4);
    expect(rep.r.fillRate).toBeCloseTo(0.4, 12);
    expect(rep.h.fillRate).toBeNull();
    expect(rep.combined.fillRate).toBeCloseTo(0.4, 12);
  });

  it('aggregates rejection, veto, halt, and dangling tables by stratum', () => {
    expect(rep.r.rejectionsByReason).toEqual({
      'exceeds max daily deployment': 3,
      'not shortable': 1,
    });
    expect(rep.h.rejectionsByReason).toEqual({ 'not shortable': 3 });
    expect(rep.combined.rejectionsByReason).toEqual({
      'exceeds max daily deployment': 3,
      'not shortable': 4,
    });
    expect(rep.r.judgeVetoes).toBe(3);
    expect(rep.r.halts).toBe(1);
    expect(rep.combined.danglingAtFlatten).toBe(3);
    expect(rep.combined.episodesWithDangling).toBe(2);
  });
});

describe('attribution', () => {
  // fundamental: 32 trades, 20 net wins -> above the n>=30 floor.
  const fundamentalTrades = [
    ...Array.from({ length: 20 }, () => trade({ pnlUsd: 10, analystsAgreeing: ['fundamental'] })),
    ...Array.from({ length: 12 }, () => trade({ pnlUsd: -10, analystsAgreeing: ['fundamental'] })),
  ];
  // technical: 10 trades; 4 are gross winners turned into net losers by fees.
  const technicalTrades = [
    ...Array.from({ length: 6 }, () => trade({ pnlUsd: 20, analystsAgreeing: ['technical'] })),
    ...Array.from({ length: 4 }, () =>
      trade({ pnlUsd: 5, feesUsd: 10, analystsAgreeing: ['technical'] }),
    ),
  ];
  // bear: agrees on 3 longs (must NOT count) and 2 shorts (1 win, 1 loss).
  const bearTrades = [
    ...Array.from({ length: 3 }, () =>
      trade({ side: 'long', pnlUsd: 50, analystsAgreeing: ['bear'] }),
    ),
    trade({ side: 'short', pnlUsd: 40, borrowUsd: 1, analystsAgreeing: ['bear'] }),
    trade({ side: 'short', pnlUsd: -40, borrowUsd: 1, analystsAgreeing: ['bear'] }),
  ];
  const eps = [
    episode({ day: '2026-01-05', trades: fundamentalTrades }),
    episode({ day: '2026-02-02', stratum: 'H', trades: [...technicalTrades, ...bearTrades] }),
  ];
  const rep = attribution(eps);
  const rowFor = (name: string) => rep.rows.find((r) => r.analyst === name)!;

  it('emits a k/n win row with Wilson interval when n >= 30', () => {
    const f = rowFor('fundamental');
    expect(f).toMatchObject({ k: 20, n: 32, suppressed: false, note: '', shortsOnly: false });
    expect(f.winRate).toBeCloseTo(20 / 32, 12);
    expect(f.wilson).not.toBeNull();
    expect(f.wilson!.low).toBeGreaterThan(0);
    expect(f.wilson!.high).toBeLessThan(1);
    expect(ATTRIBUTION_MIN_N).toBe(30);
  });

  it('suppresses guidance below n=30 with the insufficient-n note', () => {
    const t = rowFor('technical');
    expect(t.n).toBe(10);
    expect(t.k).toBe(6); // fee-eaten gross winners count as losses (net rule)
    expect(t.suppressed).toBe(true);
    expect(t.note).toBe(INSUFFICIENT_N_NOTE);
  });

  it('computes the bear row over shorts only', () => {
    const b = rowFor('bear');
    expect(b.shortsOnly).toBe(true);
    expect(b.n).toBe(2); // the 3 long trades bear agreed on are excluded
    expect(b.k).toBe(1);
    expect(b.suppressed).toBe(true);
  });

  it('emits suppressed empty rows for analysts with no trades', () => {
    for (const name of ['macro', 'sentiment']) {
      const row = rowFor(name);
      expect(row).toMatchObject({ k: 0, n: 0, winRate: null, wilson: null, suppressed: true });
    }
    expect(rep.totalTrades).toBe(47);
  });
});

describe('renderReport', () => {
  const bundle = computeAll(
    [
      ...fiveEpisodes,
      episode({
        day: '2026-04-01',
        stratum: 'H',
        trades: [trade({ pnlUsd: 15, feesUsd: 1, exitReason: 'force-flatten | D+1 20:00' })],
        ordersPlaced: 3,
        ordersFilled: 1,
        rejectionsByReason: { 'not shortable': 1 },
        llmCostUsd: 4,
      }),
    ],
    { seed: 42, tbillAnnualRate: 0.05 },
  );
  const report = renderReport(bundle, {
    tag: 'test-run',
    generatedAt: '2026-07-08T00:00:00Z',
    window: { start: '2026-01-01', end: '2026-07-01' },
    sampleNote: 'full 30R/20H sample (no drop rule fired)',
    validity: { leakage: 'both probe arms complete; 3/3 positive controls tripped' },
  });

  it('is deterministic and carries the §6 section structure', () => {
    expect(renderReport(bundle, { tag: 'test-run' })).toBe(renderReport(bundle, { tag: 'test-run' }));
    for (const heading of [
      '## Read this first — fill realism',
      '## 1. Headline — stratum R economics (defaults, untuned)',
      '### 1.1 Economic bar',
      '## 2. H-stratum economics',
      '## 3. Design-weighted full-window estimate',
      '## 4. Behavior',
      '## 5. Attribution',
      '### Per-trade log',
      '## 6. Sensitivity (descriptive sweep)',
      '## 7. Validity appendix',
    ]) {
      expect(report).toContain(heading);
    }
  });

  it('states fill optimism on page one and labels H economics as conditional', () => {
    expect(report).toContain('optimistic relative to real extended-hours execution');
    expect(report).toContain(H_LABEL);
  });

  it('evaluates the economic bar against T-bill + LLM cost', () => {
    // mean/episode net P&L (R) = $20.00 > 7.71 (T-bill) + 2.00 (LLM) -> passes
    expect(report).toContain('**Economic bar: PASSES**');
    expect(report).toContain('$7.71');
  });

  it('fills provided validity entries and leaves placeholders for the rest', () => {
    expect(report).toContain('both probe arms complete; 3/3 positive controls tripped');
    // 8 remaining validity keys + the mechanical claim line stay TBD
    const placeholders = report.split(VALIDITY_PLACEHOLDER).length - 1;
    expect(placeholders).toBe(9);
    for (const title of ['Leakage', 'Feed choices', 'Fill-model assumptions', 'Split exclusions', 'Survivorship', 'Borrow', 'Judge-cache', 'Tick-cadence', 'Cost actuals']) {
      expect(report).toContain(title);
    }
  });

  it('renders suppression notes and escapes pipes in the per-trade log', () => {
    expect(report).toContain(INSUFFICIENT_N_NOTE);
    expect(report).toContain('bear (shorts only)');
    expect(report).toContain('force-flatten \\| D+1 20:00');
  });
});
