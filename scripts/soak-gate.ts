// The soak gate: mechanical evaluation of the pre-registered decision rules
// against accumulated evidence. Run AFTER `pnpm feedback` (it consumes the
// newest out/feedback-*.json plus the audit shadow records):
//
//   pnpm feedback && pnpm gate
//
// Prints one verdict per rule and, on ENABLE/REMOVE, the exact config patch
// and registry-row template to paste. IT NEVER EDITS ANYTHING — the operator
// applies, the registry records, preflight enforces. Rules and thresholds:
// trial-registry.yaml rows soak-reset-2026-07-27 (the rules) and
// soak-gate-concretization-2026-07-27 (the exact tests implemented here).
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { nowET } from '../src/clock.js';
import { OUT_DIR, readJsonIfExists, writeJsonAtomic } from '../src/paths.js';
import { loadTrialRegistry } from '../src/trial-registry.js';
import { readAuditEvents } from '../src/audit-read.js';
import {
  bucketTrades,
  calibrationCadence,
  judgeRemovalVerdict,
  signalGateVerdict,
  type TripForGate,
} from '../src/soak-gate.js';

const DAY_MS = 86_400_000;

interface FeedbackReport {
  generatedAt?: string;
  closedTrades?: number;
  calibration?: { table?: unknown[]; min_trades?: number };
  judgeVetoes?: { n?: number; scored?: number; avgForgone1dPct?: number | null };
  proposedWeights?: { proposed?: Record<string, number> };
  trips?: { ticker?: string; openedAt?: string; returnPct?: number }[];
}

function newestFeedbackReport(): { file: string; report: FeedbackReport } | null {
  let files: string[];
  try {
    files = fs.readdirSync(OUT_DIR);
  } catch {
    return null;
  }
  const candidates = files.filter((f) => /^feedback-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const file = candidates[candidates.length - 1];
  if (!file) return null;
  try {
    const report = readJsonIfExists<FeedbackReport>(path.join(OUT_DIR, file));
    return report ? { file, report } : null;
  } catch {
    return null;
  }
}

export async function main(): Promise<void> {
  const cfg = loadConfig();
  const todayYmd = nowET().ymd;
  const trials = loadTrialRegistry();

  const soakRow = trials.find((t) => t.id === 'soak-reset-2026-07-27');
  const soakStartYmd = soakRow?.date ?? '2026-07-27';

  const fb = newestFeedbackReport();
  if (!fb) {
    console.log('gate: no out/feedback-*.json found — run `pnpm feedback` first.');
    process.exit(1);
  }

  // OOS window: trips OPENED on/after the soak reset only.
  const trips: TripForGate[] = (fb.report.trips ?? [])
    .filter(
      (t): t is { ticker: string; openedAt: string; returnPct: number } =>
        typeof t.ticker === 'string' && typeof t.openedAt === 'string' && typeof t.returnPct === 'number',
    )
    .filter((t) => nowET(new Date(t.openedAt)).ymd >= soakStartYmd);

  // Shadow indexes from the audit counterfactual records in the window.
  const audits = readAuditEvents(soakStartYmd).filter((a) => a.kind === 'counterfactual');
  const antiChaseByKey = new Map<string, boolean>();
  const hostileByYmd = new Map<string, boolean>();
  for (const a of audits) {
    const d = a.data as {
      note?: unknown;
      date?: unknown;
      ticker?: unknown;
      anti_chase?: { wouldFire?: unknown };
      regime?: { state?: unknown };
    };
    if (typeof d.date !== 'string') continue;
    if (typeof d.ticker === 'string' && typeof d.anti_chase?.wouldFire === 'boolean') {
      antiChaseByKey.set(`${d.ticker.toUpperCase()}|${d.date}`, d.anti_chase.wouldFire);
    }
    if (typeof d.regime?.state === 'string') {
      const hostile = d.regime.state.includes('hostile') || d.regime.state.includes('risk_off');
      // Any hostile reading that day marks the day hostile (early + main pass).
      hostileByYmd.set(d.date, (hostileByYmd.get(d.date) ?? false) || hostile);
    }
  }

  // A trade's thesis date is the fill's ET date or the evening before.
  const candidateYmds = (openedAtIso: string): string[] => {
    const openMs = new Date(openedAtIso).getTime();
    return [nowET(new Date(openMs)).ymd, nowET(new Date(openMs - DAY_MS)).ymd];
  };

  // Rule 2, first in the pre-committed enable order: regime.trend.
  const regimeBuckets = bucketTrades(trips, candidateYmds, (_ticker, ymds) => {
    for (const ymd of ymds) {
      const hostile = hostileByYmd.get(ymd);
      if (hostile !== undefined) return hostile;
    }
    return undefined;
  });
  const regimeVerdict = signalGateVerdict(regimeBuckets);

  // Second in order: anti_chase — HELD to WAIT until regime.trend is decided
  // (rule 2: one signal per window).
  const antiChaseBuckets = bucketTrades(trips, candidateYmds, (ticker, ymds) => {
    for (const ymd of ymds) {
      const fired = antiChaseByKey.get(`${ticker}|${ymd}`);
      if (fired !== undefined) return fired;
    }
    return undefined;
  });
  const antiChaseRaw = signalGateVerdict(antiChaseBuckets);
  const antiChaseVerdict =
    regimeVerdict.status === 'WAIT'
      ? { ...antiChaseRaw, status: 'WAIT' as const, detail: `held by enable order — regime.trend is undecided (its own reading: ${antiChaseRaw.status}: ${antiChaseRaw.detail})` }
      : antiChaseRaw;

  // Rule 4: calibration cadence. Last application = registry rows
  // (flag: calibration, status: applied), max date.
  const lastApplied = trials
    .filter((t) => t.flag === 'calibration' && t.status === 'applied' && typeof t.date === 'string')
    .map((t) => t.date as string)
    .sort()
    .pop() ?? null;
  const calib = calibrationCadence(
    lastApplied,
    todayYmd,
    trips.length,
    cfg.calibration.min_trades,
  );

  // Rule 5: judge removal.
  const judge = judgeRemovalVerdict(
    fb.report.judgeVetoes?.scored ?? 0,
    fb.report.judgeVetoes?.avgForgone1dPct ?? null,
  );

  const result = {
    generatedAt: new Date().toISOString(),
    soakStartYmd,
    feedbackReport: fb.file,
    oosClosedTrades: trips.length,
    shadowCoverage: { entryRecords: antiChaseByKey.size, bookDays: hostileByYmd.size },
    verdicts: {
      'regime.trend': regimeVerdict,
      'signals.anti_chase': antiChaseVerdict,
      calibration: calib,
      judge,
    },
    governance:
      'DECIDES ONLY — nothing is applied. ENABLE requires: (1) register the paired backtest cell, (2) flip the flag in config.yaml, (3) preflight passes against the registry. Rules: soak-reset-2026-07-27 / soak-gate-concretization-2026-07-27.',
  };
  const outFile = path.join(OUT_DIR, `gate-${todayYmd}.json`);
  writeJsonAtomic(outFile, result);

  console.log(`soak gate — window since ${soakStartYmd}, ${trips.length} OOS closed trades (report: ${fb.file})`);
  console.log(`  shadow coverage: ${antiChaseByKey.size} entry records, ${hostileByYmd.size} book-days`);
  console.log(`  [1] regime.trend      ${regimeVerdict.status}  ${regimeVerdict.detail}`);
  console.log(`  [2] signals.anti_chase ${antiChaseVerdict.status}  ${antiChaseVerdict.detail}`);
  console.log(`  [3] calibration       ${calib.eligible ? 'ELIGIBLE' : 'WAIT'}  ${calib.reason}`);
  console.log(`  [4] judge             ${judge.status}  ${judge.detail}`);

  if (regimeVerdict.status === 'ENABLE') {
    console.log('\n--- paste to config.yaml AFTER registering the paired backtest cell ---');
    console.log('regime:\n  trend:\n    enabled: true');
    console.log('--- and append to trial-registry.yaml (fill window/cells from the backtest) ---');
    console.log(
      `  - id: regime-trend-enable-${todayYmd}\n    date: "${todayYmd}"\n    flag: regime.trend\n    type: alpha\n    status: enabled\n    enabledDate: "${todayYmd}"\n    mechanism:\n      counterparty: >-\n        Longs bought into an index downtrend where breadth and follow-through\n        systematically disappoint relative to benign-regime entries.\n      whyTheyPay: >-\n        Trend persistence at the index level means hostile-regime longs face a\n        drifting headwind the entry price has not discounted, measured in this\n        book's own shadow log over the soak window.\n      friction: >-\n        The desk's own evidence is book-specific (its selection process, its\n        off-hours windows), so the aggregate anomaly's crowding does not\n        directly close the sizing edge on this flow.\n    notes: "Enabled per gate verdict gate-${todayYmd}.json under soak-reset-2026-07-27 rule 2; paired backtest cell registered separately."`,
    );
  }
  if (judge.status === 'REMOVE') {
    console.log('\n--- rule 5 pre-committed: remove the judge from the ENTRY path only ---');
    console.log('(exit-side judging keeps its invalidation role; implement as a config flag change reviewed against the registry)');
  }
  console.log(`\n  gate file: ${outFile}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`soak gate failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
