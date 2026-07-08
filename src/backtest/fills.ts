// Deterministic fill simulation over SIP minute bars (full plan §4; the 5h
// protocol inherits it unchanged). Pure functions — no IO, no wall clock;
// the only time source is the bar timestamps and the placement instant.
//
// Order lifetime (Alpaca DAY + extended_hours): an order works from its
// placement instant until 20:00 ET of its submission day, carrying across
// premarket -> RTH -> after-hours. Bars are timestamped at their OPEN, so a
// bar counts as "after placement" iff barOpen >= placement + 60s: the bar
// must start only after the order existed for the bar's entire duration —
// an order placed mid-bar can never fill on that partially elapsed bar.
//
// Fill rule: BUY qty Q at limit L fills at the first eligible bar with
// low < L (strict cross — a touch at exactly L is not a fill) whose
// session-scoped cumulative volume >= 20*Q. Cumulative volume sums bar
// volume from the first bar after placement through the crossing bar,
// counting ONLY bars in the crossing bar's session (production
// currentSession from src/clock.ts, evaluated on the bar open). SELL is
// mirrored: high > L. Fill price = L exactly; no partials. A missing bar is
// genuinely no prints -> no fill.
//
// Fees (sells only, keyed to the ET trade date of the fill; FINRA/SEC 2026
// schedule per the plan):
//   TAF  $0.000195/share, capped at $9.79 per trade (whole window)
//   SEC  $0 through 2026-04-03; $20.60 per $1M notional from 2026-04-06
// Amounts are exact (no cent rounding) so the ledger's double-entry
// invariant reconciles without accumulation error.
import { currentSession, nowET } from '../clock.js';
import type { Session } from '../types.js';
import type { StoredMinuteBar } from './types.js';
import { etOffsetForDate } from './data.js';

export const VOLUME_GUARD_MULTIPLE = 20;
export const TAF_PER_SHARE_USD = 0.000195;
export const TAF_CAP_USD = 9.79;
/** First trade date on which the 2026 SEC Section 31 rate applies. */
export const SEC_FEE_START_YMD = '2026-04-06';
export const SEC_FEE_PER_MILLION_USD = 20.6;
/** ETB borrow: 0.3%/yr, the plan's labeled conservatism. */
export const DEFAULT_BORROW_RATE_APR = 0.003;

const BAR_MS = 60_000;

export interface FillOrderSpec {
  side: 'buy' | 'sell';
  qty: number;
  limitPrice: number;
}

export interface FillOutcome {
  filled: true;
  /** Open timestamp of the crossing bar. */
  atIso: string;
  /** Sell-side regulatory fees at the fill's ET trade date; 0 for buys. */
  feesUsd: number;
}

export type SessionOfBar = (barIso: string) => Session;

/** Production session boundaries, evaluated on the bar-open instant. */
export const barSession: SessionOfBar = (barIso) => currentSession(new Date(barIso));

/** ET calendar day (YYYY-MM-DD) of an ISO instant. */
export const etYmdOf = (iso: string): string => nowET(new Date(iso)).ymd;

/**
 * 20:00 ET of the order's submission day (its death, per Alpaca DAY +
 * extended_hours semantics), as a UTC ISO instant. DST-safe: the offset is
 * resolved for the submission date itself (transitions happen at 02:00 ET,
 * never between noon and 20:00).
 */
export function orderExpiryIso(placedAtIso: string): string {
  const ymd = etYmdOf(placedAtIso);
  return new Date(`${ymd}T20:00:00${etOffsetForDate(ymd)}`).toISOString();
}

/**
 * Regulatory fees for a SELL of `qty` shares at `price`, keyed to the ET
 * trade date. Buys carry no fees; callers pass sells only.
 */
export function sellFeesUsd(qty: number, price: number, tradeYmd: string): number {
  const taf = Math.min(qty * TAF_PER_SHARE_USD, TAF_CAP_USD);
  const sec =
    tradeYmd >= SEC_FEE_START_YMD ? ((qty * price) / 1_000_000) * SEC_FEE_PER_MILLION_USD : 0;
  return taf + sec;
}

/**
 * Borrow cost for holding `shortMarketValue` of stock short for `days`
 * calendar days at an annualized rate (default 0.3%/yr), ACT/365.
 */
export function borrowAccrual(
  shortMarketValue: number,
  days: number,
  rate: number = DEFAULT_BORROW_RATE_APR,
): number {
  return Math.abs(shortMarketValue) * rate * (days / 365);
}

function assertOrderShape(order: FillOrderSpec): void {
  if (!Number.isInteger(order.qty) || order.qty < 1) {
    throw new Error(`invariant violation: non-integer or sub-1 qty ${order.qty}`);
  }
  if (!Number.isFinite(order.limitPrice) || order.limitPrice <= 0) {
    throw new Error(`invariant violation: non-finite or non-positive limit ${order.limitPrice}`);
  }
}

/**
 * Simulate one order against minute bars. Returns the fill (at the limit
 * price, on the crossing bar's open timestamp) or null if the order dies
 * unfilled at 20:00 ET of its submission day. Bars may be passed unsorted
 * and may span beyond the order's life; ineligible bars are ignored.
 */
export function tryFill(
  order: FillOrderSpec,
  bars: StoredMinuteBar[],
  placedAtIso: string,
  sessionOf: SessionOfBar = barSession,
): FillOutcome | null {
  assertOrderShape(order);
  const placedMs = Date.parse(placedAtIso);
  if (!Number.isFinite(placedMs)) throw new Error(`invalid placement instant: ${placedAtIso}`);
  const expiryMs = Date.parse(orderExpiryIso(placedAtIso));

  const eligible = bars
    .map((b) => ({ bar: b, ms: Date.parse(b.t) }))
    .filter(({ ms }) => ms >= placedMs + BAR_MS && ms < expiryMs)
    .sort((a, b) => a.ms - b.ms);

  const neededVolume = VOLUME_GUARD_MULTIPLE * order.qty;
  const cumVolumeBySession = new Map<Session, number>();

  for (const { bar } of eligible) {
    const session = sessionOf(bar.t);
    const cum = (cumVolumeBySession.get(session) ?? 0) + bar.v;
    cumVolumeBySession.set(session, cum);

    const crosses =
      order.side === 'buy' ? bar.l < order.limitPrice : bar.h > order.limitPrice;
    if (!crosses || cum < neededVolume) continue;

    const feesUsd =
      order.side === 'sell' ? sellFeesUsd(order.qty, order.limitPrice, etYmdOf(bar.t)) : 0;
    return { filled: true, atIso: bar.t, feesUsd };
  }
  return null;
}
