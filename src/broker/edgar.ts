// SEC EDGAR primary-text fetcher (universe.edgar_content) — gives the verdict
// round the ACTUAL 8-K / press-release text instead of a news vendor's
// paraphrase. Reading guidance language in the primary document is the one
// durable comparative advantage an LLM panel has over keyword scanners
// (registry row edgar-content-2026-07-28); this module is the information-
// provision half — the panel still decides everything.
//
// FAIL-OPEN BY CONTRACT, mirroring earnings.ts: every failure degrades to "no
// filing text for that ticker" and is reported in `degraded` for the caller to
// audit. Nothing throws past this module except programmer errors.
//
// SEC fair-access rules: <= 10 requests/second and a descriptive User-Agent
// with contact information. Fetches run SEQUENTIALLY per ticker (at most ~3
// requests each) so a full 25-candidate pass stays far under the limit.
import type { FetchFn } from './client.js';
import { stripHtmlContent } from './marketdata.js';
import { edgarCikCachePath, readJsonIfExists, writeJsonAtomic } from '../paths.js';

const SEC_UA = 'offhours-trader/0.1 research contact: shiv750815@gmail.com';
const TICKER_MAP_URL = 'https://www.sec.gov/files/company_tickers.json';
const CIK_CACHE_TTL_MS = 7 * 86_400_000; // the ticker->CIK map barely moves
const FETCH_TIMEOUT_MS = 15_000;
const FORMS = ['8-K', '8-K/A'];

export interface FilingText {
  form: string;
  /** Filing date, YYYY-MM-DD. */
  filed: string;
  /** Document fetched (audit trail). */
  url: string;
  /** HTML-stripped, truncated primary text. */
  text: string;
}

interface CikCacheFile {
  fetchedAtMs: number;
  /** UPPERCASE ticker -> 10-digit zero-padded CIK. */
  byTicker: Record<string, string>;
}

/** Tolerant parse of company_tickers.json ({"0": {cik_str, ticker, title}}). */
export function parseCikMap(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const value of Object.values(raw as Record<string, unknown>)) {
    const row = value as { cik_str?: unknown; ticker?: unknown };
    if (typeof row?.ticker !== 'string' || typeof row?.cik_str !== 'number') continue;
    out[row.ticker.toUpperCase()] = String(row.cik_str).padStart(10, '0');
  }
  return out;
}

/** Recent-filings arrays from data.sec.gov/submissions (parallel columns). */
export interface RecentFilings {
  form: string[];
  filingDate: string[];
  accessionNumber: string[];
  primaryDocument: string[];
}

/**
 * The newest filing whose form is in `forms` and whose filingDate >= sinceYmd,
 * from the parallel column arrays (index 0 is newest). Pure.
 */
export function pickLatestFiling(
  recent: Partial<RecentFilings> | undefined,
  forms: string[],
  sinceYmd: string,
): { form: string; filed: string; accession: string; primaryDocument: string } | null {
  const f = recent?.form;
  const d = recent?.filingDate;
  const a = recent?.accessionNumber;
  const p = recent?.primaryDocument;
  if (!Array.isArray(f) || !Array.isArray(d) || !Array.isArray(a) || !Array.isArray(p)) return null;
  for (let i = 0; i < f.length; i++) {
    const form = f[i];
    const filed = d[i];
    const accession = a[i];
    const primaryDocument = p[i];
    if (
      typeof form !== 'string' ||
      typeof filed !== 'string' ||
      typeof accession !== 'string' ||
      typeof primaryDocument !== 'string'
    ) {
      continue;
    }
    if (filed < sinceYmd) return null; // columns are newest-first: past the window, stop
    if (forms.includes(form)) return { form, filed, accession, primaryDocument };
  }
  return null;
}

/**
 * The document worth reading from a filing's directory listing: the earnings
 * press release is almost always an EX-99 exhibit (ex99*.htm / *ex99_1.htm),
 * which carries the actual results-and-guidance text; the 8-K body often only
 * incorporates it by reference. Fall back to the primary document. Pure.
 */
export function pickPressReleaseDoc(items: { name?: unknown }[], primaryDocument: string): string {
  for (const item of items) {
    const name = typeof item?.name === 'string' ? item.name : '';
    if (/ex[-_.]?99/i.test(name) && /\.html?$/i.test(name)) return name;
  }
  return primaryDocument;
}

/** Archive URL for one document of one filing. Pure. */
export function filingDocUrl(cik10: string, accession: string, doc: string): string {
  const cikNum = String(Number(cik10)); // archives path uses the unpadded CIK
  const accNoDashes = accession.replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNoDashes}/${doc}`;
}

async function fetchJson(url: string, fetchFn: FetchFn): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      headers: { 'User-Agent': SEC_UA, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string, fetchFn: FetchFn): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      headers: { 'User-Agent': SEC_UA },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Tolerant cache read; corrupt/missing/expired -> null (refetch). */
function readCikCache(now: Date): Record<string, string> | null {
  try {
    const raw = readJsonIfExists<CikCacheFile>(edgarCikCachePath());
    if (
      !raw ||
      typeof raw.fetchedAtMs !== 'number' ||
      typeof raw.byTicker !== 'object' ||
      raw.byTicker === null ||
      now.getTime() - raw.fetchedAtMs > CIK_CACHE_TTL_MS
    ) {
      return null;
    }
    return raw.byTicker;
  } catch {
    return null;
  }
}

/** Ticker -> 10-digit CIK map, disk-cached 7 days. null on fetch failure. */
export async function loadCikMap(
  now: Date = new Date(),
  fetchFn: FetchFn = globalThis.fetch,
): Promise<Record<string, string> | null> {
  const cached = readCikCache(now);
  if (cached) return cached;
  const raw = await fetchJson(TICKER_MAP_URL, fetchFn);
  if (raw === null) return null;
  const byTicker = parseCikMap(raw);
  if (Object.keys(byTicker).length === 0) return null;
  writeJsonAtomic(edgarCikCachePath(), { fetchedAtMs: now.getTime(), byTicker });
  return byTicker;
}

/**
 * Recent-8-K primary text for each ticker: at most one filing per name, filed
 * within `lookback_days` of `now` (ET-agnostic: plain calendar days), text
 * stripped and truncated to `max_chars`. Sequential fetches; every failure —
 * CIK map, submissions, document — lands the ticker in `degraded` and the
 * pipeline proceeds without it (fail-open).
 */
export async function loadRecentFilings(
  tickers: string[],
  opts: { lookback_days: number; max_chars: number },
  now: Date = new Date(),
  fetchFn: FetchFn = globalThis.fetch,
): Promise<{ filings: Map<string, FilingText>; degraded: string[] }> {
  const filings = new Map<string, FilingText>();
  const degraded: string[] = [];
  const sinceYmd = new Date(now.getTime() - opts.lookback_days * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const cikMap = await loadCikMap(now, fetchFn);
  if (cikMap === null) {
    // Whole-map outage: every ticker is degraded, nothing else to try.
    return { filings, degraded: tickers.map((t) => t.toUpperCase()) };
  }

  for (const raw of tickers) {
    const ticker = raw.toUpperCase();
    const cik = cikMap[ticker];
    if (!cik) {
      degraded.push(ticker);
      continue;
    }
    const submissions = (await fetchJson(
      `https://data.sec.gov/submissions/CIK${cik}.json`,
      fetchFn,
    )) as { filings?: { recent?: Partial<RecentFilings> } } | null;
    const filing = pickLatestFiling(submissions?.filings?.recent, FORMS, sinceYmd);
    if (!filing) {
      // No recent 8-K is the NORMAL case, not a degradation — only a failed
      // submissions fetch counts as degraded.
      if (submissions === null) degraded.push(ticker);
      continue;
    }
    // Prefer the EX-99 press-release exhibit via the filing's index listing;
    // a failed index fetch just falls back to the primary document.
    const accNoDashes = filing.accession.replace(/-/g, '');
    const index = (await fetchJson(
      `https://www.sec.gov/Archives/edgar/data/${String(Number(cik))}/${accNoDashes}/index.json`,
      fetchFn,
    )) as { directory?: { item?: { name?: unknown }[] } } | null;
    const doc = pickPressReleaseDoc(index?.directory?.item ?? [], filing.primaryDocument);
    const url = filingDocUrl(cik, filing.accession, doc);
    const html = await fetchText(url, fetchFn);
    if (html === null) {
      degraded.push(ticker);
      continue;
    }
    const text = stripHtmlContent(html, opts.max_chars);
    if (text.length === 0) continue; // empty document: nothing to feed the panel
    filings.set(ticker, { form: filing.form, filed: filing.filed, url, text });
  }
  return { filings, degraded };
}
