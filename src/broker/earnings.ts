// Scheduled-earnings calendar (Nasdaq public endpoint) with a 12h disk cache.
// Consumers: the pipeline's catalyst scan (universe.earnings_scan) and the
// executor's own-earnings entry guard (execution.earnings_guard).
//
// FAIL-OPEN BY CONTRACT: this is an unofficial, unauthenticated endpoint and
// may 403/timeout/change shape at any time. Every failure degrades to "no
// calendar data for that date" — the scan just carries less information and
// the guard admits the entry (core risk gates still apply), mirroring the
// risk_off SPY-fetch precedent. Callers audit the degradation; nothing throws
// past this module except programmer errors.
import type { FetchFn } from './client.js';
import { earningsCachePath, readJsonIfExists, writeJsonAtomic } from '../paths.js';
import { nowET } from '../clock.js';

const DAY_MS = 86_400_000;
const CACHE_TTL_MS = 12 * 3_600_000;
const FETCH_TIMEOUT_MS = 10_000;
const NASDAQ_BASE = 'https://api.nasdaq.com/api/calendar/earnings';

export interface EarningsEntry {
  symbol: string;
  name: string;
  /** 'pre' = before the open; 'post' = after the close; 'unknown' otherwise. */
  time: 'pre' | 'post' | 'unknown';
}

/** ymd (ET calendar date of the report) -> entries. Absent date = no data. */
export type EarningsByDate = Record<string, EarningsEntry[]>;

interface EarningsCacheFile {
  fetchedAtMs: number;
  days: EarningsByDate;
}

const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

/** Tolerant parse of the Nasdaq rows array. Unknown shapes yield []. */
export function parseNasdaqRows(raw: unknown): EarningsEntry[] {
  const rows = (raw as { data?: { rows?: unknown } })?.data?.rows;
  if (!Array.isArray(rows)) return [];
  const out: EarningsEntry[] = [];
  for (const row of rows) {
    const r = row as { symbol?: unknown; name?: unknown; time?: unknown };
    if (typeof r.symbol !== 'string') continue;
    const symbol = r.symbol.trim().toUpperCase();
    if (!TICKER_RE.test(symbol)) continue;
    const time =
      r.time === 'time-after-hours' ? 'post' : r.time === 'time-pre-market' ? 'pre' : 'unknown';
    out.push({ symbol, name: typeof r.name === 'string' ? r.name : '', time });
  }
  return out;
}

async function fetchDate(ymd: string, fetchFn: FetchFn): Promise<EarningsEntry[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchFn(`${NASDAQ_BASE}?date=${ymd}`, {
      headers: {
        // The endpoint rejects UA-less requests; a browser UA is the documented
        // community workaround for this public calendar.
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return parseNasdaqRows(await res.json());
  } catch {
    return null; // network/timeout/shape failure -> no data for this date
  } finally {
    clearTimeout(timer);
  }
}

/** Tolerant cache read; corrupt/missing -> null (refetch). */
function readCache(): EarningsCacheFile | null {
  try {
    const raw = readJsonIfExists<EarningsCacheFile>(earningsCachePath());
    if (!raw || typeof raw.fetchedAtMs !== 'number' || typeof raw.days !== 'object' || raw.days === null) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

/**
 * Calendar for ET dates [today .. today+daysAhead], served from the disk cache
 * when fresh (12h TTL and covering the requested range) so the 15-minute
 * executor tick hits the network at most twice a day. Dates whose fetch failed
 * are recorded as absent (fail-open) and re-attempted on the next refresh.
 * Returns { days, degraded } — degraded lists the dates with no data so the
 * caller can audit the gap.
 */
export async function loadEarningsCalendar(
  daysAhead: number,
  now: Date = new Date(),
  fetchFn: FetchFn = globalThis.fetch,
): Promise<{ days: EarningsByDate; degraded: string[] }> {
  const wanted: string[] = [];
  for (let d = 0; d <= daysAhead; d++) {
    wanted.push(nowET(new Date(now.getTime() + d * DAY_MS)).ymd);
  }

  const cached = readCache();
  if (
    cached &&
    now.getTime() - cached.fetchedAtMs <= CACHE_TTL_MS &&
    wanted.every((ymd) => ymd in cached.days)
  ) {
    return { days: cached.days, degraded: wanted.filter((ymd) => cached.days[ymd] === undefined) };
  }

  const days: EarningsByDate = {};
  const degraded: string[] = [];
  for (const ymd of wanted) {
    const entries = await fetchDate(ymd, fetchFn);
    if (entries === null) degraded.push(ymd);
    else days[ymd] = entries;
  }
  // Persist only what succeeded; failed dates stay absent so the TTL check
  // above forces a re-attempt rather than caching the failure for 12h.
  if (Object.keys(days).length > 0) {
    writeJsonAtomic(earningsCachePath(), { fetchedAtMs: now.getTime(), days });
  }
  return { days, degraded };
}

/**
 * The first scheduled report for `symbol` within the first `days`+1 entries of
 * `dayYmds` (today .. today+days), or null. Absent dates contribute nothing
 * (fail-open). Pure.
 */
export function earningsWithin(
  byDate: EarningsByDate,
  symbol: string,
  dayYmds: string[],
  days: number,
): { ymd: string; time: EarningsEntry['time'] } | null {
  const sym = symbol.toUpperCase();
  for (const ymd of dayYmds.slice(0, days + 1)) {
    const hit = byDate[ymd]?.find((e) => e.symbol === sym);
    if (hit) return { ymd, time: hit.time };
  }
  return null;
}

/** ET ymd strings [today .. today+daysAhead] for a given clock. Pure-ish. */
export function ymdRange(now: Date, daysAhead: number): string[] {
  const out: string[] = [];
  for (let d = 0; d <= daysAhead; d++) out.push(nowET(new Date(now.getTime() + d * DAY_MS)).ymd);
  return out;
}
