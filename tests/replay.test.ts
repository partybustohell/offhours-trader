import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi, type Mock } from 'vitest';
import { callStructured, type StructuredCallOpts } from '../src/agents/llm.js';
import { ANALYST_SYSTEM } from '../src/agents/prompts.js';
import {
  runNominations,
  type NewsItem,
  type NominationRound,
  type Scans,
} from '../src/agents/nominate.js';
import { runVerdicts, type DailyBar } from '../src/agents/verdicts.js';
import { buildCandidates, type TickerMarketInfo } from '../src/candidates.js';
import { computeThesisEntries, thesisExpiry } from '../src/synthesis.js';
import { riskCheck, type RiskContext } from '../src/risk.js';
import { ConfigSchema, type Config } from '../src/config.js';
import {
  ANALYSTS,
  type AccountSnapshot,
  type AnalystName,
  type CandidateFile,
  type ProposedOrder,
  type QuoteSnapshot,
  type Thesis,
  type ThesisEntry,
  type Verdict,
  type VerdictFile,
} from '../src/types.js';

// Replay integration test: a full recorded evening (Round 1 -> candidates ->
// Round 2 -> synthesis) followed by an executor-tick gate replay in dry-run.
// All LLM calls are mocked (callStructured returns fixture data keyed by
// toolName + system prompt) and all market data comes from fixtures/*.json;
// nothing touches the network or writes to out/.

vi.mock('../src/agents/llm.js', () => ({ callStructured: vi.fn() }));

const callStructuredMock = callStructured as unknown as Mock<
  (opts: StructuredCallOpts) => Promise<unknown>
>;

const DATE = '2026-07-07'; // fixed replay date (a Tuesday, ET)

const FIXTURES = new URL('../fixtures/', import.meta.url);
function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as T;
}

type NominationsFixture = Record<
  AnalystName,
  { nominations: { ticker: string; reason: string }[] }
>;
type VerdictsFixture = Record<AnalystName, { verdicts: Omit<Verdict, 'analyst'>[] }>;
type QuotesFixture = Record<'pass' | 'wideSpread' | 'outsideBand', QuoteSnapshot>;

const scans = loadFixture<Scans>('scans.json');
const barsBySymbol = loadFixture<Record<string, DailyBar[]>>('bars.json');
const quotes = loadFixture<QuotesFixture>('quotes.json');
const nominationsFixture = loadFixture<NominationsFixture>('llm-nominations.json');
const verdictsFixture = loadFixture<VerdictsFixture>('llm-verdicts.json');

function analystFor(system: string): AnalystName {
  const found = ANALYSTS.find((a) => ANALYST_SYSTEM[a] === system);
  if (!found) throw new Error('callStructured called with an unknown system prompt');
  return found;
}

// Same math as AlpacaMarketData.marketInfoFor, fed from fixtures/bars.json:
// lastPrice = most recent close; avgDollarVolume20d = mean(close*volume) over
// up to the 20 most recent bars. Symbols without bars are omitted.
function marketInfoFromBars(bars: Record<string, DailyBar[]>): Map<string, TickerMarketInfo> {
  const out = new Map<string, TickerMarketInfo>();
  for (const [symbol, list] of Object.entries(bars)) {
    if (list.length === 0) continue;
    const recent = list.slice(-20);
    const avgDollarVolume20d = recent.reduce((sum, b) => sum + b.c * b.v, 0) / recent.length;
    out.set(symbol, { lastPrice: list[list.length - 1]!.c, avgDollarVolume20d });
  }
  return out;
}

// Mirrors the executor's entry gates in src/executor-loop.ts (spread bps ->
// quote size -> limit band -> limit price -> qty), i.e. everything between the
// quote fetch and the risk gate. Returns the proposed order or the skip reason.
type GateOutcome = { order: ProposedOrder; skip: null } | { order: null; skip: string };
function replayEntryGate(entry: ThesisEntry, quote: QuoteSnapshot, cfg: Config): GateOutcome {
  const mid = (quote.ask + quote.bid) / 2;
  const spreadBps = mid > 0 ? ((quote.ask - quote.bid) / mid) * 10000 : Infinity;
  if (spreadBps > cfg.max_spread_bps) {
    return { order: null, skip: 'spread exceeds max_spread_bps' };
  }
  if (quote.bidSize < 1 || quote.askSize < 1) {
    return { order: null, skip: 'insufficient quote size' };
  }
  if (quote.last < entry.limitBand.low || quote.last > entry.limitBand.high) {
    return { order: null, skip: 'last price outside limit band' };
  }
  const limitPrice =
    entry.direction === 'long'
      ? Math.min(quote.ask, entry.limitBand.high)
      : Math.max(quote.bid, entry.limitBand.low);
  const qty = Math.floor(entry.targetNotionalUsd / limitPrice);
  if (qty < 1) return { order: null, skip: 'target notional below one share' };
  return {
    order: {
      ticker: entry.ticker,
      side: entry.direction === 'long' ? 'buy' : 'sell',
      qty,
      limitPrice,
      extendedHours: true,
      intent: 'entry',
      reason: 'thesis entry conditions hold',
    },
    skip: null,
  };
}

// TSLA is excluded and max_candidates 5 forces one cap rejection; everything
// else is spec defaults (quorum 3, threshold 0.65, weights F1.0 T0.8 M0.6
// S1.0 B1.2, max_order_notional 2000, max_position_pct 5, spread 50 bps,
// chase 1%, drop 3%).
const cfg: Config = ConfigSchema.parse({
  universe: { exclude: ['TSLA'], max_candidates: 5 },
});
const account: AccountSnapshot = { equity: 100_000, cash: 100_000, positions: [] };
const marketInfo = marketInfoFromBars(barsBySymbol);

let round1: NominationRound;
let candidateFile: CandidateFile;
let verdictFile: VerdictFile;
let computed: ReturnType<typeof computeThesisEntries>;
let thesis: Thesis;

beforeAll(async () => {
  callStructuredMock.mockImplementation(async (opts) => {
    const analyst = analystFor(opts.system);
    switch (opts.toolName) {
      case 'submit_nominations':
        return nominationsFixture[analyst];
      case 'submit_verdicts':
        return verdictsFixture[analyst];
      default:
        throw new Error(`unexpected tool ${opts.toolName} for analyst ${analyst}`);
    }
  });

  round1 = await runNominations(cfg, scans);
  candidateFile = buildCandidates(round1.nominations, marketInfo, cfg, DATE);

  const newsBySymbol: Record<string, NewsItem[]> = {};
  for (const item of scans.news) {
    for (const symbol of item.symbols) (newsBySymbol[symbol] ??= []).push(item);
  }
  verdictFile = await runVerdicts(cfg, candidateFile, { barsBySymbol, newsBySymbol });

  computed = computeThesisEntries(verdictFile.verdicts, marketInfo, account, cfg);
  thesis = {
    date: DATE,
    kind: 'offhours',
    generatedAt: '2026-07-07T21:05:00.000Z', // 17:05 ET, fixed
    expiresAt: thesisExpiry(DATE),
    entries: computed.entries.map((e) => ({ ...e, narrative: '' })),
    skipped: computed.skipped,
  };
});

describe('round 1: nominations with mocked callStructured', () => {
  it('collects all five analysts with nothing dropped', () => {
    expect(round1.dropped).toEqual([]);
    expect(round1.nominations.map((n) => n.analyst)).toEqual(ANALYSTS);
  });

  it('returns each analyst its fixture slate (tickers uppercased by sanitize)', () => {
    const byAnalyst = new Map(round1.nominations.map((n) => [n.analyst, n.nominations]));
    expect(byAnalyst.get('fundamental')!.map((n) => n.ticker)).toEqual(['NVDA', 'AAPL', 'TSLA']);
    expect(byAnalyst.get('technical')!.map((n) => n.ticker)).toEqual(['NVDA', 'AMD', 'PENY']);
    expect(byAnalyst.get('macro')!.map((n) => n.ticker)).toEqual(['AAPL', 'XOM']);
    // fixture has lowercase 'nvda'; sanitize uppercases it
    expect(byAnalyst.get('sentiment')!.map((n) => n.ticker)).toEqual(['NVDA', 'GME', 'GHOST']);
    expect(byAnalyst.get('bear')!.map((n) => n.ticker)).toEqual(['NVDA', 'COIN', 'INTC']);
  });

  it('made one submit_nominations call per analyst, keyed by system prompt', () => {
    const calls = callStructuredMock.mock.calls
      .map((call) => call[0])
      .filter((opts) => opts.toolName === 'submit_nominations');
    expect(calls).toHaveLength(5);
    expect(calls.map((opts) => analystFor(opts.system))).toEqual(ANALYSTS);
    for (const opts of calls) expect(opts.model).toBe(cfg.model.analysts);
  });
});

describe('candidate build against fixture market info', () => {
  it('derives the expected market info from bars.json', () => {
    // NVDA: mean(96*6.25e6, 100*4e6) = (600M + 400M)/2 = 500M; last close 100
    expect(marketInfo.get('NVDA')).toEqual({ lastPrice: 100, avgDollarVolume20d: 500_000_000 });
    // COIN: (240*300k + 250*192k)/2 = (72M + 48M)/2 = 60M; last close 250
    expect(marketInfo.get('COIN')).toEqual({ lastPrice: 250, avgDollarVolume20d: 60_000_000 });
    // GME: (19*1M + 22*500k)/2 = (19M + 11M)/2 = 15M -> below the 20M floor
    expect(marketInfo.get('GME')).toEqual({ lastPrice: 22, avgDollarVolume20d: 15_000_000 });
    expect(marketInfo.has('GHOST')).toBe(false);
  });

  it('keeps exactly the surviving set, ranked by nomination count then dollar volume', () => {
    // NVDA 4 nominations; AAPL 2; then 1-nomination ties ordered by ADV:
    // AMD 80M > COIN 60M > INTC 45M (XOM 40M falls to the cap of 5).
    expect(candidateFile.date).toBe(DATE);
    expect(candidateFile.candidates.map((c) => c.ticker)).toEqual([
      'NVDA',
      'AAPL',
      'AMD',
      'COIN',
      'INTC',
    ]);
    expect(candidateFile.candidates.map((c) => c.avgDollarVolume20d)).toEqual([
      500_000_000, 300_000_000, 80_000_000, 60_000_000, 45_000_000,
    ]);
    const nvda = candidateFile.candidates[0]!;
    expect(nvda.lastPrice).toBe(100);
    expect(nvda.nominatedBy.map((n) => n.analyst)).toEqual([
      'fundamental',
      'technical',
      'sentiment',
      'bear',
    ]);
  });

  it('rejects with the exact canonical reasons', () => {
    expect(candidateFile.rejected).toEqual([
      { ticker: 'TSLA', reason: 'on exclude list' },
      { ticker: 'PENY', reason: 'price below min_price' }, // last 3.50 < 5
      { ticker: 'GME', reason: 'dollar volume below min_avg_dollar_volume' }, // 15M < 20M
      { ticker: 'GHOST', reason: 'no market data' }, // absent from bars.json
      { ticker: 'XOM', reason: 'over max_candidates cap' }, // 6th of 5, lowest ADV among 1-nom ties
    ]);
  });
});

describe('round 2: verdicts with mocked callStructured', () => {
  it('collects fixture verdicts from all five analysts with none dropped', () => {
    expect(verdictFile.date).toBe(DATE);
    expect(verdictFile.droppedAnalysts).toEqual([]);
    expect(verdictFile.verdicts).toHaveLength(18);
    const countFor = (t: string): number =>
      verdictFile.verdicts.filter((v) => v.ticker === t).length;
    expect(countFor('NVDA')).toBe(5);
    expect(countFor('AAPL')).toBe(5);
    expect(countFor('AMD')).toBe(3);
    expect(countFor('COIN')).toBe(3);
    expect(countFor('INTC')).toBe(2); // below quorum by design
  });

  it('includes none verdicts and the bear short, with analyst injected by code', () => {
    expect(verdictFile.verdicts.filter((v) => v.direction === 'none')).toHaveLength(7);
    const bearCoin = verdictFile.verdicts.find(
      (v) => v.analyst === 'bear' && v.ticker === 'COIN',
    );
    expect(bearCoin).toMatchObject({ direction: 'short', conviction: 0.9 });
  });

  it('made one submit_verdicts call per analyst', () => {
    const calls = callStructuredMock.mock.calls
      .map((call) => call[0])
      .filter((opts) => opts.toolName === 'submit_verdicts');
    expect(calls).toHaveLength(5);
    expect(calls.map((opts) => analystFor(opts.system))).toEqual(ANALYSTS);
  });
});

describe('synthesis: hand-computed conviction, skips, bands, sizing', () => {
  it('produces exactly the NVDA long and COIN short entries', () => {
    expect(computed.entries.map((e) => [e.ticker, e.direction])).toEqual([
      ['NVDA', 'long'],
      ['COIN', 'short'],
    ]);
  });

  it('skips AAPL below threshold, AMD on disagreement, INTC on quorum', () => {
    // AAPL (5 respond, weight sum 4.6): longScore = (1.0*0.6 + 1.0*0.5)/4.6
    //   = 1.1/4.6 = 0.2391 < 0.65 -> below threshold.
    // AMD (F/T/M respond, weight sum 2.4): longScore = 1.0*0.9/2.4 = 0.375;
    //   shortScore = 0.8*0.9/2.4 = 0.3 -> min(0.375, 0.3) >= 0.3 -> disagreement.
    // INTC: 2 verdicts < quorum 3 -> quorum.
    expect(computed.skipped).toEqual([
      { ticker: 'AAPL', reason: 'below threshold' },
      { ticker: 'AMD', reason: 'disagreement' },
      { ticker: 'INTC', reason: 'quorum' },
    ]);
  });

  it('NVDA: weighted conviction, band, sizing, invalidation union', () => {
    const nvda = computed.entries[0]!;
    // Directional normalization: long verdicts F/T/M/S all at 0.9, directional
    // weight = 1.0+0.8+0.6+1.0 = 3.4; bear 'none' 0.5 counts toward quorum but
    // stays out of the denominator:
    //   longScore = 0.9*3.4/3.4 = 0.9 >= 0.65 threshold.
    expect(nvda.weightedConviction).toBeCloseTo(0.9, 10);
    // Long band around lastPrice 100: low 100*(1-3%) = 97, high 100*(1+1%) = 101.
    expect(nvda.limitBand.low).toBeCloseTo(97, 10);
    expect(nvda.limitBand.high).toBeCloseTo(101, 10);
    // Sizing: min(2000, 100000*5% = 5000) = 2000 base; 2000 * 0.9 = 1800.00.
    expect(nvda.targetNotionalUsd).toBe(1800);
    // Union of invalidation conditions from long verdicts only (F, T, M, S);
    // macro repeats fundamental's condition and is deduplicated.
    expect(nvda.invalidationConditions).toEqual([
      'NVDA closes below 95',
      'NVDA breaks below 96 on volume',
      'guidance walked back',
    ]);
  });

  it('COIN: bear-led short with mirrored band', () => {
    const coin = computed.entries[1]!;
    // Responders T(0.8) short 0.8, M(0.6) none 0.3, B(1.2) short 0.9:
    //   directional weight = 0.8+1.2 = 2.0 ('none' excluded)
    //   shortScore = (0.8*0.8 + 1.2*0.9)/2.0 = 1.72/2.0 = 0.86 >= 0.65;
    //   longScore 0 -> no disagreement; two agreeing shorts meet min_agreeing.
    expect(coin.weightedConviction).toBeCloseTo(0.86, 10);
    // Short band around lastPrice 250: low 250*(1-1%) = 247.5, high 250*(1+3%) = 257.5.
    expect(coin.limitBand.low).toBeCloseTo(247.5, 10);
    expect(coin.limitBand.high).toBeCloseTo(257.5, 10);
    // 2000 * 0.86 = 1720.00.
    expect(coin.targetNotionalUsd).toBe(1720);
    expect(coin.invalidationConditions).toEqual([
      'COIN reclaims 252 on volume',
      'Enforcement action dismissed or settled',
    ]);
  });

  it('assembles a thesis expiring 20:00 ET the next weekday', () => {
    // 2026-07-07 is a Tuesday -> Wed 2026-07-08 20:00 EDT = 2026-07-09T00:00Z.
    expect(thesis.expiresAt).toBe('2026-07-09T00:00:00.000Z');
    expect(new Date(thesis.expiresAt).getTime()).toBeGreaterThan(
      new Date(thesis.generatedAt).getTime(),
    );
  });
});

describe('executor tick replay (dry-run gate math + risk gate)', () => {
  const riskCtx = (halted: boolean): RiskContext => ({
    config: cfg,
    account,
    openOrders: [],
    deployedTodayUsd: 0,
    dailyPl: 0,
    halted,
  });

  it('passing quote yields a risk-approved order with qty = floor(target/limit)', () => {
    const nvda = thesis.entries[0]!;
    const outcome = replayEntryGate(nvda, quotes.pass, cfg);
    // spread = (100.10-100.00)/100.05 * 10000 = 9.995 bps <= 50; sizes 5/4 >= 1;
    // last 100.05 inside [97, 101];
    // limitPrice = min(ask 100.10, band.high 101) = 100.10;
    // qty = floor(1800 / 100.10) = floor(17.98...) = 17.
    expect(outcome.skip).toBeNull();
    expect(outcome.order).toEqual({
      ticker: 'NVDA',
      side: 'buy',
      qty: 17,
      limitPrice: 100.1,
      extendedHours: true,
      intent: 'entry',
      reason: 'thesis entry conditions hold',
    });
    // notional 17*100.10 = 1701.70 <= 2000 order cap, <= 5000 position cap,
    // <= 10000 daily deploy cap; nothing halted, no duplicates.
    expect(riskCheck(outcome.order!, riskCtx(false))).toEqual({ allowed: true, reasons: [] });
  });

  it('too-wide spread produces no order', () => {
    const coin = thesis.entries[1]!;
    // spread = (250.00-247.00)/248.50 * 10000 = 120.72 bps > 50 -> skip
    // (last 248.50 is inside the band, so the spread gate is what rejects it).
    const outcome = replayEntryGate(coin, quotes.wideSpread, cfg);
    expect(outcome.order).toBeNull();
    expect(outcome.skip).toBe('spread exceeds max_spread_bps');
  });

  it('quote outside the limit band produces no order', () => {
    const coin = thesis.entries[1]!;
    // spread = (246.10-245.90)/246.00 * 10000 = 8.13 bps (passes);
    // last 246.00 < band.low 247.50 -> skip.
    const outcome = replayEntryGate(coin, quotes.outsideBand, cfg);
    expect(outcome.order).toBeNull();
    expect(outcome.skip).toBe('last price outside limit band');
  });

  it('an entry while halted is rejected by riskCheck with "trading halted"', () => {
    const nvda = thesis.entries[0]!;
    const outcome = replayEntryGate(nvda, quotes.pass, cfg);
    expect(outcome.order).not.toBeNull();
    expect(riskCheck(outcome.order!, riskCtx(true))).toEqual({
      allowed: false,
      reasons: ['trading halted'],
    });
  });
});
