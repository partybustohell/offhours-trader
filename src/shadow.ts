// Shadow-mode evaluation of the flag-off P1-P3 signals — pure functions.
//
// Every thesis, each disabled signal is computed AS IF enabled, with its
// parameters exactly as frozen in the schema defaults, and the would-be
// decision is written to the audit log (kind: 'counterfactual'). Nothing is
// applied. When the paper soak reaches the 50-trade governance gate, this
// produces a genuine out-of-sample evaluation of each signal on live flow —
// parameters were fixed before outcomes existed, so there is nothing to fit.
//
// Signals whose default parameters make them inert even when enabled (amihud
// max_amihud=0, dispersion k=0) log their RAW FEATURE instead, so a threshold
// can later be chosen from the live distribution and pre-registered before
// use. Executor-time overlays (drawdown_throttle, risk_off) are deliberately
// NOT shadowed: they are book-level and conventional, and per-entry
// attribution — what the 50-trade evaluation needs — happens here at thesis
// time.
import type { Config } from './config.js';
import type { TickerMarketInfo } from './candidates.js';
import { computeRegime, NEUTRAL_REGIME, type Regime } from './regime.js';
import {
  antiChaseHaircut,
  gapContraBlock,
  isChasing,
  stddev,
  trendContraBlock,
  type Direction,
  type GapSignature,
} from './signals.js';
import { portfolioVolScalar, shrinkageCovariance } from './portfolio.js';

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

export interface ShadowEntryRecord {
  ticker: string;
  direction: Direction;
  anti_chase: { recentReturnPct?: number; wouldFire: boolean; haircut: number };
  amihud: { value?: number };
  dispersion: { stddev: number; n: number };
  trend_gate: { momentumPct?: number; pctOf52wHigh?: number; wouldBlock: boolean };
  gap: { gapPct?: number; relVolume?: number; wouldBlock: boolean };
}

/** One entry's shadow record: each gate/haircut computed force-enabled. */
export function shadowEntryRecord(
  ticker: string,
  direction: Direction,
  mi: TickerMarketInfo | undefined,
  agreeingConvictions: number[],
  cfg: Config,
): ShadowEntryRecord {
  const antiChaseOn = { ...cfg.signals.anti_chase, enabled: true };
  const trendOn = { ...cfg.signals.trend_gate, enabled: true };
  const gapOn = { ...cfg.signals.gap, enabled: true };
  const gap: GapSignature | undefined =
    mi?.gapPct !== undefined && mi?.gapRelVolume !== undefined
      ? { gapPct: mi.gapPct, relVolume: mi.gapRelVolume }
      : undefined;
  return {
    ticker,
    direction,
    anti_chase: {
      ...(mi?.recentReturnPct !== undefined ? { recentReturnPct: round4(mi.recentReturnPct) } : {}),
      wouldFire: isChasing(mi?.recentReturnPct, direction, antiChaseOn),
      haircut: antiChaseHaircut(mi?.recentReturnPct, direction, antiChaseOn),
    },
    amihud: {
      ...(mi?.amihudIlliquidity !== undefined ? { value: round4(mi.amihudIlliquidity) } : {}),
    },
    dispersion: { stddev: round4(stddev(agreeingConvictions)), n: agreeingConvictions.length },
    trend_gate: {
      ...(mi?.momentumPct !== undefined ? { momentumPct: round4(mi.momentumPct) } : {}),
      ...(mi?.pctOf52wHigh !== undefined ? { pctOf52wHigh: round4(mi.pctOf52wHigh) } : {}),
      wouldBlock: trendContraBlock(mi?.momentumPct, mi?.pctOf52wHigh, direction, trendOn),
    },
    gap: {
      ...(gap ? { gapPct: round4(gap.gapPct), relVolume: round4(gap.relVolume) } : {}),
      wouldBlock: gapContraBlock(gap, direction, gapOn),
    },
  };
}

/** Regime computed with every sub-signal force-enabled (params = defaults). */
export function shadowRegime(spyCloses: number[], cfg: Config): Regime {
  if (spyCloses.length === 0) return NEUTRAL_REGIME;
  const forced: Config['regime'] = {
    trend: { ...cfg.regime.trend, enabled: true },
    vol: { ...cfg.regime.vol, enabled: true },
    gross: { ...cfg.regime.gross, enabled: true },
  };
  return computeRegime(spyCloses, forced);
}

/**
 * Whole-book target-vol scalar force-enabled (target pct from config default).
 * null when any entry lacks a usable return series — same skip rule as the
 * live path, so the shadow never claims coverage the real signal wouldn't have.
 */
export function shadowPortfolioScalar(
  entries: { ticker: string; direction: 'long' | 'short'; targetNotionalUsd: number }[],
  returnsByTicker: Map<string, number[]>,
  equity: number,
  cfg: Config,
): number | null {
  if (entries.length === 0) return null;
  const series = entries.map((e) => returnsByTicker.get(e.ticker.toUpperCase()));
  if (series.some((s) => s === undefined || s.length < 2)) return null;
  const window = Math.min(Math.min(...series.map((s) => s!.length)), cfg.portfolio.cov_lookback_days);
  const aligned = series.map((s) => s!.slice(s!.length - window));
  const cov = shrinkageCovariance(aligned, cfg.portfolio.cov_shrinkage);
  const weightsUsd = entries.map((e) =>
    e.direction === 'long' ? e.targetNotionalUsd : -e.targetNotionalUsd,
  );
  return round4(portfolioVolScalar(weightsUsd, cov, cfg.portfolio.target_vol.pct, equity));
}
