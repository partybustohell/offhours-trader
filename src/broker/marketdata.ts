import type { QuoteSnapshot } from '../types.js';
import type { FetchFn, SleepFn } from './client.js';
import { defaultSleep, requestWithRetry } from './client.js';
import { realizedVolAnnualized as realizedVolFromCloses } from '../candidates.js';

const DATA_BASE_URL = 'https://data.alpaca.markets';
const MAX_SYMBOLS_PER_CALL = 100;

export interface MoverEntry {
  symbol: string;
  percent_change: number;
  price: number;
}
export interface Movers {
  gainers: MoverEntry[];
  losers: MoverEntry[];
}
export interface MostActive {
  symbol: string;
  volume: number;
  trade_count: number;
}
export interface NewsItem {
  headline: string;
  summary: string;
  symbols: string[];
  created_at: string;
  source: string;
}
export interface DailyBar {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  t: string;
}
export interface MarketInfo {
  lastPrice: number;
  avgDollarVolume20d: number;
  realizedVolAnnualized?: number;
}

interface RawQuote {
  bp?: number;
  bs?: number;
  ap?: number;
  as?: number;
  t?: string;
}
interface RawTrade {
  p?: number;
  s?: number;
  t?: string;
}
interface RawNews {
  headline?: string;
  summary?: string;
  symbols?: string[];
  created_at?: string;
  source?: string;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class AlpacaMarketData {
  private readonly headers: Record<string, string>;
  private readonly fetchFn: FetchFn;
  private readonly sleep: SleepFn;
  private readonly quoteFeed: 'iex' | 'sip';

  // Market data works with paper keys in every mode, including live.
  constructor(
    env: NodeJS.ProcessEnv = process.env,
    fetchFn: FetchFn = globalThis.fetch,
    sleep: SleepFn = defaultSleep,
    quoteFeed: 'iex' | 'sip' = 'iex',
  ) {
    const key = env.ALPACA_PAPER_KEY;
    const secret = env.ALPACA_PAPER_SECRET;
    if (!key || !secret) {
      throw new Error('market data requires ALPACA_PAPER_KEY and ALPACA_PAPER_SECRET in .env');
    }
    this.headers = { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret };
    this.fetchFn = fetchFn;
    this.sleep = sleep;
    this.quoteFeed = quoteFeed;
  }

  private request(path: string): Promise<unknown> {
    return requestWithRetry(
      `${DATA_BASE_URL}${path}`,
      { headers: this.headers },
      this.fetchFn,
      this.sleep,
    );
  }

  async getMovers(top = 20): Promise<Movers> {
    const raw = (await this.request(`/v1beta1/screener/stocks/movers?top=${top}`)) as {
      gainers?: MoverEntry[];
      losers?: MoverEntry[];
    };
    return { gainers: raw.gainers ?? [], losers: raw.losers ?? [] };
  }

  async getMostActives(top = 30): Promise<MostActive[]> {
    const raw = (await this.request(
      `/v1beta1/screener/stocks/most-actives?by=volume&top=${top}`,
    )) as { most_actives?: MostActive[] };
    return raw.most_actives ?? [];
  }

  async getNews(limit = 50, symbols?: string[]): Promise<NewsItem[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (symbols && symbols.length > 0) params.set('symbols', symbols.join(','));
    const raw = (await this.request(`/v1beta1/news?${params.toString()}`)) as {
      news?: RawNews[];
    };
    return (raw.news ?? []).map((n) => ({
      headline: n.headline ?? '',
      summary: n.summary ?? '',
      symbols: n.symbols ?? [],
      created_at: n.created_at ?? '',
      source: n.source ?? '',
    }));
  }

  /** Up to `limit` most recent daily bars per symbol, keyed by symbol. */
  async getDailyBars(symbols: string[], limit = 25): Promise<Map<string, DailyBar[]>> {
    const out = new Map<string, DailyBar[]>();
    if (symbols.length === 0) return out;
    // Alpaca defaults start to today; look back 2 calendar days per requested
    // bar to cover weekends/holidays.
    const start = new Date(Date.now() - limit * 2 * 86_400_000).toISOString();
    for (const group of chunk(symbols, MAX_SYMBOLS_PER_CALL)) {
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({
          symbols: group.join(','),
          timeframe: '1Day',
          feed: 'iex',
          start,
          limit: String(Math.min(10_000, group.length * limit)),
        });
        if (pageToken) params.set('page_token', pageToken);
        const raw = (await this.request(`/v2/stocks/bars?${params.toString()}`)) as {
          bars?: Record<string, DailyBar[] | null> | null;
          next_page_token?: string | null;
        };
        for (const [symbol, bars] of Object.entries(raw.bars ?? {})) {
          out.set(symbol, (out.get(symbol) ?? []).concat(bars ?? []));
        }
        pageToken = raw.next_page_token ?? undefined;
      } while (pageToken);
    }
    for (const [symbol, bars] of out) out.set(symbol, bars.slice(-limit));
    return out;
  }

  async getLatestQuotes(symbols: string[]): Promise<QuoteSnapshot[]> {
    if (symbols.length === 0) return [];
    const params = new URLSearchParams({ symbols: symbols.join(','), feed: this.quoteFeed });
    const [quotesRaw, tradesRaw] = await Promise.all([
      this.request(`/v2/stocks/quotes/latest?${params.toString()}`),
      this.request(`/v2/stocks/trades/latest?${params.toString()}`),
    ]);
    const quotes = (quotesRaw as { quotes?: Record<string, RawQuote> }).quotes ?? {};
    const trades = (tradesRaw as { trades?: Record<string, RawTrade> }).trades ?? {};
    const out: QuoteSnapshot[] = [];
    for (const symbol of symbols) {
      const quote = quotes[symbol];
      if (!quote) continue;
      const trade = trades[symbol];
      out.push({
        ticker: symbol,
        bid: quote.bp ?? 0,
        ask: quote.ap ?? 0,
        bidSize: quote.bs ?? 0,
        askSize: quote.as ?? 0,
        // Missing trade -> last 0, which fails the executor's band check (do nothing).
        last: trade?.p ?? 0,
        // A missing timestamp must read as STALE (empty), never forged to "now"
        // — the staleness guard depends on this to fail closed.
        asOf: quote.t ?? '',
      });
    }
    return out;
  }

  /**
   * lastPrice = most recent close; avgDollarVolume20d = mean of close*volume
   * over up to the 20 most recent bars. Symbols without bars are omitted.
   */
  async marketInfoFor(symbols: string[]): Promise<Map<string, MarketInfo>> {
    const barsBySymbol = await this.getDailyBars(symbols, 25);
    const out = new Map<string, MarketInfo>();
    for (const [symbol, bars] of barsBySymbol) {
      if (bars.length === 0) continue;
      const lastBar = bars[bars.length - 1]!;
      const recent = bars.slice(-20);
      const avgDollarVolume20d =
        recent.reduce((sum, b) => sum + b.c * b.v, 0) / recent.length;
      const realizedVolAnnualized = realizedVolFromCloses(recent.map((b) => b.c));
      out.set(symbol, { lastPrice: lastBar.c, avgDollarVolume20d, realizedVolAnnualized });
    }
    return out;
  }
}
