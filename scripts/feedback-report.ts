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
import { OUT_DIR, readJsonIfExists, thesisPath, verdictsPath, writeJsonAtomic } from '../src/paths.js';
import { analystStats, fitCalibration, pairRoundTrips, proposeWeights, type RoundTrip } from '../src/feedback.js';
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
    trips,
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
  console.log(`  report: ${outFile}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`feedback report failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
