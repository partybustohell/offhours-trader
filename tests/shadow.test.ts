import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config.js';
import { shadowEntryRecord, shadowPortfolioScalar, shadowRegime, verdictAgreement } from '../src/shadow.js';
import type { TickerMarketInfo } from '../src/candidates.js';

const cfg = ConfigSchema.parse({ mode: 'paper' });

describe('shadowEntryRecord', () => {
  it('fires force-enabled gates that the live (flag-off) config never would', () => {
    const mi: TickerMarketInfo = {
      lastPrice: 100,
      avgDollarVolume20d: 50_000_000,
      recentReturnPct: 15, // > default run_threshold 10 -> chasing for a long
      amihudIlliquidity: 0.42,
      momentumPct: 40,
      pctOf52wHigh: 0.95, // strong uptrend
      gapPct: 5, // big gap up on volume
      gapRelVolume: 3,
    };
    // A SHORT into a strong uptrend + fading a big gap up: both gates fire.
    const rec = shadowEntryRecord('XYZ', 'short', mi, [0.6, 0.8], cfg);
    expect(rec.trend_gate.wouldBlock).toBe(true);
    expect(rec.gap.wouldBlock).toBe(true);
    expect(rec.anti_chase.wouldFire).toBe(false); // shorting strength is not chasing
    expect(rec.amihud.value).toBe(0.42);
    expect(rec.dispersion.n).toBe(2);
    expect(rec.dispersion.stddev).toBeCloseTo(0.1414, 3);

    // The LONG side of the same tape: chasing fires, contra gates do not.
    const long = shadowEntryRecord('XYZ', 'long', mi, [0.6], cfg);
    expect(long.anti_chase.wouldFire).toBe(true);
    expect(long.anti_chase.haircut).toBe(0.5); // schema-default haircut
    expect(long.trend_gate.wouldBlock).toBe(false);
    expect(long.gap.wouldBlock).toBe(false);
  });

  it('degrades to no-fire when features are missing', () => {
    const rec = shadowEntryRecord('ABC', 'long', undefined, [], cfg);
    expect(rec.anti_chase.wouldFire).toBe(false);
    expect(rec.trend_gate.wouldBlock).toBe(false);
    expect(rec.gap.wouldBlock).toBe(false);
    expect(rec.amihud.value).toBeUndefined();
  });
});

describe('shadowRegime', () => {
  it('reads hostile with every sub-signal force-enabled on a falling tape', () => {
    // 260 closes trending down: last well below the 200-day SMA.
    const closes = Array.from({ length: 260 }, (_, i) => 500 - i);
    const regime = shadowRegime(closes, cfg);
    expect(regime.state).toContain('trend:hostile');
    expect(regime.state).toContain('gross:risk_off');
    expect(regime.longScalar).toBeLessThan(1);
  });

  it('neutral on an empty series', () => {
    expect(shadowRegime([], cfg).state).toBe('neutral');
  });
});

describe('shadowPortfolioScalar', () => {
  it('null when any entry lacks a return series (same skip rule as live)', () => {
    expect(
      shadowPortfolioScalar(
        [{ ticker: 'A', direction: 'long', targetNotionalUsd: 1000 }],
        new Map(),
        100_000,
        cfg,
      ),
    ).toBeNull();
  });

  it('caps at 1 for a tiny, calm book (down-only)', () => {
    const returns = new Map([
      ['A', Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 0.001 : -0.001))],
    ]);
    const scalar = shadowPortfolioScalar(
      [{ ticker: 'A', direction: 'long', targetNotionalUsd: 1000 }],
      returns,
      100_000,
      cfg,
    );
    expect(scalar).toBe(1);
  });
});

describe('verdictAgreement (shadow-model bridge)', () => {
  const v = (
    analyst: string,
    ticker: string,
    direction: string,
    conviction: number,
  ): { analyst: string; ticker: string; direction: string; conviction: number } => ({
    analyst,
    ticker,
    direction,
    conviction,
  });

  it('joins on (analyst, ticker) and scores direction match + conviction delta', () => {
    const primary = [
      v('fundamental', 'NVDA', 'long', 0.7),
      v('bear', 'NVDA', 'short', 0.6),
      v('macro', 'GS', 'none', 0.5),
    ];
    const shadow = [
      v('fundamental', 'nvda', 'long', 0.6), // case-insensitive ticker join
      v('bear', 'NVDA', 'long', 0.6), // direction flip
      v('sentiment', 'XOM', 'long', 0.9), // no primary counterpart -> ignored
    ];
    const a = verdictAgreement(primary, shadow);
    expect(a.pairs).toBe(2);
    expect(a.directionMatchPct).toBe(0.5);
    expect(a.meanAbsConvictionDelta).toBeCloseTo(0.05, 4);
    expect(a.directionalPrimary).toBe(2); // long + short (none excluded)
    expect(a.directionalShadow).toBe(3);
  });

  it('zero joint pairs yields nulls, not fake agreement', () => {
    const a = verdictAgreement([v('bear', 'NVDA', 'short', 0.6)], []);
    expect(a.pairs).toBe(0);
    expect(a.directionMatchPct).toBeNull();
    expect(a.meanAbsConvictionDelta).toBeNull();
  });
});
