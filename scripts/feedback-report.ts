// Feedback report: broker fill history -> closed round trips -> conviction
// calibration fit + per-analyst hit rates + weight proposal. Run ad hoc or on
// a schedule:
//
//   pnpm feedback                 # last 60 days
//   pnpm feedback --since=2026-07-01
//
// Writes out/feedback-<ymd>.json and prints a summary. REPORT ONLY: nothing is
// applied to config.yaml. The calibration table / weight proposal become
// actionable only once closedTrades >= calibration.min_trades (the same >=50
// OOS governance gate the P1-P3 signals sit behind); until then this is
// measurement of an accumulating sample, not control.
import 'dotenv/config';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { nowET } from '../src/clock.js';
import { AlpacaBroker } from '../src/broker/client.js';
import { AlpacaMarketData } from '../src/broker/marketdata.js';
import { OUT_DIR, readJsonIfExists, thesisPath, verdictsPath, writeJsonAtomic } from '../src/paths.js';
import { readAuditEvents } from '../src/audit-read.js';
import {
  analystStats,
  attributeExitTriggers,
  fitCalibration,
  pairRoundTrips,
  postExitFollowthrough,
  proposeWeights,
  scoreJudgeVeto,
  type ExitEvent,
  type JudgeVeto,
  type RoundTrip,
} from '../src/feedback.js';
import type { Thesis, ThesisKind, Verdict, VerdictFile } from '../src/types.js';

const DAY_MS = 86_400_000;

/** Tolerant date-keyed JSON read: corrupt or missing history -> null. */
function readQuiet<T>(file: string): T | null {
  try {
    return readJsonIfExists<T>(file);
  } catch {
    return null;
  }
}

/**
 * The thesis entry a trip was opened under: same ticker AND direction, from
 * the newest thesis file (either kind) dated at or up to 3 days before the
 * opening fill (an evening thesis is dated the day before its premarket fill).
 */
function joinThesis(trip: RoundTrip): { conviction?: number; thesisDate?: string; verdicts: Verdict[] } {
  const openedMs = new Date(trip.openedAt).getTime();
  for (let back = 0; back <= 3; back++) {
    const ymd = nowET(new Date(openedMs - back * DAY_MS)).ymd;
    for (const kind of ['rth', 'offhours'] as ThesisKind[]) {
      const thesis = readQuiet<Thesis>(thesisPath(ymd, kind));
      const entry = thesis?.entries.find(
        (e) => e.ticker.toUpperCase() === trip.ticker && e.direction === trip.direction,
      );
      if (!entry) continue;
      const verdictFile = readQuiet<VerdictFile>(verdictsPath(ymd));
      return {
        conviction: entry.weightedConviction,
        thesisDate: ymd,
        verdicts: verdictFile?.verdicts.filter((v) => v.ticker.toUpperCase() === trip.ticker) ?? [],
      };
    }
  }
  return { verdicts: [] };
}

export async function main(): Promise<void> {
  const cfg = loadConfig();
  const sinceArg = process.argv.find((a) => a.startsWith('--since='))?.slice('--since='.length);
  if (sinceArg && !/^\d{4}-\d{2}-\d{2}$/.test(sinceArg)) {
    throw new Error(`--since must be YYYY-MM-DD, got: ${sinceArg}`);
  }
  const since = sinceArg
    ? new Date(`${sinceArg}T00:00:00Z`)
    : new Date(Date.now() - 60 * DAY_MS);

  const broker = new AlpacaBroker(cfg);
  const fills = await broker.getFills(since.toISOString());
  const trips = pairRoundTrips(fills);

  // ---- exit-trigger attribution + judge-veto scoring (Tier-1 measurement) --
  const sinceYmd = since.toISOString().slice(0, 10);
  const audits = readAuditEvents(sinceYmd);
  const exitEvents: ExitEvent[] = audits
    .filter((a) => a.kind === 'exit' && typeof a.data.ticker === 'string')
    .map((a) => ({
      tsMs: Date.parse(a.ts),
      ticker: String(a.data.ticker),
      ...(typeof a.data.trigger === 'string' ? { trigger: a.data.trigger } : {}),
    }));
  const triggers = attributeExitTriggers(trips, exitEvents);

  const vetoesRaw = audits.filter(
    (a) =>
      a.kind === 'tick' &&
      a.data.stage === 'skip' &&
      typeof a.data.ticker === 'string' &&
      typeof a.data.reason === 'string' &&
      (a.data.reason as string).startsWith('judge declined'),
  );
  const vetoes: JudgeVeto[] = [];
  for (const v of vetoesRaw) {
    const ticker = String(v.data.ticker).toUpperCase();
    const ymd = nowET(new Date(v.ts)).ymd;
    // Direction from the thesis the executor was trading that day.
    let direction: 'long' | 'short' | undefined;
    for (const kind of ['rth', 'offhours'] as ThesisKind[]) {
      const t = readQuiet<Thesis>(thesisPath(ymd, kind));
      const entry = t?.entries.find((e) => e.ticker.toUpperCase() === ticker);
      if (entry) {
        direction = entry.direction;
        break;
      }
    }
    if (direction) vetoes.push({ ticker, ymd, direction });
  }

  // Daily closes for follow-through and veto scoring (fail-soft: no bars ->
  // those fields stay absent from the report).
  const barTickers = [
    ...new Set([...trips.map((t) => t.ticker), ...vetoes.map((v) => v.ticker)]),
  ];
  let closesByTicker = new Map<string, { ymd: string; c: number }[]>();
  if (barTickers.length > 0) {
    try {
      const md = new AlpacaMarketData(process.env, globalThis.fetch, undefined, cfg.data_feed);
      const bars = await md.getDailyBars(barTickers, 40);
      closesByTicker = new Map(
        [...bars].map(([sym, list]) => [
          sym.toUpperCase(),
          list.map((b) => ({ ymd: b.t.slice(0, 10), c: b.c })),
        ]),
      );
    } catch (err) {
      console.error(`bars fetch failed (follow-through omitted): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const followthroughs = trips.map((trip) => {
    const closedYmd = nowET(new Date(trip.closedAt)).ymd;
    const closesAfter = (closesByTicker.get(trip.ticker.toUpperCase()) ?? [])
      .filter((b) => b.ymd > closedYmd)
      .map((b) => b.c);
    return postExitFollowthrough(trip, closesAfter);
  });
  const byTrigger: Record<
    string,
    { n: number; avgReturnPct: number; avgPostExit1dPct?: number; avgPostExit3dPct?: number }
  > = {};
  trips.forEach((trip, i) => {
    const key = triggers[i]!;
    const bucket = (byTrigger[key] ??= { n: 0, avgReturnPct: 0 });
    bucket.n += 1;
    bucket.avgReturnPct += trip.returnPct;
  });
  for (const [key, bucket] of Object.entries(byTrigger)) {
    bucket.avgReturnPct = Math.round((bucket.avgReturnPct / bucket.n) * 10_000) / 10_000;
    const d1s = trips
      .map((_, i) => (triggers[i] === key ? followthroughs[i]!.d1 : undefined))
      .filter((x): x is number => x !== undefined);
    const d3s = trips
      .map((_, i) => (triggers[i] === key ? followthroughs[i]!.d3 : undefined))
      .filter((x): x is number => x !== undefined);
    if (d1s.length > 0)
      bucket.avgPostExit1dPct = Math.round((d1s.reduce((s, x) => s + x, 0) / d1s.length) * 10_000) / 10_000;
    if (d3s.length > 0)
      bucket.avgPostExit3dPct = Math.round((d3s.reduce((s, x) => s + x, 0) / d3s.length) * 10_000) / 10_000;
  }

  const vetoScores = vetoes.map((v) =>
    scoreJudgeVeto(v, closesByTicker.get(v.ticker.toUpperCase()) ?? []),
  );
  const scored1 = vetoScores.map((s) => s.forgone1d).filter((x): x is number => x !== undefined);
  const scored3 = vetoScores.map((s) => s.forgone3d).filter((x): x is number => x !== undefined);
  const judgeVetoSummary = {
    n: vetoes.length,
    scored: scored1.length,
    avgForgone1dPct:
      scored1.length > 0
        ? Math.round((scored1.reduce((s, x) => s + x, 0) / scored1.length) * 10_000) / 10_000
        : null,
    avgForgone3dPct:
      scored3.length > 0
        ? Math.round((scored3.reduce((s, x) => s + x, 0) / scored3.length) * 10_000) / 10_000
        : null,
    note: 'positive forgone = the vetoed trade would have WON (the veto cost money); persistent ~zero means the judge adds no value and is a removal candidate',
  };

  const joined = trips.map((trip) => ({ trip, ...joinThesis(trip) }));
  const scored = joined.filter((j) => j.conviction !== undefined);
  const samples = scored.map((j) => ({ score: j.conviction!, win: j.trip.returnPct > 0 }));
  const table = fitCalibration(samples);
  const stats = analystStats(joined.map((j) => ({ trip: j.trip, verdicts: j.verdicts })));
  const proposed = proposeWeights(stats, cfg.agent_weights);

  const wins = trips.filter((t) => t.returnPct > 0).length;
  const avgReturnPct =
    trips.length > 0 ? trips.reduce((s, t) => s + t.returnPct, 0) / trips.length : 0;
  const totalPnlUsd = trips.reduce((s, t) => s + t.realizedPnlUsd, 0);
  const eligible = trips.length >= cfg.calibration.min_trades;

  const report = {
    generatedAt: new Date().toISOString(),
    since: since.toISOString(),
    fills: fills.length,
    closedTrades: trips.length,
    joinedToThesis: scored.length,
    winRate: trips.length > 0 ? Math.round((wins / trips.length) * 10_000) / 10_000 : 0,
    avgReturnPct: Math.round(avgReturnPct * 10_000) / 10_000,
    totalPnlUsd: Math.round(totalPnlUsd * 100) / 100,
    calibration: {
      table,
      eligible,
      min_trades: cfg.calibration.min_trades,
      note: 'apply by setting calibration.enabled + calibration.table in config.yaml — ONLY once eligible',
    },
    analysts: stats,
    proposedWeights: {
      current: cfg.agent_weights,
      proposed,
      eligible,
      note: 'apply by editing agent_weights in config.yaml — ONLY once eligible; sub-10-verdict analysts keep current weight',
    },
    exitTriggers: {
      byTrigger,
      note: 'avgPostExit1d/3dPct signed so POSITIVE = position kept moving our way after exit (money left on table); trail/time_stop rows with big positives mean exits fire too early',
    },
    judgeVetoes: judgeVetoSummary,
    trips: trips.map((t, i) => ({ ...t, trigger: triggers[i], postExit: followthroughs[i] })),
    governance:
      'REPORT ONLY. Nothing is auto-applied. Governance gate: calibration.min_trades OOS closed trades before any table/weight change ships.',
  };

  const outFile = path.join(OUT_DIR, `feedback-${nowET().ymd}.json`);
  writeJsonAtomic(outFile, report);

  console.log(`feedback: ${trips.length} closed trades since ${since.toISOString().slice(0, 10)} (${fills.length} fills)`);
  console.log(`  win rate ${(report.winRate * 100).toFixed(1)}%  avg return ${report.avgReturnPct.toFixed(2)}%  pnl $${report.totalPnlUsd.toFixed(2)}`);
  console.log(`  calibration points: ${table.length}  eligible to apply: ${eligible} (${trips.length}/${cfg.calibration.min_trades})`);
  for (const [analyst, s] of Object.entries(stats)) {
    console.log(`  ${analyst.padEnd(11)} n=${String(s.n).padStart(3)} hitRate=${(s.hitRate * 100).toFixed(1)}%  weight ${cfg.agent_weights[analyst as keyof typeof cfg.agent_weights]} -> proposed ${proposed[analyst as keyof typeof proposed]}`);
  }
  for (const [trigger, b] of Object.entries(byTrigger)) {
    console.log(
      `  exit ${trigger.padEnd(16)} n=${String(b.n).padStart(3)} avgRet=${b.avgReturnPct.toFixed(2)}%  postExit d1=${b.avgPostExit1dPct?.toFixed(2) ?? 'n/a'}% d3=${b.avgPostExit3dPct?.toFixed(2) ?? 'n/a'}%`,
    );
  }
  console.log(
    `  judge vetoes: n=${judgeVetoSummary.n} scored=${judgeVetoSummary.scored} avgForgone d1=${judgeVetoSummary.avgForgone1dPct ?? 'n/a'}% d3=${judgeVetoSummary.avgForgone3dPct ?? 'n/a'}%`,
  );
  console.log(`  report: ${outFile}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`feedback report failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
