import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ConfigSchema, type Config } from '../src/config.js';
import type {
  AccountSnapshot,
  BrokerOrder,
  ProposedOrder,
  QuoteSnapshot,
  Thesis,
} from '../src/types.js';
import type { BrokerClient } from '../src/broker/client.js';
import type { AlpacaMarketData } from '../src/broker/marketdata.js';

vi.mock('../src/agents/judge.js', () => ({ judgeTick: vi.fn() }));

// paths.ts resolves OUT_DIR from process.cwd() at import time, so each test
// chdirs into a fresh temp dir and re-imports the executor module graph.
let runTick: (typeof import('../src/executor-loop.js'))['runTick'];
let judgeTick: Mock;
let dir: string;
const originalCwd = process.cwd();

// 2026-07-15 is a Wednesday; 13:00Z = 09:00 ET = premarket, entries allowed (>= 08:00).
const NOW = new Date('2026-07-15T13:00:00Z');
const YMD = '2026-07-15';

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offhours-exit-engine-'));
  process.chdir(dir);
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  vi.resetModules();
  const judge = await import('../src/agents/judge.js');
  judgeTick = judge.judgeTick as unknown as Mock;
  judgeTick.mockReset();
  ({ runTick } = await import('../src/executor-loop.js'));
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(dir, { recursive: true, force: true });
});

function baseCfg(): Config {
  return ConfigSchema.parse({ mode: 'paper' });
}

// appendAudit keys files by WALL-clock date (see readAuditTallies in
// scripts/backtest-episode.ts), not the injected tick date — concatenate every
// audit file in the temp out/ dir.
function readAudit(): string {
  const outDir = path.join(dir, 'out');
  return fs
    .readdirSync(outDir)
    .filter((f) => f.startsWith('audit-') && f.endsWith('.jsonl'))
    .map((f) => fs.readFileSync(path.join(outDir, f), 'utf8'))
    .join('');
}

function writeThesis(thesis: Thesis, kind: 'offhours' | 'rth' = 'offhours'): void {
  const file = path.join(
    dir,
    'out',
    kind === 'rth' ? `thesis-${thesis.date}-rth.json` : `thesis-${thesis.date}.json`,
  );
  fs.writeFileSync(file, JSON.stringify(thesis));
}

function quote(ticker: string, bid: number, ask: number): QuoteSnapshot {
  return { ticker, bid, ask, bidSize: 500, askSize: 500, last: (bid + ask) / 2, asOf: NOW.toISOString() };
}

function fakeBroker(account: AccountSnapshot, placed: ProposedOrder[]): BrokerClient {
  return {
    getAccount: async () => account,
    getOpenOrders: async () => [],
    getTodayOrders: async () => [],
    getDailyPl: async () => 0,
    cancelOrdersFor: async () => {},
    getAsset: async () => ({ shortable: true, easyToBorrow: true }),
    placeLimitOrder: async (o: ProposedOrder): Promise<BrokerOrder> => {
      placed.push(o);
      return {
        id: `o-${placed.length}`,
        ticker: o.ticker,
        side: o.side,
        qty: o.qty,
        limitPrice: o.limitPrice,
        status: 'accepted',
        submittedAt: NOW.toISOString(),
        clientOrderId: `${o.intent}-test`,
        filledQty: 0,
      };
    },
  } as unknown as BrokerClient;
}

function fakeMd(quotes: QuoteSnapshot[]): AlpacaMarketData {
  return {
    getLatestQuotes: async () => quotes,
    getNews: async () => [],
  } as unknown as AlpacaMarketData;
}

const shortPosition = {
  ticker: 'FSLR',
  qty: 4,
  avgEntryPrice: 222.23,
  marketValue: -888,
  unrealizedPl: 10,
  side: 'short' as const,
};

function fslrThesis(exit: Record<string, unknown>): Thesis {
  return {
    date: YMD,
    kind: 'offhours',
    generatedAt: '2026-07-14T21:05:00.000Z',
    expiresAt: '2026-07-16T00:00:00.000Z',
    entries: [
      {
        ticker: 'FSLR',
        direction: 'short',
        weightedConviction: 0.6,
        limitBand: { low: 218, high: 228 },
        targetNotionalUsd: 900,
        narrative: 'momentum short',
        invalidationConditions: ['closes above 232'],
        horizon: 'days',
        exit: exit as never,
      },
    ],
    skipped: [],
  };
}

describe('executor exit engine', () => {
  it('time_stop exits a held position without consulting the judge', async () => {
    writeThesis(fslrThesis({ hardStopPct: 8, timeStopHours: 1 }));
    // Seed the peak state: first seen 2h ago.
    fs.writeFileSync(
      path.join(dir, 'out', 'position-peaks.json'),
      JSON.stringify({
        FSLR: { side: 'short', entryTimeMs: NOW.getTime() - 2 * 3_600_000, peak: 220 },
      }),
    );
    const placed: ProposedOrder[] = [];
    await runTick({
      cfg: baseCfg(),
      now: NOW,
      broker: fakeBroker({ equity: 100000, cash: 100000, positions: [shortPosition] }, placed),
      marketData: fakeMd([quote('FSLR', 219.0, 219.1)]),
      llm: {} as never,
    });
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ ticker: 'FSLR', side: 'buy', qty: 4, intent: 'exit' });
    expect(placed[0]!.reason).toContain('time_stop');
    expect(judgeTick).not.toHaveBeenCalled();
    const audit = readAudit();
    expect(audit).toContain('"trigger":"time_stop"');
  });

  it('judge overlay runs only when the engine abstains, and its exit is attributed to judge', async () => {
    writeThesis(fslrThesis({ hardStopPct: 8, timeStopHours: 240 }));
    judgeTick.mockResolvedValue({ proceed: false, exitPosition: true, reasons: ['stated invalidation triggered'] });
    const placed: ProposedOrder[] = [];
    await runTick({
      cfg: baseCfg(),
      now: NOW,
      broker: fakeBroker({ equity: 100000, cash: 100000, positions: [shortPosition] }, placed),
      marketData: fakeMd([quote('FSLR', 219.0, 219.1)]),
      llm: {} as never,
    });
    expect(judgeTick).toHaveBeenCalledTimes(1);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.intent).toBe('exit');
    const audit = readAudit();
    expect(audit).toContain('"trigger":"judge"');
  });

  it('exit_engine.enabled=false reproduces the legacy static-stop path', async () => {
    writeThesis(fslrThesis({ hardStopPct: 2, timeStopHours: 1 })); // would fire under the engine
    const cfg = baseCfg();
    cfg.exit_engine.enabled = false;
    judgeTick.mockResolvedValue({ proceed: false, exitPosition: false, reasons: [] });
    const placed: ProposedOrder[] = [];
    await runTick({
      cfg,
      now: NOW,
      broker: fakeBroker({ equity: 100000, cash: 100000, positions: [shortPosition] }, placed),
      marketData: fakeMd([quote('FSLR', 219.0, 219.1)]),
      llm: {} as never,
    });
    // Short is in profit (mark 219.1 < entry 222.23): legacy stop does not fire,
    // judge declines to exit -> nothing placed, engine plan ignored.
    expect(placed).toHaveLength(0);
  });

  it('starved exit check is audited when a held thesis position has no quote', async () => {
    writeThesis(fslrThesis({ hardStopPct: 8, timeStopHours: 1 }));
    const placed: ProposedOrder[] = [];
    await runTick({
      cfg: baseCfg(),
      now: NOW,
      broker: fakeBroker({ equity: 100000, cash: 100000, positions: [shortPosition] }, placed),
      marketData: fakeMd([]), // market dark
      llm: {} as never,
    });
    expect(placed).toHaveLength(0);
    const audit = readAudit();
    expect(audit).toContain('"stage":"exit_starved"');
  });

  it('RTH entry carries a native stop leg at the resolved plan hard stop', async () => {
    const rthNow = new Date('2026-07-15T15:00:00Z'); // 11:00 ET, inside RTH
    const thesis: Thesis = {
      date: YMD,
      kind: 'rth',
      generatedAt: '2026-07-15T13:00:00.000Z',
      expiresAt: '2026-07-15T20:00:00.000Z',
      entries: [
        {
          ticker: 'GS',
          direction: 'long',
          weightedConviction: 0.6,
          limitBand: { low: 97, high: 103 },
          targetNotionalUsd: 1000,
          narrative: 'earnings re-rating',
          invalidationConditions: [],
          horizon: 'days',
          exit: { hardStopPct: 4, timeStopHours: 30 },
        },
      ],
      skipped: [],
    };
    writeThesis(thesis, 'rth');
    const cfg = baseCfg();
    cfg.sessions.regularhours = true;
    judgeTick.mockResolvedValue({ proceed: true, exitPosition: false, reasons: ['holds'] });
    const placed: ProposedOrder[] = [];
    await runTick({
      cfg,
      now: rthNow,
      broker: fakeBroker({ equity: 100000, cash: 100000, positions: [] }, placed),
      marketData: fakeMd([
        { ticker: 'GS', bid: 99.9, ask: 100, bidSize: 500, askSize: 500, last: 100, asOf: rthNow.toISOString() },
      ]),
      llm: {} as never,
    });
    expect(placed).toHaveLength(1);
    // limit 100 (marketable ask, inside band); stop = 100 * (1 - 4/100) = 96
    expect(placed[0]!.stopLoss).toBe(96);
  });
});

describe('thesis discovery (expiry decides validity, not filename age)', () => {
  // Monday 2026-07-20, 09:00 ET premarket. The newest thesis is Friday
  // 2026-07-17's, expiring Monday 20:00 ET — three calendar days back, which
  // the old today/yesterday lookup could never find (the Monday-premarket
  // blackout: the whole tick skipped, exits included).
  const MONDAY = new Date('2026-07-20T13:00:00Z');

  it('finds Friday evening thesis on Monday premarket and runs its exits', async () => {
    const thesis = fslrThesis({ hardStopPct: 8, timeStopHours: 1 });
    thesis.date = '2026-07-17';
    thesis.generatedAt = '2026-07-17T21:05:00.000Z';
    thesis.expiresAt = '2026-07-21T00:00:00.000Z'; // Mon 20:00 ET
    writeThesis(thesis);
    fs.writeFileSync(
      path.join(dir, 'out', 'position-peaks.json'),
      JSON.stringify({
        FSLR: { side: 'short', entryTimeMs: MONDAY.getTime() - 2 * 3_600_000, peak: 220 },
      }),
    );
    const placed: ProposedOrder[] = [];
    await runTick({
      cfg: baseCfg(),
      now: MONDAY,
      broker: fakeBroker({ equity: 100000, cash: 100000, positions: [shortPosition] }, placed),
      marketData: fakeMd([
        { ticker: 'FSLR', bid: 219.0, ask: 219.1, bidSize: 500, askSize: 500, last: 219.05, asOf: MONDAY.toISOString() },
      ]),
      llm: {} as never,
    });
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ ticker: 'FSLR', side: 'buy', intent: 'exit' });
    expect(readAudit()).not.toContain('"stage":"no_thesis"');
  });

  it('exitEntryFor keeps a days-old thesis entry monitored (no orphan downgrade)', async () => {
    // Active thesis today has no FSLR entry; the position was opened under a
    // thesis 5 days back. Its entry-carried time stop must still fire (the old
    // 2-day lookup degraded this position to stop-only and the time stop was
    // unreachable).
    const active = fslrThesis({ hardStopPct: 8, timeStopHours: 1 });
    active.entries = []; // today's thesis exists but doesn't cover FSLR
    writeThesis(active);
    const old = fslrThesis({ hardStopPct: 8, timeStopHours: 1 });
    old.date = '2026-07-10';
    old.generatedAt = '2026-07-10T21:05:00.000Z';
    old.expiresAt = '2026-07-11T00:00:00.000Z'; // long expired — irrelevant for exits
    writeThesis(old);
    fs.writeFileSync(
      path.join(dir, 'out', 'position-peaks.json'),
      JSON.stringify({
        FSLR: { side: 'short', entryTimeMs: NOW.getTime() - 2 * 3_600_000, peak: 220 },
      }),
    );
    const placed: ProposedOrder[] = [];
    await runTick({
      cfg: baseCfg(),
      now: NOW,
      broker: fakeBroker({ equity: 100000, cash: 100000, positions: [shortPosition] }, placed),
      marketData: fakeMd([quote('FSLR', 219.0, 219.1)]),
      llm: {} as never,
    });
    expect(placed).toHaveLength(1);
    expect(placed[0]!.reason).toContain('time_stop');
    expect(readAudit()).not.toContain('"stage":"orphan_position"');
  });
});

describe('re-entry cooldown after an exit', () => {
  it('blocks a new entry on a name with a filled protective stop today', async () => {
    const thesis = fslrThesis({ hardStopPct: 8, timeStopHours: 240 });
    thesis.entries[0]!.direction = 'long';
    thesis.entries[0]!.limitBand = { low: 215, high: 225 };
    writeThesis(thesis);
    const cfg = baseCfg();
    cfg.entry_cooldown_after_exit = true;
    judgeTick.mockResolvedValue({ proceed: true, exitPosition: false, reasons: ['holds'] });
    const placed: ProposedOrder[] = [];
    const broker = fakeBroker({ equity: 100000, cash: 100000, positions: [] }, placed);
    (broker as { getTodayOrders: () => Promise<unknown[]> }).getTodayOrders = async () => [
      {
        id: 'stop-1',
        ticker: 'FSLR',
        side: 'sell',
        qty: 4,
        type: 'stop',
        limitPrice: 0,
        stopPrice: 210,
        status: 'filled',
        submittedAt: NOW.toISOString(),
        clientOrderId: 'tstop-abc',
        filledQty: 4,
      },
    ];
    await runTick({
      cfg,
      now: NOW,
      broker,
      marketData: fakeMd([quote('FSLR', 219.0, 219.1)]),
      llm: {} as never,
    });
    expect(placed).toHaveLength(0);
    expect(readAudit()).toContain('re-entry cooldown: exited today');
  });

  it('cooldown off (default): the same entry goes through', async () => {
    const thesis = fslrThesis({ hardStopPct: 8, timeStopHours: 240 });
    thesis.entries[0]!.direction = 'long';
    thesis.entries[0]!.limitBand = { low: 215, high: 225 };
    writeThesis(thesis);
    judgeTick.mockResolvedValue({ proceed: true, exitPosition: false, reasons: ['holds'] });
    const placed: ProposedOrder[] = [];
    const broker = fakeBroker({ equity: 100000, cash: 100000, positions: [] }, placed);
    (broker as { getTodayOrders: () => Promise<unknown[]> }).getTodayOrders = async () => [
      {
        id: 'stop-1',
        ticker: 'FSLR',
        side: 'sell',
        qty: 4,
        type: 'stop',
        limitPrice: 0,
        stopPrice: 210,
        status: 'filled',
        submittedAt: NOW.toISOString(),
        clientOrderId: 'tstop-abc',
        filledQty: 4,
      },
    ];
    await runTick({
      cfg: baseCfg(),
      now: NOW,
      broker,
      marketData: fakeMd([quote('FSLR', 219.0, 219.1)]),
      llm: {} as never,
    });
    expect(placed).toHaveLength(1);
    expect(placed[0]!.intent).toBe('entry');
  });
});

describe('scale-out at target (exit_engine.scale_out)', () => {
  it('takes the fraction once, persists the marker, and stays silent next tick', async () => {
    const cfg = ConfigSchema.parse({
      mode: 'paper',
      exit_engine: { scale_out: { enabled: true, target_fraction: 0.5 } },
    });
    const thesis: Thesis = {
      date: YMD,
      kind: 'offhours',
      generatedAt: '2026-07-14T21:05:00.000Z',
      expiresAt: '2026-07-16T00:00:00.000Z',
      entries: [
        {
          ticker: 'NVDA',
          direction: 'long',
          weightedConviction: 0.6,
          limitBand: { low: 195, high: 205 },
          targetNotionalUsd: 3600,
          narrative: 'ai capex',
          invalidationConditions: [],
          horizon: 'days',
          exit: { hardStopPct: 8, target: 210, timeStopHours: 240 } as never,
        },
      ],
      skipped: [],
    };
    writeThesis(thesis);
    const nvdaLong = {
      ticker: 'NVDA',
      qty: 18,
      avgEntryPrice: 201.47,
      marketValue: 3789,
      unrealizedPl: 163,
      side: 'long' as const,
    };
    const targetQuote = (asOf: Date): QuoteSnapshot => ({
      ticker: 'NVDA',
      bid: 210.5,
      ask: 210.6,
      bidSize: 500,
      askSize: 500,
      last: 210.55,
      asOf: asOf.toISOString(),
    });

    const placed1: ProposedOrder[] = [];
    await runTick({
      cfg,
      now: NOW,
      broker: fakeBroker({ equity: 100000, cash: 96000, positions: [nvdaLong] }, placed1),
      marketData: fakeMd([targetQuote(NOW)]),
      llm: {} as never,
    });
    expect(placed1).toHaveLength(1);
    expect(placed1[0]).toMatchObject({ ticker: 'NVDA', side: 'sell', qty: 9, intent: 'exit' });
    expect(placed1[0]!.reason).toContain('scale-out 50%');
    const peaks = JSON.parse(
      fs.readFileSync(path.join(dir, 'out', 'position-peaks.json'), 'utf8'),
    ) as Record<string, { targetScaledOut?: boolean }>;
    expect(peaks.NVDA!.targetScaledOut).toBe(true);

    // Next tick, remainder still above target: the trigger stays silent.
    judgeTick.mockResolvedValue({ proceed: false, exitPosition: false, reasons: [] });
    const later = new Date(NOW.getTime() + 15 * 60_000);
    const placed2: ProposedOrder[] = [];
    await runTick({
      cfg,
      now: later,
      broker: fakeBroker(
        { equity: 100000, cash: 96000, positions: [{ ...nvdaLong, qty: 9 }] },
        placed2,
      ),
      marketData: fakeMd([targetQuote(later)]),
      llm: {} as never,
    });
    expect(placed2).toHaveLength(0);
  });
});

describe('own-earnings entry guard', () => {
  it('blocks a new entry on a name reporting inside the window; degrades open on no data', async () => {
    const thesis = fslrThesis({ hardStopPct: 8, timeStopHours: 240 });
    thesis.entries[0]!.direction = 'long';
    thesis.entries[0]!.limitBand = { low: 215, high: 225 };
    writeThesis(thesis);
    // Fresh cache covering today..+2 with FSLR reporting tomorrow post-close.
    fs.writeFileSync(
      path.join(dir, 'out', 'earnings-cache.json'),
      JSON.stringify({
        fetchedAtMs: NOW.getTime(),
        days: {
          '2026-07-15': [],
          '2026-07-16': [{ symbol: 'FSLR', name: 'First Solar', time: 'post' }],
          '2026-07-17': [],
        },
      }),
    );
    const cfg = baseCfg();
    cfg.execution.earnings_guard.enabled = true;
    judgeTick.mockResolvedValue({ proceed: true, exitPosition: false, reasons: ['holds'] });
    const placed: ProposedOrder[] = [];
    await runTick({
      cfg,
      now: NOW,
      broker: fakeBroker({ equity: 100000, cash: 100000, positions: [] }, placed),
      marketData: fakeMd([quote('FSLR', 219.0, 219.1)]),
      llm: {} as never,
    });
    expect(placed).toHaveLength(0);
    expect(readAudit()).toContain('own-earnings guard: reports 2026-07-16 (post)');
    expect(judgeTick).not.toHaveBeenCalled(); // gated before the LLM spend
  });
});

describe('macro-event entry blackout', () => {
  it('blocks entries inside the window but still places exits', async () => {
    // 09:00 ET on 2026-07-15 with a 09:15 event: inside [08:45, 09:30).
    const thesis = fslrThesis({ hardStopPct: 8, timeStopHours: 1 });
    thesis.entries.push({
      ticker: 'GS',
      direction: 'long',
      weightedConviction: 0.6,
      limitBand: { low: 97, high: 103 },
      targetNotionalUsd: 1000,
      narrative: 'entry candidate',
      invalidationConditions: [],
      horizon: 'days',
      exit: { hardStopPct: 8, timeStopHours: 30 } as never,
    });
    writeThesis(thesis);
    fs.writeFileSync(
      path.join(dir, 'out', 'position-peaks.json'),
      JSON.stringify({
        FSLR: { side: 'short', entryTimeMs: NOW.getTime() - 2 * 3_600_000, peak: 220 },
      }),
    );
    const cfg = baseCfg();
    cfg.macro_event_blackout.events = [{ date: YMD, hm: '09:15', label: 'TEST-EVENT' }];
    const placed: ProposedOrder[] = [];
    await runTick({
      cfg,
      now: NOW,
      broker: fakeBroker({ equity: 100000, cash: 100000, positions: [shortPosition] }, placed),
      marketData: fakeMd([quote('FSLR', 219.0, 219.1), quote('GS', 99.9, 100.0)]),
      llm: {} as never,
    });
    // The FSLR time_stop exit fires; the GS entry is blocked by the event window.
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ ticker: 'FSLR', intent: 'exit' });
    const audit = readAudit();
    expect(audit).toContain('"stage":"event_blackout"');
    expect(audit).toContain('TEST-EVENT');
  });
});

describe('trail debounce (exit_engine.trail_debounce)', () => {
  const debounceCfg = (): Config =>
    ConfigSchema.parse({
      mode: 'paper',
      exit_engine: {
        trail: { activate_pct: 5, trail_pct: 4 },
        trail_debounce: { confirm_ticks: 2, min_exit_top_size: 100 },
      },
    });

  const nvdaLong = {
    ticker: 'NVDA',
    qty: 18,
    avgEntryPrice: 201.47,
    marketValue: 3543,
    unrealizedPl: -83,
    side: 'long' as const,
  };

  function seedPeak(at: Date): void {
    fs.writeFileSync(
      path.join(dir, 'out', 'position-peaks.json'),
      JSON.stringify({
        NVDA: { side: 'long', entryTimeMs: at.getTime() - 6 * 86_400_000, peak: 214.39 },
      }),
    );
    fs.writeFileSync(
      path.join(dir, 'out', `thesis-${YMD}.json`),
      JSON.stringify({
        date: YMD,
        kind: 'offhours',
        generatedAt: '2026-07-14T21:05:00.000Z',
        expiresAt: '2026-07-16T00:00:00.000Z',
        entries: [],
        skipped: [],
      }),
    );
  }

  const retracedQuote = (asOf: Date): QuoteSnapshot => ({
    ticker: 'NVDA',
    bid: 197.0,
    ask: 197.1,
    bidSize: 500,
    askSize: 500,
    last: 197.05,
    asOf: asOf.toISOString(),
  });

  it('first trigger tick goes pending; the second consecutive tick exits', async () => {
    seedPeak(NOW);
    const placed1: ProposedOrder[] = [];
    await runTick({
      cfg: debounceCfg(),
      now: NOW,
      broker: fakeBroker({ equity: 100000, cash: 78000, positions: [nvdaLong] }, placed1),
      marketData: fakeMd([retracedQuote(NOW)]),
      llm: {} as never,
    });
    expect(placed1).toHaveLength(0);
    expect(readAudit()).toContain('"stage":"trail_pending"');
    const peaks = JSON.parse(
      fs.readFileSync(path.join(dir, 'out', 'position-peaks.json'), 'utf8'),
    ) as Record<string, { trailPendingCount?: number }>;
    expect(peaks.NVDA!.trailPendingCount).toBe(1);

    const later = new Date(NOW.getTime() + 15 * 60_000);
    const placed2: ProposedOrder[] = [];
    await runTick({
      cfg: debounceCfg(),
      now: later,
      broker: fakeBroker({ equity: 100000, cash: 78000, positions: [nvdaLong] }, placed2),
      marketData: fakeMd([retracedQuote(later)]),
      llm: {} as never,
    });
    expect(placed2).toHaveLength(1);
    expect(placed2[0]!.reason).toContain('trail');
  });

  it('a thin exit-side book never counts toward confirmation', async () => {
    seedPeak(NOW);
    const thin: QuoteSnapshot = { ...retracedQuote(NOW), bidSize: 1 };
    const placed: ProposedOrder[] = [];
    await runTick({
      cfg: debounceCfg(),
      now: NOW,
      broker: fakeBroker({ equity: 100000, cash: 78000, positions: [nvdaLong] }, placed),
      marketData: fakeMd([thin]),
      llm: {} as never,
    });
    expect(placed).toHaveLength(0);
    expect(readAudit()).toContain('"sizeOk":false');
    const peaks = JSON.parse(
      fs.readFileSync(path.join(dir, 'out', 'position-peaks.json'), 'utf8'),
    ) as Record<string, { trailPendingCount?: number }>;
    expect(peaks.NVDA!.trailPendingCount).toBeUndefined();
  });

  it('hard stop is never debounced', async () => {
    seedPeak(NOW);
    // loss vs entry 201.47 at bid 180 = 10.7% >= 8% hard stop
    const crashed: QuoteSnapshot = { ...retracedQuote(NOW), bid: 180.0, ask: 180.2, bidSize: 1 };
    const placed: ProposedOrder[] = [];
    await runTick({
      cfg: debounceCfg(),
      now: NOW,
      broker: fakeBroker({ equity: 100000, cash: 78000, positions: [nvdaLong] }, placed),
      marketData: fakeMd([crashed]),
      llm: {} as never,
    });
    expect(placed).toHaveLength(1);
    expect(placed[0]!.reason).toContain('hard_stop');
  });
});

describe('OCO protective exit legs (RTH only)', () => {
  const RTH_NOW = new Date('2026-07-15T15:00:00Z'); // 11:00 ET

  it('judge-triggered RTH exit carries a protective stop on the far side of the limit', async () => {
    const thesis: Thesis = {
      date: YMD,
      kind: 'rth',
      generatedAt: '2026-07-15T13:00:00.000Z',
      expiresAt: '2026-07-15T21:00:00.000Z',
      entries: [
        {
          ticker: 'FSLR',
          direction: 'short',
          weightedConviction: 0.6,
          limitBand: { low: 218, high: 228 },
          targetNotionalUsd: 900,
          narrative: 'momentum short',
          invalidationConditions: ['closes above 232'],
          horizon: 'days',
          exit: { hardStopPct: 8, timeStopHours: 240 } as never,
        },
      ],
      skipped: [],
    };
    writeThesis(thesis, 'rth');
    const cfg = baseCfg();
    cfg.sessions.regularhours = true;
    judgeTick.mockResolvedValue({ proceed: false, exitPosition: true, reasons: ['invalidation triggered'] });
    const placed: ProposedOrder[] = [];
    await runTick({
      cfg,
      now: RTH_NOW,
      broker: fakeBroker({ equity: 100000, cash: 100000, positions: [shortPosition] }, placed),
      marketData: fakeMd([
        { ticker: 'FSLR', bid: 219.0, ask: 219.1, bidSize: 500, askSize: 500, last: 219.05, asOf: RTH_NOW.toISOString() },
      ]),
      llm: {} as never,
    });
    expect(placed).toHaveLength(1);
    expect(placed[0]!.intent).toBe('exit');
    expect(placed[0]!.extendedHours).toBe(false);
    // short protective stop: entry 222.23 * 1.08 = 240.01, above the 219.10 limit
    expect(placed[0]!.protectiveStop).toBe(240.01);
  });

  it('extended-hours exits stay plain (stops cannot execute there)', async () => {
    writeThesis(fslrThesis({ hardStopPct: 8, timeStopHours: 1 }));
    fs.writeFileSync(
      path.join(dir, 'out', 'position-peaks.json'),
      JSON.stringify({
        FSLR: { side: 'short', entryTimeMs: NOW.getTime() - 2 * 3_600_000, peak: 220 },
      }),
    );
    const placed: ProposedOrder[] = [];
    await runTick({
      cfg: baseCfg(),
      now: NOW, // premarket
      broker: fakeBroker({ equity: 100000, cash: 100000, positions: [shortPosition] }, placed),
      marketData: fakeMd([quote('FSLR', 219.0, 219.1)]),
      llm: {} as never,
    });
    expect(placed).toHaveLength(1);
    expect(placed[0]!.protectiveStop).toBeUndefined();
  });
});

describe('native stop ratchet', () => {
  const ratchetCfg = (): Config =>
    ConfigSchema.parse({
      mode: 'paper',
      exit_engine: {
        trail: { activate_pct: 5, trail_pct: 4 },
        native_stop_ratchet: { enabled: true },
      },
    });

  const nvdaLong = {
    ticker: 'NVDA',
    qty: 18,
    avgEntryPrice: 201.47,
    marketValue: 3543,
    unrealizedPl: -83,
    side: 'long' as const,
  };

  function emptyThesis(): Thesis {
    return {
      date: YMD,
      kind: 'offhours',
      generatedAt: '2026-07-14T21:05:00.000Z',
      expiresAt: '2026-07-16T00:00:00.000Z',
      entries: [],
      skipped: [],
    };
  }

  interface StopCalls {
    stops: { ticker: string; side: string; qty: number; stopPrice: number }[];
    cancels: string[];
  }

  function ratchetBroker(
    account: AccountSnapshot,
    openOrders: BrokerOrder[],
    calls: StopCalls,
    placed: ProposedOrder[] = [],
  ): BrokerClient {
    return {
      getAccount: async () => account,
      getOpenOrders: async () => openOrders,
      getTodayOrders: async () => [],
      getDailyPl: async () => 0,
      cancelOrdersFor: async () => {},
      getAsset: async () => ({ shortable: true, easyToBorrow: true }),
      placeLimitOrder: async (o: ProposedOrder): Promise<BrokerOrder> => {
        placed.push(o);
        return {
          id: `o-${placed.length}`,
          ticker: o.ticker,
          side: o.side,
          qty: o.qty,
          limitPrice: o.limitPrice,
          status: 'accepted',
          submittedAt: NOW.toISOString(),
          clientOrderId: `${o.intent}-test`,
          filledQty: 0,
        };
      },
      placeStopOrder: async (o: {
        ticker: string;
        side: 'buy' | 'sell';
        qty: number;
        stopPrice: number;
      }): Promise<BrokerOrder> => {
        calls.stops.push(o);
        return {
          id: `stop-${calls.stops.length}`,
          ticker: o.ticker,
          side: o.side,
          qty: o.qty,
          limitPrice: 0,
          stopPrice: o.stopPrice,
          status: 'accepted',
          submittedAt: NOW.toISOString(),
          clientOrderId: 'tstop-test',
          filledQty: 0,
        };
      },
      cancelOrder: async (id: string) => {
        calls.cancels.push(id);
      },
    } as unknown as BrokerClient;
  }

  function restingStop(id: string, stopPrice: number, qty = 18): BrokerOrder {
    return {
      id,
      ticker: 'NVDA',
      side: 'sell',
      qty,
      type: 'stop',
      limitPrice: 0,
      stopPrice,
      timeInForce: 'gtc',
      status: 'new',
      submittedAt: '2026-07-09T15:07:00Z',
      clientOrderId: 'manual-1',
      filledQty: 0,
    };
  }

  it('places a missing protective stop at the hard-stop level (unarmed)', async () => {
    writeThesis(emptyThesis());
    const calls: StopCalls = { stops: [], cancels: [] };
    await runTick({
      cfg: ratchetCfg(),
      now: NOW,
      broker: ratchetBroker({ equity: 100000, cash: 78000, positions: [nvdaLong] }, [], calls),
      marketData: fakeMd([quote('NVDA', 196.0, 196.1)]),
      llm: {} as never,
    });
    expect(calls.cancels).toEqual([]);
    expect(calls.stops).toEqual([
      { ticker: 'NVDA', side: 'sell', qty: 18, stopPrice: 185.35 },
    ]);
    expect(readAudit()).toContain('"kind":"stop_ratchet"');
  });

  it('armed by the persisted peak: cancels the stale stop and ratchets up', async () => {
    writeThesis(emptyThesis());
    fs.writeFileSync(
      path.join(dir, 'out', 'position-peaks.json'),
      JSON.stringify({
        NVDA: { side: 'long', entryTimeMs: NOW.getTime() - 6 * 86_400_000, peak: 214.39 },
      }),
    );
    const calls: StopCalls = { stops: [], cancels: [] };
    await runTick({
      cfg: ratchetCfg(),
      now: NOW,
      broker: ratchetBroker(
        { equity: 100000, cash: 78000, positions: [nvdaLong] },
        [restingStop('stop-old', 185.55)],
        calls,
      ),
      marketData: fakeMd([quote('NVDA', 207.0, 207.1)]),
      llm: {} as never,
    });
    // max(hard 185.35, breakeven 201.47, peak 214.39 * 0.96 = 205.8144) -> 205.81
    expect(calls.cancels).toEqual(['stop-old']);
    expect(calls.stops).toEqual([
      { ticker: 'NVDA', side: 'sell', qty: 18, stopPrice: 205.81 },
    ]);
  });

  it('never loosens: an already-tighter resting stop is left alone', async () => {
    writeThesis(emptyThesis());
    fs.writeFileSync(
      path.join(dir, 'out', 'position-peaks.json'),
      JSON.stringify({
        NVDA: { side: 'long', entryTimeMs: NOW.getTime() - 6 * 86_400_000, peak: 214.39 },
      }),
    );
    const calls: StopCalls = { stops: [], cancels: [] };
    await runTick({
      cfg: ratchetCfg(),
      now: NOW,
      broker: ratchetBroker(
        { equity: 100000, cash: 78000, positions: [nvdaLong] },
        [restingStop('stop-tight', 206.5)],
        calls,
      ),
      marketData: fakeMd([quote('NVDA', 207.0, 207.1)]),
      llm: {} as never,
    });
    expect(calls.cancels).toEqual([]);
    expect(calls.stops).toEqual([]);
  });

  it('stays dark when native_stop_ratchet is disabled (default)', async () => {
    writeThesis(emptyThesis());
    const calls: StopCalls = { stops: [], cancels: [] };
    await runTick({
      cfg: baseCfg(),
      now: NOW,
      broker: ratchetBroker({ equity: 100000, cash: 78000, positions: [nvdaLong] }, [], calls),
      marketData: fakeMd([quote('NVDA', 196.0, 196.1)]),
      llm: {} as never,
    });
    expect(calls.stops).toEqual([]);
    expect(readAudit()).not.toContain('"kind":"stop_ratchet"');
  });

  it('a canceled resting stop no longer counts as a duplicate against the exit order', async () => {
    writeThesis(emptyThesis());
    fs.writeFileSync(
      path.join(dir, 'out', 'position-peaks.json'),
      JSON.stringify({
        NVDA: { side: 'long', entryTimeMs: NOW.getTime() - 6 * 86_400_000, peak: 214.39 },
      }),
    );
    const calls: StopCalls = { stops: [], cancels: [] };
    const placed: ProposedOrder[] = [];
    await runTick({
      cfg: ratchetCfg(),
      now: NOW,
      broker: ratchetBroker(
        { equity: 100000, cash: 78000, positions: [nvdaLong] },
        [restingStop('stop-old', 185.55)],
        calls,
        placed,
      ),
      // retrace from peak 214.39 to 197 = 8.1% >= 4% -> deterministic trail exit
      marketData: fakeMd([quote('NVDA', 197.0, 197.1)]),
      llm: {} as never,
    });
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ ticker: 'NVDA', side: 'sell', qty: 18, intent: 'exit' });
    expect(readAudit()).not.toContain('duplicate open order');
    expect(calls.stops).toEqual([]); // exit placed: the ratchet must stay away
  });

  it('no unexpired thesis: exits and the ratchet still run (positions never go dark)', async () => {
    // No thesis file at all. The old executor returned before the exit loop,
    // leaving open positions unmonitored (every Monday premarket). Now the
    // tick continues in exits-only mode: the ratchet must still place the
    // protective stop.
    const calls: StopCalls = { stops: [], cancels: [] };
    await runTick({
      cfg: ratchetCfg(),
      now: NOW,
      broker: ratchetBroker({ equity: 100000, cash: 78000, positions: [nvdaLong] }, [], calls),
      marketData: fakeMd([quote('NVDA', 196.0, 196.1)]),
      llm: {} as never,
    });
    expect(calls.stops).toEqual([{ ticker: 'NVDA', side: 'sell', qty: 18, stopPrice: 185.35 }]);
    const audit = readAudit();
    expect(audit).toContain('"stage":"no_thesis"');
    expect(audit).toContain('"action":"exits_only"');
  });

  it('skips a position that exited this tick instead of re-arming a stop under its exit order', async () => {
    writeThesis(fslrThesis({ hardStopPct: 8, timeStopHours: 1 }));
    fs.writeFileSync(
      path.join(dir, 'out', 'position-peaks.json'),
      JSON.stringify({
        FSLR: { side: 'short', entryTimeMs: NOW.getTime() - 2 * 3_600_000, peak: 220 },
      }),
    );
    const calls: StopCalls = { stops: [], cancels: [] };
    const placed: ProposedOrder[] = [];
    await runTick({
      cfg: ratchetCfg(),
      now: NOW,
      broker: ratchetBroker(
        { equity: 100000, cash: 100000, positions: [shortPosition] },
        [],
        calls,
        placed,
      ),
      marketData: fakeMd([quote('FSLR', 219.0, 219.1)]),
      llm: {} as never,
    });
    expect(placed).toHaveLength(1);
    expect(placed[0]!.intent).toBe('exit');
    expect(calls.stops).toEqual([]);
  });
});
