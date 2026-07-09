// Market-regime overlay — pure functions from an index (SPY) daily close
// series. Produces DOWN-ONLY direction scalars, a vol scalar, and a discrete
// conviction-threshold bump. Returns NEUTRAL (all 1, bump 0) when every regime
// signal is disabled, so it is inert by default. No IO/clock.
import type { Config } from './config.js';
import { realizedVolAnnualized } from './candidates.js';

export interface Regime {
  longScalar: number; // <= 1, multiplies long entry size
  shortScalar: number; // <= 1, multiplies short entry size
  volScalar: number; // <= 1, multiplies all entry size
  thresholdBump: number; // added to conviction_threshold (discrete gate)
  state: string; // human/audit label
}

export const NEUTRAL_REGIME: Regime = {
  longScalar: 1,
  shortScalar: 1,
  volScalar: 1,
  thresholdBump: 0,
  state: 'neutral',
};

function sma(xs: number[], n: number): number | undefined {
  if (xs.length < n || n < 1) return undefined;
  const w = xs.slice(-n);
  return w.reduce((s, x) => s + x, 0) / w.length;
}

/** Fraction of `series` strictly below its last value (0..1); 0.5 if too few. */
export function percentileRank(series: number[]): number {
  if (series.length < 2) return 0.5;
  const last = series[series.length - 1]!;
  const below = series.filter((x) => x < last).length;
  return below / (series.length - 1);
}

/** Rolling annualized realized vol, one value per day over the trailing window. */
export function rollingRealizedVol(
  closes: number[],
  volLookback: number,
  pctWindow: number,
): number[] {
  const out: number[] = [];
  const firstEnd = Math.max(volLookback + 1, closes.length - pctWindow);
  for (let end = firstEnd; end <= closes.length; end++) {
    const v = realizedVolAnnualized(closes.slice(end - volLookback - 1, end));
    if (v !== undefined) out.push(v);
  }
  return out;
}

/**
 * Compute the market regime from index daily closes. Each enabled sub-signal
 * multiplies the relevant scalar (down-only) and may add a threshold bump.
 */
export function computeRegime(indexCloses: number[], cfg: Config['regime']): Regime {
  let longScalar = 1;
  let shortScalar = 1;
  let volScalar = 1;
  let thresholdBump = 0;
  const states: string[] = [];
  const last = indexCloses[indexCloses.length - 1];

  // Trend (P1): index above/below its long SMA -> benign/hostile for longs.
  if (cfg.trend.enabled) {
    const ma = sma(indexCloses, cfg.trend.sma_long_days);
    if (ma !== undefined && last !== undefined) {
      const benign = last >= ma;
      longScalar *= benign ? cfg.trend.benign_long_scalar : cfg.trend.hostile_long_scalar;
      shortScalar *= benign ? cfg.trend.benign_short_scalar : cfg.trend.hostile_short_scalar;
      if (!benign) thresholdBump = Math.max(thresholdBump, cfg.trend.threshold_bump);
      states.push(benign ? 'trend:benign' : 'trend:hostile');
    }
  }

  // Volatility regime (P2): current index realized vol vs its trailing percentile.
  if (cfg.vol.enabled) {
    const series = rollingRealizedVol(indexCloses, cfg.vol.lookback_days, cfg.vol.percentile_window_days);
    if (series.length >= 2) {
      const pctile = percentileRank(series);
      if (pctile >= cfg.vol.stressed_pctile) {
        volScalar *= cfg.vol.stressed_scalar;
        states.push('vol:stressed');
      } else if (pctile >= cfg.vol.elevated_pctile) {
        volScalar *= cfg.vol.elevated_scalar;
        states.push('vol:elevated');
      } else {
        states.push('vol:normal');
      }
    }
  }

  // Gross-exposure regime (P2): index TSMOM — below its MA -> risk-off, shrink both sides.
  if (cfg.gross.enabled) {
    const ma = sma(indexCloses, cfg.gross.ma_days);
    if (ma !== undefined && last !== undefined && last < ma) {
      longScalar *= cfg.gross.risk_off_scalar;
      shortScalar *= cfg.gross.risk_off_scalar;
      states.push('gross:risk_off');
    }
  }

  return {
    longScalar,
    shortScalar,
    volScalar,
    thresholdBump,
    state: states.length > 0 ? states.join(',') : 'neutral',
  };
}
