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
