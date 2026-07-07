import type { AccountSnapshot, ThesisEntry, Verdict } from './types.js';
import type { Config } from './config.js';
import type { TickerMarketInfo } from './candidates.js';

const DAY_MS = 86_400_000;

export function computeThesisEntries(
  verdicts: Verdict[],
  marketInfo: Map<string, TickerMarketInfo>,
  account: AccountSnapshot,
  cfg: Config,
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

    const respondingWeightSum = vs.reduce((sum, v) => sum + cfg.agent_weights[v.analyst], 0);
    const longScore =
      vs.filter((v) => v.direction === 'long')
        .reduce((sum, v) => sum + cfg.agent_weights[v.analyst] * v.conviction, 0) /
      respondingWeightSum;
    const shortScore =
      vs.filter((v) => v.direction === 'short')
        .reduce((sum, v) => sum + cfg.agent_weights[v.analyst] * v.conviction, 0) /
      respondingWeightSum;

    if (Math.min(longScore, shortScore) >= 0.3) {
      skipped.push({ ticker, reason: 'disagreement' });
      continue;
    }

    const direction: 'long' | 'short' = longScore >= shortScore ? 'long' : 'short';
    const weightedConviction = direction === 'long' ? longScore : shortScore;
    if (weightedConviction < cfg.conviction_threshold) {
      skipped.push({ ticker, reason: 'below threshold' });
      continue;
    }

    const mi = info.get(ticker);
    if (!mi) {
      skipped.push({ ticker, reason: 'no market data' });
      continue;
    }

    const p = mi.lastPrice;
    const limitBand =
      direction === 'long'
        ? { low: p * (1 - cfg.max_drop_pct / 100), high: p * (1 + cfg.max_chase_pct / 100) }
        : { low: p * (1 - cfg.max_chase_pct / 100), high: p * (1 + cfg.max_drop_pct / 100) };

    const baseNotional = Math.min(
      cfg.max_order_notional_usd,
      (account.equity * cfg.max_position_pct) / 100,
    );
    const targetNotionalUsd = Math.round(baseNotional * weightedConviction * 100) / 100;

    const invalidationConditions = [
      ...new Set(
        vs
          .filter((v) => v.direction === direction)
          .flatMap((v) => v.invalidation_conditions),
      ),
    ];

    entries.push({ ticker, direction, weightedConviction, limitBand, targetNotionalUsd, invalidationConditions });
  }

  return { entries, skipped };
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
