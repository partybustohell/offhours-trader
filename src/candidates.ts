import type { AnalystName, AnalystNominations, Candidate, CandidateFile } from './types.js';
import type { Config } from './config.js';

export interface TickerMarketInfo {
  lastPrice: number;
  avgDollarVolume20d: number;
  /** Annualized close-to-close realized vol; used for risk-parity sizing.
   *  Optional so callers/data without it degrade to no vol scaling. */
  realizedVolAnnualized?: number;
  // Optional P1–P3 signal features from the name's daily bars. All optional so
  // callers/data without them leave the corresponding signal inert.
  /** Signed % return over the anti-chase lookback window. */
  recentReturnPct?: number;
  /** Amihud illiquidity (mean |ret|/$vol × 1e6). */
  amihudIlliquidity?: number;
  /** 12-1 style momentum (% return, skipping the most recent weeks). */
  momentumPct?: number;
  /** Last close as a fraction of the trailing 52-week high. */
  pctOf52wHigh?: number;
  /** Overnight gap % and relative volume from the most recent daily bar. */
  gapPct?: number;
  gapRelVolume?: number;
}

/**
 * Annualized realized volatility from a series of closes (close-to-close log
 * returns × √252). Returns undefined when there are too few points to be
 * meaningful — the sizing layer treats that as "no scaling".
 */
export function realizedVolAnnualized(closes: number[]): number | undefined {
  const c = closes.filter((x) => x > 0);
  if (c.length < 8) return undefined;
  const rets: number[] = [];
  for (let i = 1; i < c.length; i++) rets.push(Math.log(c[i]! / c[i - 1]!));
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

export function buildCandidates(
  nominations: AnalystNominations[],
  marketInfo: Map<string, TickerMarketInfo>,
  cfg: Config,
  dateYmd: string,
): CandidateFile {
  const byTicker = new Map<string, { analyst: AnalystName; reason: string }[]>();
  for (const an of nominations) {
    for (const nom of an.nominations) {
      const ticker = nom.ticker.trim().toUpperCase();
      if (!ticker) continue;
      const list = byTicker.get(ticker) ?? [];
      list.push({ analyst: an.analyst, reason: nom.reason });
      byTicker.set(ticker, list);
    }
  }

  const info = new Map<string, TickerMarketInfo>();
  for (const [k, v] of marketInfo) info.set(k.toUpperCase(), v);
  const excluded = new Set(cfg.universe.exclude.map((t) => t.toUpperCase()));

  const rejected: { ticker: string; reason: string }[] = [];
  const surviving: Candidate[] = [];
  for (const [ticker, nominatedBy] of byTicker) {
    if (excluded.has(ticker)) {
      rejected.push({ ticker, reason: 'on exclude list' });
      continue;
    }
    const mi = info.get(ticker);
    if (!mi) {
      rejected.push({ ticker, reason: 'no market data' });
      continue;
    }
    if (mi.lastPrice < cfg.universe.min_price) {
      rejected.push({ ticker, reason: 'price below min_price' });
      continue;
    }
    if (mi.avgDollarVolume20d < cfg.universe.min_avg_dollar_volume) {
      rejected.push({ ticker, reason: 'dollar volume below min_avg_dollar_volume' });
      continue;
    }
    surviving.push({
      ticker,
      nominatedBy,
      lastPrice: mi.lastPrice,
      avgDollarVolume20d: mi.avgDollarVolume20d,
    });
  }

  // Rank by nomination count, then dollar volume. Optional low-vol tiebreak
  // (P3, flag-off) prefers calmer names among otherwise-equal candidates.
  const volOf = (t: string): number => info.get(t.toUpperCase())?.realizedVolAnnualized ?? Infinity;
  surviving.sort(
    (a, b) =>
      b.nominatedBy.length - a.nominatedBy.length ||
      b.avgDollarVolume20d - a.avgDollarVolume20d ||
      (cfg.signals.low_vol.prefer_low_vol ? volOf(a.ticker) - volOf(b.ticker) : 0),
  );
  const candidates = surviving.slice(0, cfg.universe.max_candidates);
  for (const overflow of surviving.slice(cfg.universe.max_candidates)) {
    rejected.push({ ticker: overflow.ticker, reason: 'over max_candidates cap' });
  }

  return { date: dateYmd, candidates, rejected };
}
