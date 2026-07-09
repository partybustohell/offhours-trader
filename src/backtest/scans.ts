// Scan reconstruction for the backtest (plan §2): per-day movers, most
// actives, news slices, bars summaries, marketInfo, dispersion scoring, and
// the two-strata episode sampler. Production shapes exactly — floors live
// ONLY inside the real buildCandidates, never here.
//
// Every *From function is pure and takes preloaded data (bar maps, news
// arrays) as arguments so unit tests need no store. The *For wrappers are
// thin loaders over src/backtest/data.ts.
//
// Bar-date convention: Alpaca daily bars are timestamped at the ET midnight
// open expressed in UTC (04:00/05:00Z), so the calendar day of a bar is
// t.slice(0, 10). Fixtures must follow the same convention.
import type { MarketInfo, MoverEntry, Movers, NewsItem } from '../broker/marketdata.js';
import type { EpisodeSpec, SampleFile, StoredDailyBar, StoredNewsItem } from './types.js';
import { WINDOW, etOffsetForDate, loadDailyBars, loadNewsDay, loadUniverse } from './data.js';
import { realizedVolAnnualized as realizedVolFromCloses } from '../candidates.js';

/** Production getMostActives() item minus trade_count (unavailable from bars). */
export interface ActiveEntry {
  symbol: string;
  volume: number;
}

const MOVERS_TOP = 20; // production getMovers(top = 20)
const ACTIVES_TOP = 30; // production getMostActives(top = 30)
const NEWS_CAP = 50; // production getNews(limit = 50)
const BARS_LOOKBACK = 25; // production getDailyBars(symbols, limit = 25)
const RANGE_LOOKBACK = 60; // barsSummary high/low window
const DISPERSION_MOVE_PCT = 5; // |day-over-day move| >= 5%
const DISPERSION_MIN_ADV = 20_000_000; // SIP 20d avg dollar volume >= $20M
const R_COUNT = 30;
const H_COUNT = 20;

const round2 = (n: number): number => Math.round(n * 100) / 100;
const ymdOfBar = (b: StoredDailyBar): string => b.t.slice(0, 10);

function sortedByTime(bars: StoredDailyBar[]): StoredDailyBar[] {
  return [...bars].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
}

/** Bars on or before day D, ascending. */
function barsUpTo(bars: StoredDailyBar[], day: string): StoredDailyBar[] {
  return sortedByTime(bars).filter((b) => ymdOfBar(b) <= day);
}

/**
 * Day-over-day close change for day D: D's close vs the immediately prior
 * bar's close. Null when the symbol has no bar on D, no prior bar, or a
 * non-positive prior close.
 */
function dayChange(bars: StoredDailyBar[], day: string): { pct: number; price: number } | null {
  const upTo = barsUpTo(bars, day);
  if (upTo.length < 2) return null;
  const lastBar = upTo[upTo.length - 1]!;
  if (ymdOfBar(lastBar) !== day) return null;
  const prev = upTo[upTo.length - 2]!;
  if (prev.c <= 0) return null;
  return { pct: ((lastBar.c - prev.c) / prev.c) * 100, price: lastBar.c };
}

// ---------- movers (production Movers shape: 20 gainers / 20 losers) ----------

/**
 * Top 20 gainers and top 20 losers by day-over-day SIP close change over the
 * whole universe, no floors. percent_change is rounded to 2 decimals and ties
 * break by symbol ascending, so output is deterministic regardless of map
 * iteration order.
 */
export function moversFrom(barsBySymbol: Map<string, StoredDailyBar[]>, day: string): Movers {
  const rows: MoverEntry[] = [];
  for (const [symbol, bars] of barsBySymbol) {
    const ch = dayChange(bars, day);
    if (!ch) continue;
    rows.push({ symbol, percent_change: round2(ch.pct), price: ch.price });
  }
  const gainers = [...rows]
    .sort((a, b) => b.percent_change - a.percent_change || a.symbol.localeCompare(b.symbol))
    .slice(0, MOVERS_TOP);
  const losers = [...rows]
    .sort((a, b) => a.percent_change - b.percent_change || a.symbol.localeCompare(b.symbol))
    .slice(0, MOVERS_TOP);
  return { gainers, losers };
}

// ---------- most actives (top 30 by SIP share volume) ----------

/** Top 30 symbols by day-D SIP share volume, no floors. Ties break by symbol. */
export function mostActivesFrom(
  barsBySymbol: Map<string, StoredDailyBar[]>,
  day: string,
): ActiveEntry[] {
  const rows: ActiveEntry[] = [];
  for (const [symbol, bars] of barsBySymbol) {
    const upTo = barsUpTo(bars, day);
    const lastBar = upTo[upTo.length - 1];
    if (!lastBar || ymdOfBar(lastBar) !== day) continue;
    rows.push({ symbol, volume: lastBar.v });
  }
  return rows
    .sort((a, b) => b.volume - a.volume || a.symbol.localeCompare(b.symbol))
    .slice(0, ACTIVES_TOP);
}

// ---------- news slices ----------

/** Epoch ms of `${ymd} ${hms}` in America/New_York (DST-correct per day). */
function etInstant(ymd: string, hms: string): number {
  return Date.parse(`${ymd}T${hms}${etOffsetForDate(ymd)}`);
}

function prevYmd(ymd: string): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

function toNewsItem(n: StoredNewsItem): NewsItem {
  return {
    headline: n.headline,
    summary: n.summary,
    symbols: n.symbols,
    created_at: n.created_at,
    source: n.source,
  };
}

/** Newest first; created_at ties break by headline then source (deterministic). */
function sortNewsDesc(items: StoredNewsItem[]): StoredNewsItem[] {
  return [...items].sort(
    (a, b) =>
      Date.parse(b.created_at) - Date.parse(a.created_at) ||
      a.headline.localeCompare(b.headline) ||
      a.source.localeCompare(b.source),
  );
}

/**
 * The 50 most recent items with created_at <= D 17:00 ET, newest first
 * (production getNews() limit=50 shape). The 17:00 boundary is inclusive.
 */
export function newsFrom(items: StoredNewsItem[], day: string): NewsItem[] {
  const cutoff = etInstant(day, '17:00:00');
  const eligible = items.filter((n) => Date.parse(n.created_at) <= cutoff);
  return sortNewsDesc(eligible).slice(0, NEWS_CAP).map(toNewsItem);
}

/**
 * The uncapped (D-1 17:00, D 17:00] ET slice (D-1 = previous calendar day),
 * newest first — the store for per-candidate verdict news. Lower bound
 * exclusive, upper bound inclusive.
 */
export function uncappedNewsFrom(items: StoredNewsItem[], day: string): NewsItem[] {
  const prev = prevYmd(day);
  const lo = etInstant(prev, '17:00:00');
  const hi = etInstant(day, '17:00:00');
  const eligible = items.filter((n) => {
    const t = Date.parse(n.created_at);
    return t > lo && t <= hi;
  });
  return sortNewsDesc(eligible).map(toNewsItem);
}

// ---------- bars summary (deterministic text, no LLM) ----------

/**
 * Deterministic template over the last 25 IEX daily bars as of D (production
 * lookback): 5d/20d % change, close position within the up-to-60-bar
 * high/low range, last volume vs the 20 prior bars' average, and the closing
 * up/down streak. Text only — never consumed by money math.
 */
export function barsSummaryFrom(bars: StoredDailyBar[], symbol: string, day: string): string {
  const upTo = barsUpTo(bars, day);
  if (upTo.length === 0) return `${symbol} as of ${day}: no daily bars.`;

  const range = upTo.slice(-RANGE_LOOKBACK);
  const recent = upTo.slice(-BARS_LOOKBACK);
  const closes = recent.map((b) => b.c);
  const lastBar = recent[recent.length - 1]!;

  const pctFrom = (back: number): number | null => {
    const prev = closes[closes.length - 1 - back];
    if (prev === undefined || prev === 0) return null;
    return round2(((lastBar.c - prev) / prev) * 100);
  };
  const signed = (n: number | null): string => (n === null ? 'n/a' : `${n >= 0 ? '+' : ''}${n}%`);

  const hi = Math.max(...range.map((b) => b.h));
  const lo = Math.min(...range.map((b) => b.l));
  const rangePos = hi > lo ? round2(((lastBar.c - lo) / (hi - lo)) * 100) : null;

  const prior = recent.slice(0, -1).slice(-20);
  const avgVol = prior.length > 0 ? prior.reduce((sum, b) => sum + b.v, 0) / prior.length : 0;
  const volRatio = avgVol > 0 ? round2(lastBar.v / avgVol) : null;

  let streak = 0;
  let streakDir: 'up' | 'down' = 'up';
  for (let i = recent.length - 1; i >= 1; i--) {
    const diff = recent[i]!.c - recent[i - 1]!.c;
    if (diff === 0) break;
    const dir = diff > 0 ? 'up' : 'down';
    if (streak === 0) {
      streakDir = dir;
      streak = 1;
    } else if (dir === streakDir) {
      streak++;
    } else {
      break;
    }
  }

  return [
    `${symbol} as of ${day}: close ${lastBar.c} (${recent.length} bars).`,
    `5d ${signed(pctFrom(5))}, 20d ${signed(pctFrom(20))}.`,
    `${range.length}-bar range ${lo}-${hi}; close at ${rangePos === null ? 'n/a' : `${rangePos}%`} of range.`,
    `Volume ${volRatio === null ? 'n/a' : `${volRatio}x`} vs 20d avg.`,
    streak > 0 ? `${streak}-day ${streakDir} streak.` : 'No close streak.',
  ].join(' ');
}

// ---------- marketInfo (IEX parity with AlpacaMarketData.marketInfoFor) ----------

/**
 * Mirrors AlpacaMarketData.marketInfoFor math exactly on the last 25 bars as
 * of D: lastPrice = most recent close; avgDollarVolume20d = mean(close *
 * volume) over up to the 20 most recent bars. Symbols with no bars omitted.
 */
export function marketInfoFrom(
  barsBySymbol: Map<string, StoredDailyBar[]>,
  day: string,
): Map<string, MarketInfo> {
  const out = new Map<string, MarketInfo>();
  for (const [symbol, all] of barsBySymbol) {
    const bars = barsUpTo(all, day).slice(-BARS_LOOKBACK);
    if (bars.length === 0) continue;
    const lastBar = bars[bars.length - 1]!;
    const recent = bars.slice(-20);
    const avgDollarVolume20d = recent.reduce((sum, b) => sum + b.c * b.v, 0) / recent.length;
    const realizedVolAnnualized = realizedVolFromCloses(recent.map((b) => b.c));
    out.set(symbol, { lastPrice: lastBar.c, avgDollarVolume20d, realizedVolAnnualized });
  }
  return out;
}

// ---------- dispersion (H-stratum ranking input) ----------

/**
 * Count of symbols with |day-over-day move| >= 5% AND SIP 20d avg dollar
 * volume (bars up to and including D) >= $20M. Move uses the unrounded
 * percent.
 */
export function dispersionScoreFrom(
  barsBySymbol: Map<string, StoredDailyBar[]>,
  day: string,
): number {
  let count = 0;
  for (const [, bars] of barsBySymbol) {
    const ch = dayChange(bars, day);
    if (!ch || Math.abs(ch.pct) < DISPERSION_MOVE_PCT) continue;
    const recent = barsUpTo(bars, day).slice(-20);
    const adv = recent.reduce((sum, b) => sum + b.c * b.v, 0) / recent.length;
    if (adv >= DISPERSION_MIN_ADV) count++;
  }
  return count;
}

// ---------- episode sampling (5h protocol, two strata) ----------

/** Deterministic 32-bit PRNG (mulberry32). Same seed -> same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Two-strata sample per the 5h protocol: 30 R days drawn uniformly without
 * replacement (persisted in draw order), then the top 20 dispersion days not
 * in R as H (descending dispersion, date ascending on ties). priority is the
 * pre-committed drop rank WITHIN each stratum (R: draw order, H: dispersion
 * rank) — the T+2:30 drop rule keeps the first 24 R and first 16 H. Strata
 * are never pooled for rate estimates.
 */
export function sampleEpisodes(
  tradingDays: string[],
  dispersionByDay: Map<string, number>,
  seed: number,
): SampleFile {
  const rand = mulberry32(seed);
  const remaining = [...tradingDays];
  const rDays: string[] = [];
  const rCount = Math.min(R_COUNT, remaining.length);
  for (let i = 0; i < rCount; i++) {
    const idx = Math.floor(rand() * remaining.length);
    rDays.push(remaining.splice(idx, 1)[0]!);
  }

  const rSet = new Set(rDays);
  const hDays = tradingDays
    .filter((d) => !rSet.has(d))
    .map((day) => ({ day, score: dispersionByDay.get(day) ?? 0 }))
    .sort((a, b) => b.score - a.score || a.day.localeCompare(b.day))
    .slice(0, H_COUNT);

  const episodes: EpisodeSpec[] = [
    ...rDays.map(
      (day, i): EpisodeSpec => ({
        day,
        stratum: 'R',
        priority: i,
        dispersionScore: dispersionByDay.get(day) ?? 0,
      }),
    ),
    ...hDays.map(
      (h, i): EpisodeSpec => ({
        day: h.day,
        stratum: 'H',
        priority: i,
        dispersionScore: h.score,
      }),
    ),
  ];
  return { seed, window: { start: WINDOW.start, end: WINDOW.end }, episodes };
}

// ---------- thin loader wrappers over src/backtest/data.ts ----------

function universeSymbols(): string[] {
  const universe = loadUniverse();
  if (!universe) {
    throw new Error('backtest-data/universe.json missing — run scripts/backtest-fetch.ts first');
  }
  return universe.map((a) => a.symbol);
}

function barsMap(feed: 'sip' | 'iex', symbols: string[]): Map<string, StoredDailyBar[]> {
  const out = new Map<string, StoredDailyBar[]>();
  for (const symbol of symbols) {
    const bars = loadDailyBars(feed, symbol);
    if (bars.length > 0) out.set(symbol, bars);
  }
  return out;
}

/** Movers for day D from stored SIP daily bars (whole universe by default). */
export function moversFor(day: string, symbols: string[] = universeSymbols()): Movers {
  return moversFrom(barsMap('sip', symbols), day);
}

/** Most actives for day D from stored SIP daily bars. */
export function mostActivesFor(day: string, symbols: string[] = universeSymbols()): ActiveEntry[] {
  return mostActivesFrom(barsMap('sip', symbols), day);
}

/**
 * Capped news for day D from the per-day store, walking back `lookbackDays`
 * calendar days so the 50-item window survives weekends/holidays.
 */
export function newsFor(day: string, lookbackDays = 7): NewsItem[] {
  const items: StoredNewsItem[] = [];
  let d = day;
  for (let i = 0; i <= lookbackDays; i++) {
    items.push(...loadNewsDay(d));
    d = prevYmd(d);
  }
  return newsFrom(items, day);
}

/** Uncapped (D-1 17:00, D 17:00] ET news slice from the per-day store. */
export function uncappedNewsFor(day: string): NewsItem[] {
  const items = [...loadNewsDay(prevYmd(day)), ...loadNewsDay(day)];
  return uncappedNewsFrom(items, day);
}

/** Bars summary text for one symbol from stored IEX daily bars. */
export function barsSummaryFor(symbol: string, day: string): string {
  return barsSummaryFrom(loadDailyBars('iex', symbol), symbol, day);
}

/** marketInfo for day D from stored IEX daily bars (production feed parity). */
export function marketInfoFor(symbols: string[], day: string): Map<string, MarketInfo> {
  return marketInfoFrom(barsMap('iex', symbols), day);
}

/** Dispersion score for day D from stored SIP daily bars. */
export function dispersionScoreFor(day: string, symbols: string[] = universeSymbols()): number {
  return dispersionScoreFrom(barsMap('sip', symbols), day);
}
