// Disk-backed historical data store for the backtest. Everything downloads
// once into backtest-data/ (anchored to the repo root, immune to chdir) and
// is served from disk afterward. Fetchers are idempotent: existing non-empty
// files are never refetched. Feeds per the plan: SIP for minute bars and
// screener reconstruction, IEX daily bars only for marketInfo parity.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestWithRetry, type FetchFn, type SleepFn, defaultSleep } from '../broker/client.js';
import type {
  CalendarDay,
  SplitAction,
  StoredDailyBar,
  StoredMinuteBar,
  StoredNewsItem,
  StoredQuote,
  StoredTrade,
  UniverseAsset,
} from './types.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Overridable for tests/harnesses; defaults to <repo>/backtest-data. */
export const DATA_DIR = process.env.BACKTEST_DATA_DIR
  ? path.resolve(process.env.BACKTEST_DATA_DIR)
  : path.join(REPO_ROOT, 'backtest-data');

const DATA_BASE = 'https://data.alpaca.markets';
const TRADE_BASE = 'https://paper-api.alpaca.markets';

export const WINDOW = { barsStart: '2025-11-15', start: '2026-01-01', end: '2026-07-01', barsEnd: '2026-07-02' };

function headers(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const key = env.ALPACA_PAPER_KEY;
  const secret = env.ALPACA_PAPER_SECRET;
  if (!key || !secret) throw new Error('backtest data layer requires ALPACA_PAPER_KEY/SECRET');
  return { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret };
}

function ensure(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file: string, data: unknown): void {
  ensure(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function fresh(file: string): boolean {
  try {
    return fs.statSync(file).size > 2;
  } catch {
    return false;
  }
}

/** Simple token bucket: at most `perMin` requests per minute. */
export class RateLimiter {
  private stamps: number[] = [];
  constructor(
    private perMin = 180,
    private nowFn: () => number = Date.now,
    private sleep: SleepFn = defaultSleep,
  ) {}
  async take(): Promise<void> {
    for (;;) {
      const now = this.nowFn();
      this.stamps = this.stamps.filter((t) => now - t < 60_000);
      if (this.stamps.length < this.perMin) {
        this.stamps.push(now);
        return;
      }
      await this.sleep(60_000 - (now - this.stamps[0]!) + 25);
    }
  }
}

export interface FetchCtx {
  fetchFn?: FetchFn;
  sleep?: SleepFn;
  limiter?: RateLimiter;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
}

function ctxOf(ctx: FetchCtx) {
  return {
    fetchFn: ctx.fetchFn ?? globalThis.fetch,
    sleep: ctx.sleep ?? defaultSleep,
    limiter: ctx.limiter ?? new RateLimiter(),
    env: ctx.env ?? process.env,
    log: ctx.log ?? (() => {}),
  };
}

async function get(url: string, ctx: ReturnType<typeof ctxOf>): Promise<unknown> {
  await ctx.limiter.take();
  return requestWithRetry(url, { headers: headers(ctx.env) }, ctx.fetchFn, ctx.sleep);
}

/** UTC offset string for an ET date (handles the 2026-03-08 DST switch). */
export function etOffsetForDate(ymd: string): string {
  const probe = new Date(`${ymd}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'longOffset',
  }).formatToParts(probe);
  const tz = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-05:00';
  const off = tz.replace('GMT', '');
  return off === '' ? '+00:00' : off;
}

// ---------- universe ----------

export const universePath = () => path.join(DATA_DIR, 'universe.json');

export async function fetchUniverse(c: FetchCtx = {}): Promise<UniverseAsset[]> {
  const ctx = ctxOf(c);
  if (fresh(universePath())) return readJson<UniverseAsset[]>(universePath())!;
  const raw = (await get(`${TRADE_BASE}/v2/assets?status=active&asset_class=us_equity`, ctx)) as {
    symbol: string;
    name?: string;
    exchange: string;
    tradable: boolean;
    shortable?: boolean;
    easy_to_borrow?: boolean;
  }[];
  const assets: UniverseAsset[] = raw
    .filter((a) => a.tradable && a.exchange !== 'OTC')
    .map((a) => ({
      symbol: a.symbol,
      name: a.name ?? '',
      exchange: a.exchange,
      tradable: a.tradable,
      shortable: a.shortable === true,
      easy_to_borrow: a.easy_to_borrow === true,
    }));
  writeJson(universePath(), assets);
  ctx.log(`universe: ${assets.length} tradable non-OTC assets`);
  return assets;
}

export const loadUniverse = (): UniverseAsset[] | null => readJson<UniverseAsset[]>(universePath());

// ---------- calendar ----------

export const calendarPath = () => path.join(DATA_DIR, 'calendar.json');

export async function fetchCalendar(c: FetchCtx = {}): Promise<CalendarDay[]> {
  const ctx = ctxOf(c);
  if (fresh(calendarPath())) return readJson<CalendarDay[]>(calendarPath())!;
  const raw = (await get(
    `${TRADE_BASE}/v2/calendar?start=${WINDOW.start}&end=${WINDOW.end}`,
    ctx,
  )) as CalendarDay[];
  writeJson(calendarPath(), raw);
  return raw;
}

export const loadCalendar = (): CalendarDay[] | null => readJson<CalendarDay[]>(calendarPath());

// ---------- daily bars (multi-symbol, both feeds) ----------

export const dailyDir = (feed: 'sip' | 'iex') => path.join(DATA_DIR, `daily-${feed}`);
export const dailyPath = (feed: 'sip' | 'iex', symbol: string) =>
  path.join(dailyDir(feed), `${symbol}.json`);

interface AlpacaBarsPage {
  bars?: Record<string, { t: string; o: number; h: number; l: number; c: number; v: number }[]>;
  next_page_token?: string | null;
}

export async function fetchDailyBars(
  symbols: string[],
  feed: 'sip' | 'iex',
  c: FetchCtx = {},
): Promise<void> {
  const ctx = ctxOf(c);
  const missing = symbols.filter((s) => !fresh(dailyPath(feed, s)));
  if (missing.length === 0) return;
  const CHUNK = 100;
  for (let i = 0; i < missing.length; i += CHUNK) {
    const chunk = missing.slice(i, i + CHUNK);
    const acc = new Map<string, StoredDailyBar[]>(chunk.map((s) => [s, []]));
    let token: string | null | undefined;
    do {
      const params = new URLSearchParams({
        symbols: chunk.join(','),
        timeframe: '1Day',
        adjustment: 'raw',
        feed,
        start: WINDOW.barsStart,
        end: WINDOW.barsEnd,
        limit: '10000',
      });
      if (token) params.set('page_token', token);
      const page = (await get(`${DATA_BASE}/v2/stocks/bars?${params}`, ctx)) as AlpacaBarsPage;
      for (const [sym, bars] of Object.entries(page.bars ?? {})) {
        acc.get(sym)?.push(...bars.map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })));
      }
      token = page.next_page_token;
    } while (token);
    for (const [sym, bars] of acc) writeJson(dailyPath(feed, sym), bars);
    ctx.log(`daily-${feed}: ${Math.min(i + CHUNK, missing.length)}/${missing.length} symbols`);
  }
}

export const loadDailyBars = (feed: 'sip' | 'iex', symbol: string): StoredDailyBar[] =>
  readJson<StoredDailyBar[]>(dailyPath(feed, symbol)) ?? [];

// ---------- minute bars (lazy, per symbol-day, SIP, 04:00-20:00 ET) ----------

export const minutePath = (symbol: string, ymd: string) =>
  path.join(DATA_DIR, 'minute', symbol, `${ymd}.json`);

export async function fetchMinuteDay(
  symbol: string,
  ymd: string,
  c: FetchCtx = {},
): Promise<StoredMinuteBar[]> {
  const file = minutePath(symbol, ymd);
  if (fresh(file)) return readJson<StoredMinuteBar[]>(file)!;
  const ctx = ctxOf(c);
  const off = etOffsetForDate(ymd);
  const out: StoredMinuteBar[] = [];
  let token: string | null | undefined;
  do {
    const params = new URLSearchParams({
      symbols: symbol,
      timeframe: '1Min',
      adjustment: 'raw',
      feed: 'sip',
      start: `${ymd}T04:00:00${off}`,
      end: `${ymd}T20:00:00${off}`,
      limit: '10000',
    });
    if (token) params.set('page_token', token);
    const page = (await get(`${DATA_BASE}/v2/stocks/bars?${params}`, ctx)) as AlpacaBarsPage;
    out.push(...(page.bars?.[symbol] ?? []).map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })));
    token = page.next_page_token;
  } while (token);
  writeJson(file, out);
  return out;
}

// ---------- quotes/trades windows (lazy, IEX for production parity) ----------

const stampOf = (iso: string) => iso.replace(/[-:]/g, '').slice(0, 13);
export type QuoteFeed = 'iex' | 'sip';
// iex = production parity (what the live executor would see, incl. its
// extended-hours blindness); sip = consolidated-tape realism mode.
export const quotesPath = (symbol: string, tickIso: string, feed: QuoteFeed = 'iex') =>
  path.join(DATA_DIR, feed === 'iex' ? 'quotes' : 'quotes-sip', symbol, `${stampOf(tickIso)}.json`);
export const tradesPath = (symbol: string, tickIso: string, feed: QuoteFeed = 'iex') =>
  path.join(DATA_DIR, feed === 'iex' ? 'trades' : 'trades-sip', symbol, `${stampOf(tickIso)}.json`);

export async function fetchQuotesWindow(
  symbol: string,
  tickIso: string,
  c: FetchCtx = {},
  feed: QuoteFeed = 'iex',
): Promise<StoredQuote[]> {
  const file = quotesPath(symbol, tickIso, feed);
  if (fresh(file)) return readJson<StoredQuote[]>(file)!;
  const ctx = ctxOf(c);
  const end = new Date(tickIso);
  const start = new Date(end.getTime() - 15 * 60_000);
  const params = new URLSearchParams({
    symbols: symbol,
    feed,
    start: start.toISOString(),
    end: end.toISOString(),
    limit: '10000',
  });
  const page = (await get(`${DATA_BASE}/v2/stocks/quotes?${params}`, ctx)) as {
    quotes?: Record<string, { t: string; bp: number; bs: number; ap: number; as: number }[]>;
  };
  const rows: StoredQuote[] = (page.quotes?.[symbol] ?? []).map((q) => ({
    t: q.t,
    bp: q.bp,
    bs: q.bs,
    ap: q.ap,
    as: q.as,
  }));
  writeJson(file, rows);
  return rows;
}

export async function fetchTradesWindow(
  symbol: string,
  tickIso: string,
  c: FetchCtx = {},
  feed: QuoteFeed = 'iex',
): Promise<StoredTrade[]> {
  const file = tradesPath(symbol, tickIso, feed);
  if (fresh(file)) return readJson<StoredTrade[]>(file)!;
  const ctx = ctxOf(c);
  const end = new Date(tickIso);
  const start = new Date(end.getTime() - 15 * 60_000);
  const params = new URLSearchParams({
    symbols: symbol,
    feed,
    start: start.toISOString(),
    end: end.toISOString(),
    limit: '10000',
  });
  const page = (await get(`${DATA_BASE}/v2/stocks/trades?${params}`, ctx)) as {
    trades?: Record<string, { t: string; p: number; s: number }[]>;
  };
  const rows: StoredTrade[] = (page.trades?.[symbol] ?? []).map((t) => ({ t: t.t, p: t.p, s: t.s }));
  writeJson(file, rows);
  return rows;
}

// ---------- news (per day) ----------

export const newsPath = (ymd: string) => path.join(DATA_DIR, 'news', `${ymd}.json`);

export async function fetchNewsDay(ymd: string, c: FetchCtx = {}): Promise<StoredNewsItem[]> {
  const file = newsPath(ymd);
  if (fresh(file)) return readJson<StoredNewsItem[]>(file)!;
  const ctx = ctxOf(c);
  const off = etOffsetForDate(ymd);
  const out: StoredNewsItem[] = [];
  let token: string | null | undefined;
  do {
    const params = new URLSearchParams({
      start: `${ymd}T00:00:00${off}`,
      end: `${ymd}T23:59:59${off}`,
      limit: '50',
      sort: 'desc',
    });
    if (token) params.set('page_token', token);
    const page = (await get(`${DATA_BASE}/v1beta1/news?${params}`, ctx)) as {
      news?: { headline: string; summary?: string; symbols?: string[]; created_at: string; source?: string }[];
      next_page_token?: string | null;
    };
    out.push(
      ...(page.news ?? []).map((n) => ({
        headline: n.headline,
        summary: n.summary ?? '',
        symbols: n.symbols ?? [],
        created_at: n.created_at,
        source: n.source ?? '',
      })),
    );
    token = page.next_page_token;
  } while (token && out.length < 1000);
  writeJson(file, out);
  return out;
}

export const loadNewsDay = (ymd: string): StoredNewsItem[] => readJson<StoredNewsItem[]>(newsPath(ymd)) ?? [];

// ---------- corporate actions (splits) ----------

export const actionsPath = () => path.join(DATA_DIR, 'actions.json');

export async function fetchActions(c: FetchCtx = {}): Promise<SplitAction[]> {
  if (fresh(actionsPath())) return readJson<SplitAction[]>(actionsPath())!;
  const ctx = ctxOf(c);
  const out: SplitAction[] = [];
  let token: string | null | undefined;
  do {
    const params = new URLSearchParams({
      types: 'forward_split,reverse_split',
      start: WINDOW.start,
      end: WINDOW.end,
      limit: '1000',
    });
    if (token) params.set('page_token', token);
    const page = (await get(`${DATA_BASE}/v1/corporate-actions?${params}`, ctx)) as {
      corporate_actions?: {
        forward_splits?: { symbol: string; ex_date: string; old_rate: number; new_rate: number }[];
        reverse_splits?: { symbol: string; ex_date: string; old_rate: number; new_rate: number }[];
      };
      next_page_token?: string | null;
    };
    for (const s of page.corporate_actions?.forward_splits ?? []) out.push(s);
    for (const s of page.corporate_actions?.reverse_splits ?? []) out.push(s);
    token = page.next_page_token;
  } while (token);
  writeJson(actionsPath(), out);
  return out;
}

export const loadActions = (): SplitAction[] => readJson<SplitAction[]>(actionsPath()) ?? [];

// ---------- probe ----------

export interface ProbeResult {
  pass: boolean;
  counts: { symbol: string; session: string; sip: number; iex: number }[];
}

/**
 * The load-bearing feed check: SIP must have extended-hours minute bars where
 * IEX (which only operates 08:00-17:00 ET) has none. Run before anything else.
 */
export async function probeFeeds(c: FetchCtx = {}): Promise<ProbeResult> {
  const ctx = ctxOf(c);
  const day = '2026-03-04';
  const off = etOffsetForDate(day);
  const sessions = [
    { name: 'afterhours 17:00-20:00', start: `${day}T17:00:00${off}`, end: `${day}T20:00:00${off}` },
    { name: 'premarket 04:00-08:00', start: `${day}T04:00:00${off}`, end: `${day}T08:00:00${off}` },
  ];
  const counts: ProbeResult['counts'] = [];
  let pass = true;
  for (const symbol of ['NVDA', 'TSLA', 'AAPL']) {
    for (const s of sessions) {
      const row = { symbol, session: s.name, sip: 0, iex: 0 };
      for (const feed of ['sip', 'iex'] as const) {
        const params = new URLSearchParams({
          symbols: symbol,
          timeframe: '1Min',
          feed,
          adjustment: 'raw',
          start: s.start,
          end: s.end,
          limit: '10000',
        });
        const page = (await get(`${DATA_BASE}/v2/stocks/bars?${params}`, ctx)) as AlpacaBarsPage;
        row[feed] = (page.bars?.[symbol] ?? []).length;
      }
      if (row.sip === 0) pass = false;
      counts.push(row);
    }
  }
  return { pass, counts };
}
