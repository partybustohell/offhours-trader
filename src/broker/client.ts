import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import { assertModeRunnable } from '../config.js';
import type {
  AccountSnapshot,
  BrokerOrder,
  Mode,
  Position,
  ProposedOrder,
} from '../types.js';

export type FetchFn = typeof globalThis.fetch;
export type SleepFn = (ms: number) => Promise<void>;

export const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RequestOptions {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

const RETRY_DELAYS_MS = [1000, 3000];

/**
 * Shared fetch wrapper: 2 retries (1s/3s backoff) on network error, 5xx, or
 * 429; any other non-2xx throws immediately with Alpaca's error message.
 */
export async function requestWithRetry(
  url: string,
  init: RequestOptions,
  fetchFn: FetchFn,
  sleep: SleepFn = defaultSleep,
): Promise<unknown> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]!);
    let res: Response;
    try {
      res = await fetchFn(url, init);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      continue;
    }
    if (res.ok) return res.json();
    const bodyText = await res.text().catch(() => '');
    if (res.status === 429 || res.status >= 500) {
      lastError = new Error(`HTTP ${res.status} from ${url}: ${bodyText}`);
      continue;
    }
    let message = bodyText;
    try {
      const parsed = JSON.parse(bodyText) as { message?: unknown };
      if (typeof parsed.message === 'string') message = parsed.message;
    } catch {
      // keep raw body
    }
    throw new Error(`HTTP ${res.status} from ${url}: ${message}`);
  }
  throw lastError ?? new Error(`request failed: ${url}`);
}

/**
 * Credentials come strictly from the mode-matching slot. Paper and live keys
 * are never interchangeable; an empty slot is an error, not a fallback.
 */
export function credentialsFor(
  mode: Mode,
  env: NodeJS.ProcessEnv,
): { key: string; secret: string } {
  if (mode === 'live') {
    const key = env.ALPACA_LIVE_KEY;
    const secret = env.ALPACA_LIVE_SECRET;
    if (!key || !secret) {
      throw new Error('live mode requires ALPACA_LIVE_KEY and ALPACA_LIVE_SECRET in .env');
    }
    return { key, secret };
  }
  const key = env.ALPACA_PAPER_KEY;
  const secret = env.ALPACA_PAPER_SECRET;
  if (!key || !secret) {
    throw new Error(`${mode} mode requires ALPACA_PAPER_KEY and ALPACA_PAPER_SECRET in .env`);
  }
  return { key, secret };
}

/** UTC instant of 00:00 today in America/New_York, as ISO. */
export function startOfTodayEtIso(d: Date = new Date()): string {
  const ymd = etYmd(d);
  // Offset at "now" can be wrong for midnight on a DST-transition day, so
  // resolve the offset once more at the candidate midnight instant.
  let offset = etOffsetAt(d);
  const candidate = new Date(`${ymd}T00:00:00${offset}`);
  offset = etOffsetAt(candidate);
  return new Date(`${ymd}T00:00:00${offset}`).toISOString();
}

function etYmd(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function etOffsetAt(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'longOffset',
  }).formatToParts(d);
  const tz = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-05:00';
  const offset = tz.replace('GMT', '');
  return offset === '' ? '+00:00' : offset;
}

interface AlpacaAccount {
  equity?: string;
  cash?: string;
  last_equity?: string;
}
interface AlpacaPosition {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  market_value: string;
  unrealized_pl: string;
  side: string;
}
interface AlpacaOrder {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  qty: string;
  type?: string | null;
  limit_price?: string | null;
  stop_price?: string | null;
  time_in_force?: string | null;
  status: string;
  submitted_at: string;
  client_order_id?: string | null;
  filled_qty?: string | null;
}

function mapPosition(p: AlpacaPosition): Position {
  return {
    ticker: p.symbol,
    qty: Number(p.qty),
    avgEntryPrice: Number(p.avg_entry_price),
    marketValue: Number(p.market_value),
    unrealizedPl: Number(p.unrealized_pl),
    side: p.side === 'short' ? 'short' : 'long',
  };
}

function mapOrder(o: AlpacaOrder): BrokerOrder {
  return {
    id: o.id,
    ticker: o.symbol,
    side: o.side,
    qty: Number(o.qty),
    type: o.type ?? undefined,
    limitPrice: o.limit_price == null ? 0 : Number(o.limit_price),
    stopPrice: o.stop_price == null ? undefined : Number(o.stop_price),
    timeInForce: o.time_in_force ?? undefined,
    status: o.status,
    submittedAt: o.submitted_at,
    clientOrderId: o.client_order_id ?? undefined,
    filledQty: o.filled_qty == null ? 0 : Number(o.filled_qty),
  };
}

export interface BrokerClient {
  getAccount(): Promise<AccountSnapshot>;
  getDailyPl(): Promise<number>;
  getOpenOrders(): Promise<BrokerOrder[]>;
  getTodayOrders(): Promise<BrokerOrder[]>;
  placeLimitOrder(o: ProposedOrder): Promise<BrokerOrder>;
  /** Cancel all open orders for a ticker (e.g. a resting RTH stop-loss leg
   *  before a manual exit). No-op when there are none. */
  cancelOrdersFor(ticker: string): Promise<void>;
}

export class AlpacaBroker implements BrokerClient {
  private readonly mode: Mode;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchFn: FetchFn;
  private readonly sleep: SleepFn;

  constructor(
    cfg: Config,
    env: NodeJS.ProcessEnv = process.env,
    fetchFn: FetchFn = globalThis.fetch,
    sleep: SleepFn = defaultSleep,
  ) {
    assertModeRunnable(cfg, env);
    this.mode = cfg.mode;
    // dry-run reads real paper account state; only order placement is synthetic
    this.baseUrl =
      cfg.mode === 'live' ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets';
    const { key, secret } = credentialsFor(cfg.mode, env);
    this.headers = { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret };
    this.fetchFn = fetchFn;
    this.sleep = sleep;
  }

  private request(path: string, init: RequestOptions = {}): Promise<unknown> {
    return requestWithRetry(
      `${this.baseUrl}${path}`,
      { ...init, headers: { ...this.headers, ...(init.headers ?? {}) } },
      this.fetchFn,
      this.sleep,
    );
  }

  async getAccount(): Promise<AccountSnapshot> {
    const [accountRaw, positionsRaw] = await Promise.all([
      this.request('/v2/account'),
      this.request('/v2/positions'),
    ]);
    const account = accountRaw as AlpacaAccount;
    const positions = (positionsRaw as AlpacaPosition[]).map(mapPosition);
    return {
      equity: Number(account.equity ?? 0),
      cash: Number(account.cash ?? 0),
      positions,
    };
  }

  async getDailyPl(): Promise<number> {
    const account = (await this.request('/v2/account')) as AlpacaAccount;
    return Number(account.equity ?? 0) - Number(account.last_equity ?? 0);
  }

  async getOpenOrders(): Promise<BrokerOrder[]> {
    const raw = (await this.request('/v2/orders?status=open')) as AlpacaOrder[];
    return raw.map(mapOrder);
  }

  async getTodayOrders(): Promise<BrokerOrder[]> {
    const params = new URLSearchParams({ status: 'all', after: startOfTodayEtIso() });
    const raw = (await this.request(`/v2/orders?${params.toString()}`)) as AlpacaOrder[];
    return raw.map(mapOrder);
  }

  async placeLimitOrder(o: ProposedOrder): Promise<BrokerOrder> {
    // Generated once per call, OUTSIDE the retry loop: if a POST commits at
    // Alpaca but the response is lost, the retry is rejected as a duplicate
    // client_order_id instead of placing a second order.
    const clientOrderId = `${o.intent}-${randomUUID()}`;
    if (this.mode === 'dry-run') {
      const ts = new Date().toISOString();
      return {
        id: `dry-${ts}`,
        ticker: o.ticker,
        side: o.side,
        qty: o.qty,
        limitPrice: o.limitPrice,
        status: 'dry_run',
        submittedAt: ts,
        clientOrderId,
        filledQty: 0,
      };
    }
    const body: Record<string, unknown> = {
      symbol: o.ticker,
      qty: String(o.qty),
      side: o.side,
      type: 'limit',
      time_in_force: 'day',
      // Alpaca rejects sub-penny limit prices on stocks >= $1 with a 422.
      limit_price: o.limitPrice.toFixed(2),
      extended_hours: o.extendedHours,
      client_order_id: clientOrderId,
    };
    // Regular-session entries carry a native stop-loss via a one-triggers-other
    // order: the entry fills, then Alpaca activates the stop. Extended-hours
    // orders cannot use this (stops do not execute there), so stopLoss is only
    // ever set on RTH entries.
    if (o.stopLoss !== undefined && !o.extendedHours) {
      body.order_class = 'oto';
      body.stop_loss = { stop_price: o.stopLoss.toFixed(2) };
    }
    try {
      const raw = await this.request('/v2/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return mapOrder(raw as AlpacaOrder);
    } catch (err) {
      // A duplicate client_order_id means an earlier attempt actually
      // committed; recover the real order so the audit log reflects it.
      const message = err instanceof Error ? err.message : String(err);
      if (/client.?order.?id/i.test(message)) {
        const raw = await this.request(
          `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`,
        );
        return mapOrder(raw as AlpacaOrder);
      }
      throw err;
    }
  }

  async cancelOrdersFor(ticker: string): Promise<void> {
    if (this.mode === 'dry-run') return;
    const open = await this.getOpenOrders();
    const mine = open.filter((o) => o.ticker.toUpperCase() === ticker.toUpperCase());
    for (const o of mine) {
      await this.request(`/v2/orders/${o.id}`, { method: 'DELETE' }).catch(() => {
        // already filled/canceled between fetch and delete — ignore
      });
    }
  }
}
