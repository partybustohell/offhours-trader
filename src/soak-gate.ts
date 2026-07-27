// Mechanical application of the pre-registered soak decision rules
// (trial-registry.yaml soak-reset-2026-07-27, concretized by
// soak-gate-concretization-2026-07-27) — pure functions, no IO.
// scripts/soak-gate.ts feeds them and renders verdicts + ready-to-paste
// patches. NOTHING here applies anything: the gate decides, the operator
// pastes, the registry records. These are SMALL-SAMPLE DECISION RULES fixed
// before any outcome data existed in the window — not significance claims.

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

export function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

export interface TripForGate {
  ticker: string;
  openedAt: string; // ISO
  returnPct: number;
}

/**
 * Split trips into flagged/unflagged by a shadow lookup. `lookup` answers
 * "did the shadow signal fire for this ticker on any of these thesis dates?"
 * (undefined = no shadow record found -> unmatched, excluded from both
 * buckets so missing coverage can never masquerade as evidence).
 */
export interface GateBuckets {
  flagged: number[];
  unflagged: number[];
  unmatched: number;
}

export function bucketTrades(
  trips: TripForGate[],
  candidateYmds: (openedAtIso: string) => string[],
  lookup: (ticker: string, ymds: string[]) => boolean | undefined,
): GateBuckets {
  const out: GateBuckets = { flagged: [], unflagged: [], unmatched: 0 };
  for (const trip of trips) {
    const fired = lookup(trip.ticker.toUpperCase(), candidateYmds(trip.openedAt));
    if (fired === undefined) out.unmatched += 1;
    else if (fired) out.flagged.push(trip.returnPct);
    else out.unflagged.push(trip.returnPct);
  }
  return out;
}

export type GateStatus = 'WAIT' | 'ENABLE' | 'KILL';

export interface GateVerdict {
  status: GateStatus;
  detail: string;
  flaggedN: number;
  unflaggedN: number;
  flaggedMeanPct: number;
  unflaggedMeanPct: number;
  unmatched: number;
}

/**
 * Rule 2 / rule 3 as concretized BEFORE window data existed:
 *   ENABLE — matched trades >= minTotal, both buckets >= minPerBucket, and
 *            the flagged bucket's mean trade return is LOWER than the
 *            unflagged bucket's (the signal's interventions would have
 *            downsized/blocked the worse trades).
 *   KILL   — same sample floors met but flagged mean is HIGHER (the signal
 *            would have cut the better trades).
 *   WAIT   — anything else (insufficient sample, or exactly equal means).
 */
export function signalGateVerdict(
  buckets: GateBuckets,
  minTotal = 50,
  minPerBucket = 10,
): GateVerdict {
  const flaggedN = buckets.flagged.length;
  const unflaggedN = buckets.unflagged.length;
  const total = flaggedN + unflaggedN;
  const flaggedMeanPct = round4(mean(buckets.flagged));
  const unflaggedMeanPct = round4(mean(buckets.unflagged));
  const base = { flaggedN, unflaggedN, flaggedMeanPct, unflaggedMeanPct, unmatched: buckets.unmatched };

  if (total < minTotal || flaggedN < minPerBucket || unflaggedN < minPerBucket) {
    return {
      ...base,
      status: 'WAIT',
      detail: `sample: ${total}/${minTotal} matched trades (flagged ${flaggedN}, unflagged ${unflaggedN}, need >=${minPerBucket} each; ${buckets.unmatched} unmatched excluded)`,
    };
  }
  if (flaggedMeanPct < unflaggedMeanPct) {
    return {
      ...base,
      status: 'ENABLE',
      detail: `flagged mean ${flaggedMeanPct}% < unflagged ${unflaggedMeanPct}% over ${total} trades — interventions would have helped; next step: register the paired backtest cell, then flip the flag`,
    };
  }
  if (flaggedMeanPct > unflaggedMeanPct) {
    return {
      ...base,
      status: 'KILL',
      detail: `flagged mean ${flaggedMeanPct}% > unflagged ${unflaggedMeanPct}% over ${total} trades — the signal would have cut the better trades; kill without a live trial (rule 3)`,
    };
  }
  return { ...base, status: 'WAIT', detail: 'bucket means exactly equal — no evidence either way' };
}

/**
 * Rule 4: calibration/weights apply at most every `cadenceDays` and only when
 * the OOS sample clears min_trades. `lastAppliedYmd` comes from registry rows
 * (flag: calibration, status: applied); null = never applied.
 */
export function calibrationCadence(
  lastAppliedYmd: string | null,
  todayYmd: string,
  closedTrades: number,
  minTrades: number,
  cadenceDays = 90,
): { eligible: boolean; reason: string; nextAllowedYmd?: string } {
  if (closedTrades < minTrades) {
    return { eligible: false, reason: `sample ${closedTrades}/${minTrades} OOS closed trades` };
  }
  if (lastAppliedYmd === null) {
    return { eligible: true, reason: `sample ${closedTrades}/${minTrades} met; never applied before` };
  }
  const last = new Date(`${lastAppliedYmd}T00:00:00Z`).getTime();
  const next = new Date(last + cadenceDays * 86_400_000).toISOString().slice(0, 10);
  if (todayYmd >= next) {
    return { eligible: true, reason: `sample met; last applied ${lastAppliedYmd}, cadence ${cadenceDays}d elapsed` };
  }
  return {
    eligible: false,
    reason: `cadence: last applied ${lastAppliedYmd}, next allowed ${next}`,
    nextAllowedYmd: next,
  };
}

/**
 * Rule 5 as registered: >= minScored scored vetoes and |avgForgone1d| <= 0.5%
 * -> the judge has no predictive value -> REMOVE (pre-committed). A strongly
 * NEGATIVE forgone (vetoed trades would have lost) -> KEEP. A strongly
 * POSITIVE forgone (the judge vetoes winners) exceeds what rule 5
 * pre-committed — surfaced as REVIEW: register a new decision before acting.
 */
export function judgeRemovalVerdict(
  scored: number,
  avgForgone1dPct: number | null,
  minScored = 30,
  band = 0.5,
): { status: 'WAIT' | 'REMOVE' | 'KEEP' | 'REVIEW'; detail: string } {
  if (scored < minScored || avgForgone1dPct === null) {
    return { status: 'WAIT', detail: `scored vetoes ${scored}/${minScored}` };
  }
  if (Math.abs(avgForgone1dPct) <= band) {
    return {
      status: 'REMOVE',
      detail: `avgForgone1d ${avgForgone1dPct}% within ±${band}% over ${scored} vetoes — no predictive value; rule 5 pre-commits removal from the entry path`,
    };
  }
  if (avgForgone1dPct < 0) {
    return {
      status: 'KEEP',
      detail: `avgForgone1d ${avgForgone1dPct}% — vetoed trades would have LOST; the judge is dodging losses`,
    };
  }
  return {
    status: 'REVIEW',
    detail: `avgForgone1d +${avgForgone1dPct}% — the judge vetoes WINNERS (worse than no value). Beyond rule 5's pre-commitment: register a removal decision before acting`,
  };
}
