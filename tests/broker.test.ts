import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config.js';
import { AlpacaBroker } from '../src/broker/client.js';
import { AlpacaMarketData } from '../src/broker/marketdata.js';
import type { ProposedOrder } from '../src/types.js';

interface CannedResponse {
  status: number;
  json: unknown;
}

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

// Repeats the last canned response once the list is exhausted.
function makeFetch(responses: CannedResponse[]) {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (!r) throw new Error('mock fetch called with no canned responses');
    return new Response(JSON.stringify(r.json), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return { fetchFn, calls };
}

const noSleep = async (_ms: number): Promise<void> => {};

const paperEnv: NodeJS.ProcessEnv = {
  ALPACA_PAPER_KEY: 'paper-key',
  ALPACA_PAPER_SECRET: 'paper-secret',
};

const paperCfg = ConfigSchema.parse({ mode: 'paper' });
const dryCfg = ConfigSchema.parse({ mode: 'dry-run' });

const proposed: ProposedOrder = {
  ticker: 'AAPL',
  side: 'buy',
  qty: 10,
  limitPrice: 123.45,
  intent: 'entry',
  reason: 'test',
};

const alpacaOrderJson = {
  id: 'ord-1',
  symbol: 'AAPL',
  side: 'buy',
  qty: '10',
  limit_price: '123.45',
  status: 'accepted',
  submitted_at: '2026-07-07T21:00:00Z',
};

function bar(c: number, v: number, t = '2026-07-01T04:00:00Z') {
  return { o: c, h: c, l: c, c, v, t };
}

describe('AlpacaBroker.placeLimitOrder', () => {
  it('sends the exact limit order body with string qty and limit_price', async () => {
    const { fetchFn, calls } = makeFetch([{ status: 200, json: alpacaOrderJson }]);
    const broker = new AlpacaBroker(paperCfg, paperEnv, fetchFn, noSleep);
    const placed = await broker.placeLimitOrder(proposed);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://paper-api.alpaca.markets/v2/orders');
    expect(calls[0]!.init?.method).toBe('POST');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers['APCA-API-KEY-ID']).toBe('paper-key');
    expect(headers['APCA-API-SECRET-KEY']).toBe('paper-secret');
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.client_order_id).toMatch(/^entry-/);
    expect(body).toEqual({
      symbol: 'AAPL',
      qty: '10',
      side: 'buy',
      type: 'limit',
      time_in_force: 'day',
      limit_price: '123.45',
      extended_hours: true,
      client_order_id: body.client_order_id,
    });
    expect(placed).toEqual({
      id: 'ord-1',
      ticker: 'AAPL',
      side: 'buy',
      qty: 10,
      limitPrice: 123.45,
      status: 'accepted',
      submittedAt: '2026-07-07T21:00:00Z',
      clientOrderId: undefined,
      filledQty: 0,
    });
  });

  it('serializes sub-penny limit prices to whole cents', async () => {
    const { fetchFn, calls } = makeFetch([{ status: 200, json: alpacaOrderJson }]);
    const broker = new AlpacaBroker(paperCfg, paperEnv, fetchFn, noSleep);
    await broker.placeLimitOrder({ ...proposed, limitPrice: 123.4567 });
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.limit_price).toBe('123.46');
  });

  it('keeps one client_order_id across retries so a committed order cannot double-place', async () => {
    const { fetchFn, calls } = makeFetch([
      { status: 500, json: {} },
      { status: 500, json: {} },
      { status: 200, json: alpacaOrderJson },
    ]);
    const broker = new AlpacaBroker(paperCfg, paperEnv, fetchFn, noSleep);
    await broker.placeLimitOrder(proposed);
    const ids = calls.map((c) => JSON.parse(String(c.init?.body)).client_order_id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
  });

  it('recovers the committed order when the retry is rejected as a duplicate client_order_id', async () => {
    const committed = { ...alpacaOrderJson, id: 'ord-original', client_order_id: 'entry-x' };
    let post = 0;
    const calls: RecordedCall[] = [];
    const fetchFn = (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      const url = String(input);
      if (init?.method === 'POST') {
        post++;
        // first POST commits server-side but the client sees a 500; the
        // retried POST is rejected as a duplicate
        if (post === 1) return new Response('{}', { status: 500 });
        return new Response(JSON.stringify({ message: 'client_order_id must be unique' }), {
          status: 422,
        });
      }
      expect(url).toContain('/v2/orders:by_client_order_id?client_order_id=');
      return new Response(JSON.stringify(committed), { status: 200 });
    }) as typeof globalThis.fetch;
    const broker = new AlpacaBroker(paperCfg, paperEnv, fetchFn, noSleep);
    const placed = await broker.placeLimitOrder(proposed);
    expect(placed.id).toBe('ord-original');
  });

  it('dry-run makes zero fetch calls and returns a synthetic dry_run order', async () => {
    const { fetchFn, calls } = makeFetch([]);
    const broker = new AlpacaBroker(dryCfg, paperEnv, fetchFn, noSleep);
    const placed = await broker.placeLimitOrder(proposed);

    expect(calls).toHaveLength(0);
    expect(placed.status).toBe('dry_run');
    expect(placed.id.startsWith('dry-')).toBe(true);
    expect(placed.ticker).toBe('AAPL');
    expect(placed.qty).toBe(10);
    expect(placed.limitPrice).toBe(123.45);
  });
});

describe('AlpacaBroker constructor mode/credential rules', () => {
  it('refuses live mode without acknowledgment', () => {
    const liveCfg = ConfigSchema.parse({ mode: 'live', live_trading_acknowledged: false });
    const { fetchFn } = makeFetch([]);
    const env: NodeJS.ProcessEnv = { ALPACA_LIVE_KEY: 'lk', ALPACA_LIVE_SECRET: 'ls' };
    expect(() => new AlpacaBroker(liveCfg, env, fetchFn, noSleep)).toThrow(
      /refusing to start in live mode/,
    );
  });

  it('refuses live mode with acknowledgment but missing live keys', () => {
    const liveCfg = ConfigSchema.parse({ mode: 'live', live_trading_acknowledged: true });
    const { fetchFn } = makeFetch([]);
    expect(() => new AlpacaBroker(liveCfg, {}, fetchFn, noSleep)).toThrow(
      /refusing to start in live mode/,
    );
  });

  it('live mode with ack and keys uses the live base URL and live credentials', async () => {
    const liveCfg = ConfigSchema.parse({ mode: 'live', live_trading_acknowledged: true });
    const { fetchFn, calls } = makeFetch([{ status: 200, json: [] }]);
    const env: NodeJS.ProcessEnv = { ALPACA_LIVE_KEY: 'lk', ALPACA_LIVE_SECRET: 'ls' };
    const broker = new AlpacaBroker(liveCfg, env, fetchFn, noSleep);
    await broker.getOpenOrders();
    expect(calls[0]!.url).toBe('https://api.alpaca.markets/v2/orders?status=open');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers['APCA-API-KEY-ID']).toBe('lk');
  });

  it('paper mode never reads ALPACA_LIVE_* env slots', async () => {
    const accessed: string[] = [];
    const target: Record<string, string> = {
      ALPACA_PAPER_KEY: 'paper-key',
      ALPACA_PAPER_SECRET: 'paper-secret',
      ALPACA_LIVE_KEY: 'lk',
      ALPACA_LIVE_SECRET: 'ls',
    };
    const env = new Proxy(target, {
      get(t, prop) {
        if (typeof prop === 'string') accessed.push(prop);
        return t[prop as string];
      },
    }) as NodeJS.ProcessEnv;
    const { fetchFn } = makeFetch([{ status: 200, json: [] }]);
    const broker = new AlpacaBroker(paperCfg, env, fetchFn, noSleep);
    await broker.getOpenOrders();
    expect(accessed.filter((k) => k.startsWith('ALPACA_LIVE'))).toEqual([]);
  });

  it('paper mode with only live keys throws instead of falling back', () => {
    const { fetchFn } = makeFetch([]);
    const env: NodeJS.ProcessEnv = { ALPACA_LIVE_KEY: 'lk', ALPACA_LIVE_SECRET: 'ls' };
    expect(() => new AlpacaBroker(paperCfg, env, fetchFn, noSleep)).toThrow(
      /ALPACA_PAPER_KEY/,
    );
  });
});

describe('retry behavior', () => {
  it('two 500s then success succeeds, sleeping 1s then 3s', async () => {
    const { fetchFn, calls } = makeFetch([
      { status: 500, json: { message: 'boom' } },
      { status: 500, json: { message: 'boom' } },
      { status: 200, json: [] },
    ]);
    const sleeps: number[] = [];
    const broker = new AlpacaBroker(paperCfg, paperEnv, fetchFn, async (ms) => {
      sleeps.push(ms);
    });
    await expect(broker.getOpenOrders()).resolves.toEqual([]);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 3000]);
  });

  it('three 500s throws after exhausting retries', async () => {
    const { fetchFn, calls } = makeFetch([{ status: 500, json: { message: 'boom' } }]);
    const broker = new AlpacaBroker(paperCfg, paperEnv, fetchFn, noSleep);
    await expect(broker.getOpenOrders()).rejects.toThrow(/HTTP 500/);
    expect(calls).toHaveLength(3);
  });

  it('403 throws immediately with the Alpaca message and no retry', async () => {
    const { fetchFn, calls } = makeFetch([{ status: 403, json: { message: 'forbidden' } }]);
    const broker = new AlpacaBroker(paperCfg, paperEnv, fetchFn, async () => {
      throw new Error('must not sleep on non-retryable error');
    });
    await expect(broker.getOpenOrders()).rejects.toThrow(/forbidden/);
    expect(calls).toHaveLength(1);
  });
});

describe('AlpacaBroker reads', () => {
  it('getAccount merges /v2/account and /v2/positions', async () => {
    const { fetchFn } = makeFetch([
      { status: 200, json: { equity: '100000', cash: '40000', last_equity: '99000' } },
      {
        status: 200,
        json: [
          {
            symbol: 'NVDA',
            qty: '5',
            avg_entry_price: '100',
            market_value: '550',
            unrealized_pl: '50',
            side: 'long',
          },
        ],
      },
    ]);
    // Promise.all order matches the canned response order (account first).
    const broker = new AlpacaBroker(paperCfg, paperEnv, fetchFn, noSleep);
    const account = await broker.getAccount();
    expect(account.equity).toBe(100000);
    expect(account.cash).toBe(40000);
    expect(account.positions).toEqual([
      {
        ticker: 'NVDA',
        qty: 5,
        avgEntryPrice: 100,
        marketValue: 550,
        unrealizedPl: 50,
        side: 'long',
      },
    ]);
  });

  it('getDailyPl is equity minus last_equity', async () => {
    const { fetchFn } = makeFetch([
      { status: 200, json: { equity: '100000', cash: '40000', last_equity: '99250.50' } },
    ]);
    const broker = new AlpacaBroker(paperCfg, paperEnv, fetchFn, noSleep);
    await expect(broker.getDailyPl()).resolves.toBeCloseTo(749.5, 6);
  });

  it('getTodayOrders queries status=all with an after bound', async () => {
    const { fetchFn, calls } = makeFetch([{ status: 200, json: [] }]);
    const broker = new AlpacaBroker(paperCfg, paperEnv, fetchFn, noSleep);
    await broker.getTodayOrders();
    expect(calls[0]!.url).toContain('/v2/orders?');
    expect(calls[0]!.url).toContain('status=all');
    expect(calls[0]!.url).toContain('after=');
  });
});

describe('AlpacaMarketData', () => {
  it('requires paper credentials', () => {
    const { fetchFn } = makeFetch([]);
    expect(() => new AlpacaMarketData({}, fetchFn, noSleep)).toThrow(/ALPACA_PAPER_KEY/);
  });

  it('marketInfoFor computes lastPrice and avg dollar volume from bars', async () => {
    const { fetchFn, calls } = makeFetch([
      {
        status: 200,
        json: {
          bars: {
            AAPL: [bar(10, 100, '2026-07-01T04:00:00Z'), bar(20, 200, '2026-07-02T04:00:00Z')],
          },
          next_page_token: null,
        },
      },
    ]);
    const md = new AlpacaMarketData(paperEnv, fetchFn, noSleep);
    const info = await md.marketInfoFor(['AAPL']);
    // (10*100 + 20*200) / 2 = 2500
    expect(info.get('AAPL')).toEqual({ lastPrice: 20, avgDollarVolume20d: 2500 });
    expect(calls[0]!.url).toContain('https://data.alpaca.markets/v2/stocks/bars?');
    expect(calls[0]!.url).toContain('timeframe=1Day');
    expect(calls[0]!.url).toContain('feed=iex');
  });

  it('marketInfoFor averages only the 20 most recent bars', async () => {
    const series = [
      bar(1, 1),
      bar(1, 1),
      ...Array.from({ length: 20 }, () => bar(10, 10)),
    ];
    const { fetchFn } = makeFetch([
      { status: 200, json: { bars: { MSFT: series }, next_page_token: null } },
    ]);
    const md = new AlpacaMarketData(paperEnv, fetchFn, noSleep);
    const info = await md.marketInfoFor(['MSFT']);
    expect(info.get('MSFT')).toEqual({ lastPrice: 10, avgDollarVolume20d: 100 });
  });

  it('marketInfoFor omits symbols with no bars', async () => {
    const { fetchFn } = makeFetch([
      { status: 200, json: { bars: {}, next_page_token: null } },
    ]);
    const md = new AlpacaMarketData(paperEnv, fetchFn, noSleep);
    const info = await md.marketInfoFor(['ZZZZ']);
    expect(info.has('ZZZZ')).toBe(false);
  });

  it('getDailyBars follows next_page_token and merges per-symbol bars', async () => {
    const { fetchFn, calls } = makeFetch([
      {
        status: 200,
        json: { bars: { AAPL: [bar(10, 100)] }, next_page_token: 'tok-1' },
      },
      {
        status: 200,
        json: { bars: { AAPL: [bar(20, 200)] }, next_page_token: null },
      },
    ]);
    const md = new AlpacaMarketData(paperEnv, fetchFn, noSleep);
    const bars = await md.getDailyBars(['AAPL']);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toContain('page_token=tok-1');
    expect(bars.get('AAPL')).toHaveLength(2);
    expect(bars.get('AAPL')![1]!.c).toBe(20);
  });

  it('getLatestQuotes combines latest quotes and trades into QuoteSnapshots', async () => {
    const { fetchFn } = makeFetch([
      {
        status: 200,
        json: {
          quotes: {
            AAPL: { bp: 99.5, bs: 3, ap: 100.5, as: 2, t: '2026-07-07T21:00:00Z' },
          },
        },
      },
      { status: 200, json: { trades: { AAPL: { p: 100.1, s: 10, t: '2026-07-07T21:00:01Z' } } } },
    ]);
    // Promise.all order matches the canned response order (quotes first).
    const md = new AlpacaMarketData(paperEnv, fetchFn, noSleep);
    const quotes = await md.getLatestQuotes(['AAPL']);
    expect(quotes).toEqual([
      {
        ticker: 'AAPL',
        bid: 99.5,
        ask: 100.5,
        bidSize: 3,
        askSize: 2,
        last: 100.1,
        asOf: '2026-07-07T21:00:00Z',
      },
    ]);
  });
});
