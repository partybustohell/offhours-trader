// Feedback loop primitives (realized outcomes -> calibration table + agent
// weight proposals) — pure functions, no IO/clock. scripts/feedback-report.ts
// fetches fills, joins thesis/verdict files, and writes the report.
//
// GOVERNANCE: nothing here auto-applies. A fitted calibration table or weight
// proposal becomes valid only once >= calibration.min_trades out-of-sample
// closed trades exist, and applying either remains a manual, operator-reviewed
// config.yaml change. Until then the report is measurement, not control.
import { ANALYSTS, type AnalystName, type Verdict } from './types.js';
import type { FillActivity } from './broker/client.js';
import type { CalibrationPoint } from './calibration.js';

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/** One fully-flattened position (entry fills paired with exit fills, FIFO). */
export interface RoundTrip {
  ticker: string;
  direction: 'long' | 'short';
  /** Absolute shares round-tripped (the flattened quantity). */
  qty: number;
  entryAvgPrice: number;
  exitAvgPrice: number;
  openedAt: string; // ISO of the first opening fill
  closedAt: string; // ISO of the flattening fill
  /** Direction-aware % return on the entry VWAP (positive = win). */
  returnPct: number;
  realizedPnlUsd: number;
}

/**
 * Reconstruct closed round trips from raw fill activities. Per symbol,
 * chronological: flat -> open accumulates an entry VWAP, opposite-side fills
 * accumulate an exit VWAP, and the trip closes when the position returns to
 * flat (or flips — the flip closes the old trip and opens a new one at the
 * flip fill's price). Still-open positions are not emitted. Zero/negative
 * qty or price fills are dropped defensively.
 */
export function pairRoundTrips(fills: FillActivity[]): RoundTrip[] {
  const bySymbol = new Map<string, FillActivity[]>();
  for (const f of fills) {
    if (!(f.qty > 0) || !(f.price > 0)) continue;
    const key = f.ticker.toUpperCase();
    const list = bySymbol.get(key) ?? [];
    list.push(f);
    bySymbol.set(key, list);
  }

  const trips: RoundTrip[] = [];
  for (const [ticker, list] of bySymbol) {
    list.sort((a, b) => a.transactionTime.localeCompare(b.transactionTime));
    let pos = 0; // signed shares
    let direction: 'long' | 'short' = 'long';
    let openedAt = '';
    let entryQty = 0;
    let entryCost = 0;
    let exitQty = 0;
    let exitProceeds = 0;

    const open = (signed: number, fill: FillActivity): void => {
      direction = signed > 0 ? 'long' : 'short';
      openedAt = fill.transactionTime;
      entryQty = Math.abs(signed);
      entryCost = Math.abs(signed) * fill.price;
      exitQty = 0;
      exitProceeds = 0;
    };
    const close = (closedAt: string): void => {
      if (entryQty <= 0 || exitQty <= 0) return;
      const entryAvg = entryCost / entryQty;
      const exitAvg = exitProceeds / exitQty;
      const isLong = direction === 'long';
      const pnl = isLong
        ? exitProceeds - exitQty * entryAvg
        : exitQty * entryAvg - exitProceeds;
      trips.push({
        ticker,
        direction,
        qty: exitQty,
        entryAvgPrice: round4(entryAvg),
        exitAvgPrice: round4(exitAvg),
        openedAt,
        closedAt,
        returnPct: round4(((isLong ? exitAvg - entryAvg : entryAvg - exitAvg) / entryAvg) * 100),
        realizedPnlUsd: round2(pnl),
      });
    };

    for (const f of list) {
      const signed = f.side === 'buy' ? f.qty : -f.qty;
      if (pos === 0) {
        open(signed, f);
        pos = signed;
        continue;
      }
      const sameDir = pos > 0 === signed > 0;
      if (sameDir) {
        entryQty += f.qty;
        entryCost += f.qty * f.price;
        pos += signed;
        continue;
      }
      const closing = Math.min(Math.abs(signed), Math.abs(pos));
      exitQty += closing;
      exitProceeds += closing * f.price;
      pos += signed;
      if (pos === 0) {
        close(f.transactionTime);
        entryQty = 0;
        entryCost = 0;
        exitQty = 0;
        exitProceeds = 0;
      } else if (pos > 0 !== (direction === 'long')) {
        // flipped through flat: close the old trip, open the remainder fresh
        close(f.transactionTime);
        open(pos, f);
      }
    }
  }
  trips.sort((a, b) => a.closedAt.localeCompare(b.closedAt));
  return trips;
}

/**
 * Monotone calibration fit via pool-adjacent-violators (isotonic regression)
 * on (conviction score, win) samples. Output is a sorted, monotone
 * piecewise-linear table consumable by applyCalibration. Empty in -> empty out
 * (identity map downstream).
 */
export function fitCalibration(samples: { score: number; win: boolean }[]): CalibrationPoint[] {
  if (samples.length === 0) return [];
  const sorted = [...samples].sort((a, b) => a.score - b.score);
  interface Pool {
    sumScore: number;
    wins: number;
    n: number;
  }
  const pools: Pool[] = [];
  for (const s of sorted) {
    pools.push({ sumScore: s.score, wins: s.win ? 1 : 0, n: 1 });
    // merge backward while the mean win-rate decreases (violates monotonicity)
    while (pools.length >= 2) {
      const a = pools[pools.length - 2]!;
      const b = pools[pools.length - 1]!;
      if (a.wins / a.n <= b.wins / b.n) break;
      pools.splice(pools.length - 2, 2, {
        sumScore: a.sumScore + b.sumScore,
        wins: a.wins + b.wins,
        n: a.n + b.n,
      });
    }
  }
  return pools.map((p) => ({ score: round4(p.sumScore / p.n), prob: round4(p.wins / p.n) }));
}

export interface AnalystStat {
  /** Directional verdicts scored (abstentions excluded). */
  n: number;
  hits: number;
  hitRate: number;
}

/**
 * Per-analyst directional hit rate over closed trips. A verdict aligned with
 * the trip's direction scores a hit when the trip won; a contrary verdict
 * scores a hit when the trip lost (the bear being right IS a hit). 'none'
 * verdicts are excluded — abstention is not a directional claim.
 */
export function analystStats(
  joined: { trip: RoundTrip; verdicts: Verdict[] }[],
): Record<AnalystName, AnalystStat> {
  const out = {} as Record<AnalystName, AnalystStat>;
  for (const a of ANALYSTS) out[a] = { n: 0, hits: 0, hitRate: 0 };
  for (const { trip, verdicts } of joined) {
    const win = trip.returnPct > 0;
    for (const v of verdicts) {
      if (v.direction !== 'long' && v.direction !== 'short') continue;
      const aligned = v.direction === trip.direction;
      const stat = out[v.analyst];
      stat.n += 1;
      if (aligned === win) stat.hits += 1;
    }
  }
  for (const a of ANALYSTS) {
    const s = out[a];
    s.hitRate = s.n > 0 ? round4(s.hits / s.n) : 0;
  }
  return out;
}

// ---- exit-trigger attribution + judge-veto scoring (pure) ------------------

/** One kind:'exit' audit record, pre-parsed by the caller. */
export interface ExitEvent {
  tsMs: number;
  ticker: string;
  trigger?: string;
}

/**
 * Attribute each closed trip to the exit trigger that caused it: the nearest
 * exit audit event for the same ticker in [closedAt - 90min, closedAt + 5min]
 * (the audit precedes the fill; GTC stop fills the executor never saw have no
 * event and attribute to 'native_stop_fill'). Pure.
 */
export function attributeExitTriggers(trips: RoundTrip[], events: ExitEvent[]): string[] {
  const byTicker = new Map<string, ExitEvent[]>();
  for (const e of events) {
    const key = e.ticker.toUpperCase();
    byTicker.set(key, [...(byTicker.get(key) ?? []), e]);
  }
  return trips.map((trip) => {
    const closedMs = new Date(trip.closedAt).getTime();
    const candidates = (byTicker.get(trip.ticker.toUpperCase()) ?? []).filter(
      (e) => e.tsMs >= closedMs - 90 * 60_000 && e.tsMs <= closedMs + 5 * 60_000,
    );
    if (candidates.length === 0) return 'native_stop_fill';
    candidates.sort((a, b) => Math.abs(a.tsMs - closedMs) - Math.abs(b.tsMs - closedMs));
    return candidates[0]!.trigger ?? 'unknown';
  });
}

/**
 * Direction-aware post-exit follow-through: % move from the exit VWAP to each
 * subsequent daily close, signed so POSITIVE = the position kept moving the
 * trade's way after we exited (money left on the table) and negative = the
 * exit dodged further loss. `closesAfterExit` is oldest-first, daily closes
 * strictly after the exit date. Pure.
 */
export function postExitFollowthrough(
  trip: Pick<RoundTrip, 'direction' | 'exitAvgPrice'>,
  closesAfterExit: number[],
): { d1?: number; d3?: number } {
  const sign = trip.direction === 'long' ? 1 : -1;
  const pct = (close: number | undefined): number | undefined =>
    close !== undefined && close > 0 && trip.exitAvgPrice > 0
      ? round4((sign * (close - trip.exitAvgPrice)) / trip.exitAvgPrice * 100)
      : undefined;
  const d1 = pct(closesAfterExit[0]);
  const d3 = pct(closesAfterExit[2]);
  return { ...(d1 !== undefined ? { d1 } : {}), ...(d3 !== undefined ? { d3 } : {}) };
}

/** A judge-declined entry, pre-parsed from the audit log by the caller. */
export interface JudgeVeto {
  ticker: string;
  ymd: string; // ET date of the decline
  direction: 'long' | 'short';
}

/**
 * Score a judge veto against what the trade would have done: direction-aware
 * % return from the decline date's close (entry proxy) to +1 and +3 trading
 * days. POSITIVE forgone = the vetoed trade would have won (the veto cost
 * money); negative = the veto saved money. `dailyCloses` is [{ymd, c}]
 * oldest-first for the ticker. Pure.
 */
export function scoreJudgeVeto(
  veto: JudgeVeto,
  dailyCloses: { ymd: string; c: number }[],
): { forgone1d?: number; forgone3d?: number } {
  const idx = dailyCloses.findIndex((b) => b.ymd >= veto.ymd);
  if (idx < 0) return {};
  const entry = dailyCloses[idx]!.c;
  if (!(entry > 0)) return {};
  const sign = veto.direction === 'long' ? 1 : -1;
  const at = (offset: number): number | undefined => {
    const close = dailyCloses[idx + offset]?.c;
    return close !== undefined && close > 0
      ? round4((sign * (close - entry)) / entry * 100)
      : undefined;
  };
  const forgone1d = at(1);
  const forgone3d = at(3);
  return {
    ...(forgone1d !== undefined ? { forgone1d } : {}),
    ...(forgone3d !== undefined ? { forgone3d } : {}),
  };
}

// ---- implementation shortfall (pure) ---------------------------------------

/** One kind:'proposed_order' audit record carrying a decision-time mid. */
export interface DecisionRecord {
  tsMs: number;
  ticker: string;
  side: 'buy' | 'sell';
  intent: string;
  session?: string;
  decisionMid: number;
}

/**
 * Direction-aware implementation shortfall of a fill against the decision-time
 * mid, in basis points. POSITIVE = the fill cost money relative to the mid the
 * executor saw when it decided (buy above mid / sell below mid); negative =
 * price improvement. undefined when either price is unusable. Pure.
 */
export function shortfallBps(
  side: 'buy' | 'sell',
  decisionMid: number,
  fillPrice: number,
): number | undefined {
  if (!(decisionMid > 0) || !(fillPrice > 0)) return undefined;
  const signed = side === 'buy' ? fillPrice - decisionMid : decisionMid - fillPrice;
  return round2((signed / decisionMid) * 10_000);
}

/**
 * The decision a fill executes: the LATEST same-ticker, same-side
 * proposed_order at or before the fill (60s forward tolerance for clock skew)
 * and no older than maxAgeMs — resting passive orders can fill hours after
 * the decision. Re-proposals (e.g. a passive exit escalating) naturally win
 * by recency. undefined when nothing matches. Pure.
 */
export function nearestDecision(
  fill: { tsMs: number; ticker: string; side: 'buy' | 'sell' },
  decisions: DecisionRecord[],
  maxAgeMs = 8 * 3_600_000,
): DecisionRecord | undefined {
  let best: DecisionRecord | undefined;
  for (const d of decisions) {
    if (d.ticker !== fill.ticker || d.side !== fill.side) continue;
    if (d.tsMs > fill.tsMs + 60_000) continue;
    if (fill.tsMs - d.tsMs > maxAgeMs) continue;
    if (!best || d.tsMs > best.tsMs) best = d;
  }
  return best;
}

/**
 * Weight PROPOSAL from hit rates: 50% hit rate keeps the current weight, and
 * the adjustment is clamped to [0.5x, 1.5x] so one lucky streak cannot swing
 * the panel. Analysts below `minPerAnalyst` scored verdicts keep their
 * current weight untouched. Never applied automatically.
 */
export function proposeWeights(
  stats: Record<AnalystName, AnalystStat>,
  current: Record<AnalystName, number>,
  minPerAnalyst = 10,
): Record<AnalystName, number> {
  const out = {} as Record<AnalystName, number>;
  for (const a of ANALYSTS) {
    const s = stats[a];
    if (!s || s.n < minPerAnalyst) {
      out[a] = current[a];
      continue;
    }
    const adj = Math.min(1.5, Math.max(0.5, 2 * s.hitRate));
    out[a] = round2(current[a] * adj);
  }
  return out;
}
