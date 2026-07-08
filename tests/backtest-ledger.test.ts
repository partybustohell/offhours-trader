import { describe, expect, it } from 'vitest';
import { seedDeployedTodayUsd } from '../src/executor-loop.js';
import { etOffsetForDate } from '../src/backtest/data.js';
import { borrowAccrual, sellFeesUsd } from '../src/backtest/fills.js';
import { SimLedger, type HaltPolicy } from '../src/backtest/ledger.js';
import type { StoredMinuteBar, StoredQuote } from '../src/backtest/types.js';
import type { NewsItem } from '../src/broker/marketdata.js';
import type { ProposedOrder } from '../src/types.js';

// SimLedger unit tests (plan T5): fill application without lookahead,
// per-tick kill-switch dailyPl vs the 16:00 ET baseline, the ET-midnight
// deployment reset through the REAL seedDeployedTodayUsd, short round-trip
// with borrow accrual, force-flatten exactness, halt policies, and the
// aborting invariants. Everything in memory; no network, no disk writes.

const D = '2026-03-10'; // Tuesday, EDT
const D1 = '2026-03-11';
const MAY = '2026-05-12'; // SEC-fee regime

const iso = (ymd: string, hms: string): string =>
  new Date(`${ymd}T${hms}${etOffsetForDate(ymd)}`).toISOString();

const bar = (ymd: string, hms: string, over: Partial<StoredMinuteBar> = {}): StoredMinuteBar => ({
  t: iso(ymd, hms),
  o: 100,
  h: 100,
  l: 100,
  c: 100,
  v: 1_000_000,
  ...over,
});

const quote = (t: string, over: Partial<StoredQuote> = {}): StoredQuote => ({
  t,
  bp: 99.9,
  bs: 5,
  ap: 100.1,
  as: 5,
  ...over,
});

const newsItem = (symbol: string, createdAt: string): NewsItem => ({
  headline: `h-${symbol}-${createdAt}`,
  summary: '',
  symbols: [symbol],
  created_at: createdAt,
  source: 'test',
});

function makeLedger(haltPolicy: HaltPolicy = 'stay-halted'): SimLedger {
  return new SimLedger({
    equityStart: 50_000,
    easyToBorrow: new Set(['NVDA', 'COIN']),
    haltPolicy,
  });
}

function order(over: Partial<ProposedOrder> = {}): ProposedOrder {
  return {
    ticker: 'NVDA',
    side: 'buy',
    qty: 10,
    limitPrice: 100,
    intent: 'entry',
    reason: 'test',
    ...over,
  };
}

async function placeApproved(ledger: SimLedger, o: ProposedOrder) {
  ledger.recordRiskApproval(o);
  return ledger.placeLimitOrder(o);
}

const barsFor = (ticker: string, list: StoredMinuteBar[]) =>
  new Map<string, StoredMinuteBar[]>([[ticker, list]]);

describe('buy fill: no lookahead, then exact accounting', () => {
  it('fills only once the crossing bar is complete at sim now', async () => {
    const ledger = makeLedger();
    ledger.setNow(iso(D, '17:05:00'));
    await placeApproved(ledger, order());
    expect(await ledger.getOpenOrders()).toHaveLength(1);

    const dayBars = barsFor('NVDA', [bar(D, '17:10:00', { l: 99.9, v: 500 })]);
    // the crossing bar has not happened yet at 17:05
    expect(ledger.advance(dayBars)).toEqual([]);

    ledger.setNow(iso(D, '17:15:00'));
    const events = ledger.advance(dayBars);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ticker: 'NVDA',
      side: 'buy',
      intent: 'entry',
      qty: 10,
      price: 100, // fill price is the limit, not the bar low
      atIso: iso(D, '17:10:00'),
      feesUsd: 0, // buys carry no fees
      realizedUsd: 0,
    });
    expect(events[0]!.clientOrderId).toMatch(/^entry-/);

    expect(ledger.cashUsd()).toBeCloseTo(49_000, 10);
    const account = await ledger.getAccount();
    expect(account.equity).toBeCloseTo(50_000, 10); // marked at the fill price
    expect(account.positions).toEqual([
      {
        ticker: 'NVDA',
        qty: 10,
        avgEntryPrice: 100,
        marketValue: 1000,
        unrealizedPl: 0,
        side: 'long',
      },
    ]);
    expect(await ledger.getOpenOrders()).toEqual([]);

    // advancing again over the same bars never double-fills
    ledger.setNow(iso(D, '17:30:00'));
    expect(ledger.advance(dayBars)).toEqual([]);
  });
});

describe('kill-switch dailyPl: per-tick marks vs the 16:00 ET baseline', () => {
  it('marks per tick, carries marks forward, re-baselines at 16:00 ET', async () => {
    const ledger = makeLedger();
    ledger.setNow(iso(D, '17:05:00'));
    await placeApproved(ledger, order());
    ledger.setNow(iso(D, '17:15:00'));
    ledger.advance(barsFor('NVDA', [bar(D, '17:10:00', { l: 99.9, v: 500 })]));

    // tick supplies last=85: equity 49_000 + 850, baseline is still 50_000
    ledger.setMarketData(
      iso(D, '17:30:00'),
      new Map([['NVDA', quote(iso(D, '17:29:00'), { bp: 84.9, ap: 85.1 })]]),
      new Map([['NVDA', 85]]),
    );
    expect(await ledger.getDailyPl()).toBeCloseTo(-150, 10);

    // D+1 premarket, no fresh data: the mark carries, baseline unchanged
    ledger.setNow(iso(D1, '04:00:00'));
    expect(await ledger.getDailyPl()).toBeCloseTo(-150, 10);

    // crossing D+1 16:00 re-baselines to the marked equity (49_850)
    ledger.setNow(iso(D1, '16:15:00'));
    expect(await ledger.getDailyPl()).toBeCloseTo(0, 10);

    // a fresh mark of 80 measures against the new baseline, not equityStart
    ledger.setMarketData(
      iso(D1, '16:30:00'),
      new Map([['NVDA', quote(iso(D1, '16:29:00'), { bp: 79.9, ap: 80.1 })]]),
      new Map([['NVDA', 80]]),
    );
    expect(await ledger.getDailyPl()).toBeCloseTo(-50, 10);
  });
});

describe('ET-midnight deployment reset (real seedDeployedTodayUsd)', () => {
  it('an entry at D 19:00 counts on D, expires at 20:00, and vanishes from D+1 today-orders', async () => {
    const ledger = makeLedger();
    ledger.setNow(iso(D, '19:00:00'));
    await placeApproved(ledger, order({ qty: 7 }));

    expect(seedDeployedTodayUsd(await ledger.getTodayOrders())).toBe(700);

    // 20:00 ET: the order dies unfilled but still consumes the day's budget
    // (production counts every non-canceled entry order at full qty)
    ledger.setNow(iso(D, '20:30:00'));
    expect(await ledger.getOpenOrders()).toEqual([]);
    const today = await ledger.getTodayOrders();
    expect(today[0]!.status).toBe('expired');
    expect(seedDeployedTodayUsd(today)).toBe(700);

    // D+1 premarket: ET midnight reset the today-order window
    ledger.setNow(iso(D1, '07:00:00'));
    expect(await ledger.getTodayOrders()).toEqual([]);
    expect(seedDeployedTodayUsd(await ledger.getTodayOrders())).toBe(0);
  });
});

describe('short round-trip with daily borrow accrual', () => {
  it('sell entry pays fees, midnight accrues borrow, cover realizes exactly', async () => {
    const ledger = makeLedger();
    ledger.setNow(iso(D, '17:05:00'));
    await placeApproved(ledger, order({ ticker: 'COIN', side: 'sell', qty: 100, limitPrice: 50 }));

    ledger.setNow(iso(D, '17:30:00'));
    const events = ledger.advance(
      barsFor('COIN', [bar(D, '17:20:00', { h: 50.5, l: 49.5, v: 5000 })]),
    );
    const entryFees = sellFeesUsd(100, 50, D); // March: TAF only
    expect(events[0]!.feesUsd).toBeCloseTo(entryFees, 12);
    expect(ledger.cashUsd()).toBeCloseTo(55_000 - entryFees, 10);
    const account = await ledger.getAccount();
    expect(account.positions[0]).toMatchObject({
      ticker: 'COIN',
      qty: -100,
      avgEntryPrice: 50,
      marketValue: -5000,
      side: 'short',
    });

    // crossing ET midnight accrues one day of borrow on the marked short value
    ledger.setNow(iso(D1, '04:00:00'));
    const borrow = borrowAccrual(5000, 1);
    expect(ledger.totals().borrowUsd).toBeCloseTo(borrow, 12);

    // force-flatten covers at 48: gross +200, cover is a buy so no fees
    const result = ledger.forceFlattenAt(iso(D1, '20:00:00'), { COIN: 48 });
    expect(result.label).toBe('force-flatten');
    expect(result.closes).toEqual([
      { ticker: 'COIN', side: 'buy', qty: 100, price: 48, grossRealizedUsd: 200, feesUsd: 0 },
    ]);
    expect(result.netRealizedUsd).toBeCloseTo(200, 10);

    expect((await ledger.getAccount()).positions).toEqual([]);
    expect(ledger.cashUsd()).toBeCloseTo(50_200 - entryFees - borrow, 10);
    expect(ledger.equityUsd()).toBeCloseTo(ledger.cashUsd(), 12);
    // baseline re-marked at D+1 16:00 while short at 50 -> flatten shows +200
    expect(await ledger.getDailyPl()).toBeCloseTo(200, 10);
    expect(ledger.totals()).toMatchObject({ realizedGrossUsd: 200 });
  });
});

describe('force-flatten accounting exactness', () => {
  it('closes a long at the given mark with trade-date fees and cancels working orders', async () => {
    const ledger = makeLedger();
    ledger.setNow(iso(MAY, '17:05:00'));
    await placeApproved(ledger, order()); // buy 10 NVDA @ 100
    ledger.setNow(iso(MAY, '17:30:00'));
    ledger.advance(barsFor('NVDA', [bar(MAY, '17:10:00', { l: 99.5, v: 500 })]));
    // a second, never-filled working order must die at the flatten
    await placeApproved(ledger, order({ ticker: 'COIN', side: 'sell', qty: 5, limitPrice: 60 }));

    const result = ledger.forceFlattenAt(iso(MAY, '19:00:00'), new Map([['NVDA', 110]]));
    const fees = sellFeesUsd(10, 110, MAY); // May: TAF + SEC
    expect(result.closes).toHaveLength(1);
    expect(result.closes[0]).toMatchObject({ ticker: 'NVDA', side: 'sell', qty: 10, price: 110 });
    expect(result.closes[0]!.feesUsd).toBeCloseTo(fees, 12);
    expect(result.netRealizedUsd).toBeCloseTo(100 - fees, 10);

    expect(ledger.cashUsd()).toBeCloseTo(50_100 - fees, 10);
    expect(ledger.equityUsd()).toBeCloseTo(ledger.cashUsd(), 12); // nothing left marked
    expect((await ledger.getAccount()).positions).toEqual([]);
    expect(await ledger.getOpenOrders()).toEqual([]);
    const coin = (await ledger.getTodayOrders()).find((o) => o.ticker === 'COIN');
    expect(coin!.status).toBe('canceled');
    // canceled-unfilled orders drop out of the deployment count entirely
    expect(seedDeployedTodayUsd([coin!])).toBe(0);
  });

  it('throws when a held ticker has no usable mark', async () => {
    const ledger = makeLedger();
    ledger.setNow(iso(D, '17:05:00'));
    await placeApproved(ledger, order());
    ledger.setNow(iso(D, '17:30:00'));
    ledger.advance(barsFor('NVDA', [bar(D, '17:10:00', { l: 99.5, v: 500 })]));
    expect(() => ledger.forceFlattenAt(iso(D, '19:00:00'), {})).toThrow(/no usable mark/);
  });
});

describe('halt policies', () => {
  it('stay-halted: the halt survives into D+1 and blocks entries but not exits', async () => {
    const ledger = makeLedger('stay-halted');
    ledger.setNow(iso(D, '18:00:00'));
    ledger.writeHalt('daily loss halt');
    expect(ledger.readHalt().halted).toBe(true);

    ledger.setNow(iso(D1, '04:00:00'));
    expect(ledger.readHalt().halted).toBe(true);
    await expect(placeApproved(ledger, order())).rejects.toThrow(/halted/);
    // exits reduce risk and pass through a halt
    await expect(
      placeApproved(ledger, order({ intent: 'exit', side: 'sell' })),
    ).resolves.toMatchObject({ status: 'new' });
  });

  it('auto-resume: halted for the rest of the day, clear at the next day first read', async () => {
    const ledger = makeLedger('auto-resume');
    ledger.setNow(iso(D, '18:00:00'));
    ledger.writeHalt('daily loss halt');

    ledger.setNow(iso(D, '19:00:00'));
    expect(ledger.readHalt().halted).toBe(true); // same ET day
    await expect(placeApproved(ledger, order())).rejects.toThrow(/halted/);

    ledger.setNow(iso(D1, '04:00:00')); // gap-halt no longer blocks D+1 premarket
    expect(ledger.readHalt().halted).toBe(false);
    await expect(placeApproved(ledger, order())).resolves.toMatchObject({ status: 'new' });
  });
});

describe('aborting invariants', () => {
  it('placement without a prior passed riskCheck throws', async () => {
    const ledger = makeLedger();
    ledger.setNow(iso(D, '17:00:00'));
    await expect(ledger.placeLimitOrder(order())).rejects.toThrow(/riskCheck/);
  });

  it('non-integer qty, sub-1 qty, and bad limits throw even when approved', async () => {
    const ledger = makeLedger();
    ledger.setNow(iso(D, '17:00:00'));
    await expect(placeApproved(ledger, order({ qty: 1.5 }))).rejects.toThrow(/qty/);
    await expect(placeApproved(ledger, order({ qty: 0 }))).rejects.toThrow(/qty/);
    await expect(placeApproved(ledger, order({ limitPrice: Number.NaN }))).rejects.toThrow(
      /limit/,
    );
    await expect(placeApproved(ledger, order({ limitPrice: -5 }))).rejects.toThrow(/limit/);
  });

  it('the sim clock never moves backwards', () => {
    const ledger = makeLedger();
    ledger.setNow(iso(D, '17:00:00'));
    expect(() => ledger.setNow(iso(D, '16:00:00'))).toThrow(/backwards/);
  });

  it('cash/position drift beyond one cent aborts', () => {
    const ledger = makeLedger();
    ledger.setNow(iso(D, '17:00:00'));
    ledger.assertConsistent(); // clean ledger reconciles
    (ledger as unknown as { cash: number }).cash += 5;
    expect(() => ledger.assertConsistent()).toThrow(/drift/);
  });

  it('everything time-dependent requires setNow first', async () => {
    const ledger = makeLedger();
    expect(() => ledger.nowOrThrow()).toThrow(/setNow/);
    await expect(ledger.getTodayOrders()).rejects.toThrow(/setNow/);
    await expect(placeApproved(ledger, order())).rejects.toThrow(/setNow/);
  });
});

describe('marketdata facade', () => {
  it('serves only the current tick snapshot, with production dead-book semantics', async () => {
    const ledger = makeLedger();
    ledger.setNow(iso(D, '17:00:00'));
    ledger.setMarketData(
      iso(D, '17:00:00'),
      new Map([
        ['NVDA', quote(iso(D, '16:59:30'), { bp: 99.5, bs: 3, ap: 100.5, as: 2 })],
        ['AMD', quote(iso(D, '16:59:00'), { bp: 50, ap: 50.2 })],
      ]),
      new Map([['NVDA', 100.1]]),
    );
    expect(await ledger.getLatestQuotes(['NVDA', 'GHOST'])).toEqual([
      {
        ticker: 'NVDA',
        bid: 99.5,
        ask: 100.5,
        bidSize: 3,
        askSize: 2,
        last: 100.1,
        asOf: iso(D, '16:59:30'),
      },
    ]);
    // quote but no trade in the window -> last 0 (fails the band check downstream)
    expect((await ledger.getLatestQuotes(['AMD']))[0]!.last).toBe(0);

    // the next tick replaces the snapshot entirely: no stale quotes
    ledger.setMarketData(iso(D, '17:15:00'), new Map(), new Map());
    expect(await ledger.getLatestQuotes(['NVDA'])).toEqual([]);
  });

  it('getNews filters by symbol case-insensitively, newest first, capped', async () => {
    const ledger = makeLedger();
    ledger.setNews([
      newsItem('NVDA', '2026-03-10T18:00:00Z'),
      newsItem('AMD', '2026-03-10T19:00:00Z'),
      newsItem('NVDA', '2026-03-10T20:00:00Z'),
    ]);
    const news = await ledger.getNews(50, ['nvda']);
    expect(news.map((n) => n.created_at)).toEqual([
      '2026-03-10T20:00:00Z',
      '2026-03-10T18:00:00Z',
    ]);
    expect(await ledger.getNews(1, ['NVDA'])).toHaveLength(1);
  });
});

describe('checkShortable (driver-side borrow gate)', () => {
  it('reflects the easy_to_borrow set, case-insensitive', () => {
    const ledger = makeLedger();
    expect(ledger.checkShortable('NVDA')).toBe(true);
    expect(ledger.checkShortable('nvda')).toBe(true);
    expect(ledger.checkShortable('XYZ')).toBe(false);
  });
});
