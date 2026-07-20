import type { AccountSnapshot, SizingAttribution, ThesisEntry, Verdict } from './types.js';
import type { Config } from './config.js';
import type { TickerMarketInfo } from './candidates.js';
import { NEUTRAL_REGIME, type Regime } from './regime.js';
import {
  amihudHaircut,
  antiChaseHaircut,
  attributeScalars,
  dispersionScalar,
  gapContraBlock,
  isChasing,
  stddev,
  trendContraBlock,
  type GapSignature,
} from './signals.js';
import { calibratedConviction } from './calibration.js';
import { inverseVolWeights, portfolioVolScalar, shrinkageCovariance } from './portfolio.js';

const DAY_MS = 86_400_000;

export function computeThesisEntries(
  verdicts: Verdict[],
  marketInfo: Map<string, TickerMarketInfo>,
  account: AccountSnapshot,
  cfg: Config,
  // Market regime overlay (default neutral -> all scalars 1, no threshold bump).
  regime: Regime = NEUTRAL_REGIME,
  // Per-ticker daily return series for the whole-book portfolio pass (P2).
  // Empty -> the portfolio pass is a no-op.
  returnsByTicker: Map<string, number[]> = new Map(),
): { entries: Omit<ThesisEntry, 'narrative'>[]; skipped: { ticker: string; reason: string }[] } {
  const byTicker = new Map<string, Verdict[]>();
  for (const v of verdicts) {
    const ticker = v.ticker.toUpperCase();
    const list = byTicker.get(ticker) ?? [];
    list.push(v);
    byTicker.set(ticker, list);
  }

  const info = new Map<string, TickerMarketInfo>();
  for (const [k, v] of marketInfo) info.set(k.toUpperCase(), v);

  const entries: Omit<ThesisEntry, 'narrative'>[] = [];
  const skipped: { ticker: string; reason: string }[] = [];

  for (const [ticker, vs] of byTicker) {
    // Quorum counts verdicts of any direction, including 'none'.
    if (vs.length < cfg.quorum) {
      skipped.push({ ticker, reason: 'quorum' });
      continue;
    }

    // Scores normalize over DIRECTIONAL weight only: abstentions ('none')
    // count toward quorum but never dilute a side's conviction. Opposing
    // directional votes DO dilute it, so the bear's veto power runs through
    // actual contrary verdicts, not through silence. Without this, five
    // abstention-friendly analysts cap the score near 0.45 and no threshold
    // in the configurable range is reachable (measured in the 2026-01..06
    // backtest: max composite 0.467 under responding-weight normalization).
    const longs = vs.filter((v) => v.direction === 'long');
    const shorts = vs.filter((v) => v.direction === 'short');
    const weightOf = (list: Verdict[]) =>
      list.reduce((sum, v) => sum + cfg.agent_weights[v.analyst], 0);
    const scoreOf = (list: Verdict[]) =>
      list.reduce((sum, v) => sum + cfg.agent_weights[v.analyst] * v.conviction, 0);
    const directionalWeightSum = weightOf(longs) + weightOf(shorts);
    if (directionalWeightSum === 0) {
      skipped.push({ ticker, reason: 'below threshold' });
      continue;
    }
    const longScore = scoreOf(longs) / directionalWeightSum;
    const shortScore = scoreOf(shorts) / directionalWeightSum;

    if (Math.min(longScore, shortScore) >= 0.3) {
      skipped.push({ ticker, reason: 'disagreement' });
      continue;
    }

    const direction: 'long' | 'short' = longScore >= shortScore ? 'long' : 'short';
    const agreeing = direction === 'long' ? longs : shorts;
    // A single analyst must not move money alone, however convinced.
    if (agreeing.length < cfg.min_agreeing) {
      skipped.push({ ticker, reason: 'agreement quorum' });
      continue;
    }
    // Optional monotone calibration of the raw score (identity by default),
    // then the regime threshold-bump: a hostile regime demands more conviction
    // (a discrete gate; neutral regime bump is 0, so unchanged by default).
    const rawConviction = direction === 'long' ? longScore : shortScore;
    const weightedConviction = calibratedConviction(rawConviction, cfg.calibration);
    if (weightedConviction < cfg.conviction_threshold + regime.thresholdBump) {
      skipped.push({ ticker, reason: 'below threshold' });
      continue;
    }

    const mi = info.get(ticker);
    if (!mi) {
      skipped.push({ ticker, reason: 'no market data' });
      continue;
    }

    // Counter-trend and catalyst-gap vetoes (flag-off by default -> never fire).
    if (trendContraBlock(mi.momentumPct, mi.pctOf52wHigh, direction, cfg.signals.trend_gate)) {
      skipped.push({ ticker, reason: 'trend gate' });
      continue;
    }
    const gap: GapSignature | undefined =
      mi.gapPct !== undefined && mi.gapRelVolume !== undefined
        ? { gapPct: mi.gapPct, relVolume: mi.gapRelVolume }
        : undefined;
    if (gapContraBlock(gap, direction, cfg.signals.gap)) {
      skipped.push({ ticker, reason: 'gap gate' });
      continue;
    }

    const p = mi.lastPrice;
    // Anti-chase tightens the CHASE side of the band (flag-off -> unchanged).
    const chasePct = isChasing(mi.recentReturnPct, direction, cfg.signals.anti_chase)
      ? cfg.max_chase_pct * (1 - cfg.signals.anti_chase.band_tighten_pct)
      : cfg.max_chase_pct;
    const limitBand =
      direction === 'long'
        ? { low: p * (1 - cfg.max_drop_pct / 100), high: p * (1 + chasePct / 100) }
        : { low: p * (1 - chasePct / 100), high: p * (1 + cfg.max_drop_pct / 100) };

    const baseNotional = Math.min(
      cfg.max_order_notional_usd,
      (account.equity * cfg.max_position_pct) / 100,
    );
    // Risk-parity: shrink the position when realized vol exceeds the target
    // reference (never scale UP past the notional cap). Missing vol -> no
    // scaling. This equalizes dollar risk across names of different volatility.
    const volScalar =
      mi.realizedVolAnnualized && mi.realizedVolAnnualized > 0
        ? Math.min(1, cfg.target_vol_pct / 100 / mi.realizedVolAnnualized)
        : 1;
    // Down-only signal scalars (each <=1; exactly 1 when disabled), combined
    // multiplicatively with a floor so stacking can't collapse the position.
    // volScalar stays SEPARATE so legacy sizing is byte-identical when off.
    const namedScalars: Record<string, number> = {
      anti_chase: antiChaseHaircut(mi.recentReturnPct, direction, cfg.signals.anti_chase),
      amihud: amihudHaircut(mi.amihudIlliquidity, cfg.signals.amihud),
      dispersion: dispersionScalar(agreeing.map((v) => v.conviction), cfg.signals.dispersion),
      regime_dir: direction === 'long' ? regime.longScalar : regime.shortScalar,
      regime_vol: regime.volScalar,
    };
    const attr = attributeScalars(namedScalars, cfg.signal_scalar_floor);
    const targetNotionalUsd =
      Math.round(baseNotional * weightedConviction * volScalar * attr.product * 100) / 100;
    // Counterfactual sizing record — only when a signal actually shrank the size,
    // so the flag-off default carries nothing extra. Feeds the testing plan's
    // leave-one-out attribution (docs/QUANT-TESTING-PLAN.md).
    const sizing: SizingAttribution | undefined =
      attr.product < 1
        ? {
            baseNotional,
            weightedConviction,
            volScalar,
            floor: cfg.signal_scalar_floor,
            scalars: attr.applied,
            product: attr.product,
            leaveOneOut: attr.leaveOneOut,
          }
        : undefined;

    const invalidationConditions = [
      ...new Set(
        vs
          .filter((v) => v.direction === direction)
          .flatMap((v) => v.invalidation_conditions),
      ),
    ];

    // Dominant verdict horizon of the agreeing analysts (strict majority for
    // 'weeks', else 'days') — feeds the exit engine's time-stop fallback.
    const weeksVotes = agreeing.filter((v) => v.horizon === 'weeks').length;
    const horizon: 'days' | 'weeks' = weeksVotes * 2 > agreeing.length ? 'weeks' : 'days';

    entries.push({
      ticker,
      direction,
      weightedConviction,
      limitBand,
      targetNotionalUsd,
      invalidationConditions,
      horizon,
      ...(sizing ? { sizing } : {}),
    });
  }

  // Whole-book portfolio sizing (P2, flag-off): covariance vol-targeting and/or
  // inverse-vol reallocation across all entries at once, so it runs after
  // per-name sizing and before ordering. No-op unless enabled AND per-ticker
  // return series are supplied.
  applyPortfolioSizing(entries, returnsByTicker, account.equity, cfg);

  // Sizing/portfolio discipline (deterministic, ethos-preserving): this only
  // orders, drops, and caps — it never adds risk or a directional vote.
  //
  // 1) Priority order. The executor consumes thesis.entries in array order and
  //    stops opening once the daily-deploy cap binds, so entry ORDER decides
  //    which names get funded. Sort so the best names go first, with a
  //    deterministic ticker tie-break. 'conviction_per_risk' divides by the
  //    name's realized vol so a fixed vol budget buys the best risk-adjusted
  //    names first (missing vol -> treated as 1).
  const volOf = (ticker: string): number => {
    const v = info.get(ticker)?.realizedVolAnnualized;
    return v && v > 0 ? v : 1;
  };
  const priorityOf = (e: Omit<ThesisEntry, 'narrative'>): number =>
    cfg.deploy_priority === 'conviction_per_risk'
      ? e.weightedConviction / volOf(e.ticker)
      : e.weightedConviction;
  entries.sort(
    (a, b) =>
      priorityOf(b) - priorityOf(a) || (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0),
  );

  // 2) Drop sub-floor positions (whole-share dust) and concentrate to the top
  //    max_open_names, both AFTER the sort so the highest-priority names
  //    survive the cap.
  const funded: Omit<ThesisEntry, 'narrative'>[] = [];
  for (const e of entries) {
    if (e.targetNotionalUsd < cfg.min_position_notional_usd) {
      skipped.push({ ticker: e.ticker, reason: 'below min position' });
    } else if (funded.length >= cfg.max_open_names) {
      skipped.push({ ticker: e.ticker, reason: 'over max_open_names' });
    } else {
      funded.push(e);
    }
  }

  return { entries: funded, skipped };
}

/**
 * Whole-book portfolio sizing (P2). Mutates each entry's targetNotionalUsd.
 * No-op unless portfolio.target_vol is enabled or sizing_mode is 'inverse_vol'
 * AND a daily return series exists for EVERY entry (partial data -> skip, so
 * the book is never sized on an incomplete covariance). Both adjustments are
 * bounded by the per-name base notional and are down-only for target-vol.
 */
function applyPortfolioSizing(
  entries: Omit<ThesisEntry, 'narrative'>[],
  returnsByTicker: Map<string, number[]>,
  equity: number,
  cfg: Config,
): void {
  const pcfg = cfg.portfolio;
  const useTargetVol = pcfg.target_vol.enabled;
  const useInverseVol = pcfg.sizing_mode === 'inverse_vol';
  if (entries.length === 0 || (!useTargetVol && !useInverseVol)) return;

  const series = entries.map((e) => returnsByTicker.get(e.ticker.toUpperCase()));
  if (series.some((s) => s === undefined || s.length < 2)) return;
  // Align to a common length AND honor the configured covariance window.
  const window = Math.min(Math.min(...series.map((s) => s!.length)), pcfg.cov_lookback_days);
  const aligned = series.map((s) => s!.slice(s!.length - window));
  const baseNotional = Math.min(cfg.max_order_notional_usd, (equity * cfg.max_position_pct) / 100);

  if (useInverseVol) {
    const sigmas = aligned.map((r) => stddev(r));
    const weights = inverseVolWeights(sigmas, entries.map((e) => e.weightedConviction));
    const budget = entries.reduce((s, e) => s + e.targetNotionalUsd, 0);
    entries.forEach((e, i) => {
      e.targetNotionalUsd = Math.round(Math.min(baseNotional, budget * weights[i]!) * 100) / 100;
    });
  }
  if (useTargetVol) {
    const cov = shrinkageCovariance(aligned, pcfg.cov_shrinkage);
    const weightsUsd = entries.map((e) =>
      e.direction === 'long' ? e.targetNotionalUsd : -e.targetNotionalUsd,
    );
    const scalar = portfolioVolScalar(weightsUsd, cov, pcfg.target_vol.pct, equity);
    entries.forEach((e) => {
      e.targetNotionalUsd = Math.round(e.targetNotionalUsd * scalar * 100) / 100;
    });
  }
}

// ET-minus-UTC offset in ms at the given instant, via Intl (DST-safe).
function etOffsetMs(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`missing ${type} in Intl parts`);
    return Number(part.value);
  };
  const asIfUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asIfUtc - at.getTime();
}

/**
 * ISO UTC instant of 20:00 ET on the next weekday after dateYmd (Sat/Sun
 * skipped). Market holidays are treated as weekdays (documented v1 limitation).
 */
export function thesisExpiry(dateYmd: string): string {
  const [y, m, d] = dateYmd.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined || [y, m, d].some(Number.isNaN)) {
    throw new Error(`invalid date: ${dateYmd}`);
  }
  // Noon UTC avoids any day drift when stepping calendar days.
  let t = Date.UTC(y, m - 1, d, 12);
  do {
    t += DAY_MS;
  } while (new Date(t).getUTCDay() === 0 || new Date(t).getUTCDay() === 6);
  const target = new Date(t);
  const guess = Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), 20);
  let result = guess - etOffsetMs(new Date(guess));
  const offsetAtResult = etOffsetMs(new Date(result));
  if (guess - offsetAtResult !== result) result = guess - offsetAtResult;
  return new Date(result).toISOString();
}

/**
 * ISO UTC instant of 16:00 ET (the close) on dateYmd itself — an RTH thesis is
 * generated in the morning and traded only through that day's regular session.
 */
export function rthThesisExpiry(dateYmd: string): string {
  const [y, m, d] = dateYmd.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined || [y, m, d].some(Number.isNaN)) {
    throw new Error(`invalid date: ${dateYmd}`);
  }
  const guess = Date.UTC(y, m - 1, d, 16);
  let result = guess - etOffsetMs(new Date(guess));
  const offsetAtResult = etOffsetMs(new Date(result));
  if (guess - offsetAtResult !== result) result = guess - offsetAtResult;
  return new Date(result).toISOString();
}
