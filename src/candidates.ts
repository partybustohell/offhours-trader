import type { AnalystName, AnalystNominations, Candidate, CandidateFile } from './types.js';
import type { Config } from './config.js';

export interface TickerMarketInfo {
  lastPrice: number;
  avgDollarVolume20d: number;
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

  surviving.sort(
    (a, b) =>
      b.nominatedBy.length - a.nominatedBy.length ||
      b.avgDollarVolume20d - a.avgDollarVolume20d,
  );
  const candidates = surviving.slice(0, cfg.universe.max_candidates);
  for (const overflow of surviving.slice(cfg.universe.max_candidates)) {
    rejected.push({ ticker: overflow.ticker, reason: 'over max_candidates cap' });
  }

  return { date: dateYmd, candidates, rejected };
}
