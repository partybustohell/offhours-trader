// Ops watchdog: summarize the last N days of audit logs so silent starvation
// (the failure mode that wastes months of soak) is visible weekly. Read-only.
//
//   pnpm health              # last 7 days
//   pnpm health --days=14
//
// Writes out/health-<ymd>.json and prints a summary. Installed on the VPS as
// offhours-health.timer (weekly). Watch items, per the 2026-07-27 soak reset:
//   - trade rate vs the 3-5/week target (the sample-rate push's whole point)
//   - entry-skip histogram — 'insufficient quote size' spiking means the
//     gates_by_session 100-unit top-size gate is starving entries (Alpaca size
//     units caveat); 'judge declined' spiking means the judge is the bottleneck
//   - exits_only / no_thesis ticks — pipeline outages starve the sample
//   - trail_pending vs trail exits — debounce behavior
//   - judge cache hit rate — the cost/determinism win landing (or not)
import 'dotenv/config';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { nowET } from '../src/clock.js';
import { OUT_DIR, judgeStatsPath, readJsonIfExists, writeJsonAtomic } from '../src/paths.js';
import { readAuditEvents } from '../src/audit-read.js';

const DAY_MS = 86_400_000;

export async function main(): Promise<void> {
  const daysArg = process.argv.find((a) => a.startsWith('--days='))?.slice('--days='.length);
  const days = daysArg ? Math.max(1, Number(daysArg) || 7) : 7;
  const now = new Date();
  const sinceYmd = nowET(new Date(now.getTime() - days * DAY_MS)).ymd;
  const audits = readAuditEvents(sinceYmd);

  let entriesPlaced = 0;
  let exitsPlaced = 0;
  let rejected = 0;
  let ticks = 0;
  let exitsOnlyTicks = 0;
  let staleQuotesDropped = 0;
  let trailPending = 0;
  let ocoFallbacks = 0;
  let halts = 0;
  let errors = 0;
  let earningsWarnings = 0;
  let calendarDegraded = 0;
  const skipReasons: Record<string, number> = {};
  const exitTriggers: Record<string, number> = {};

  for (const a of audits) {
    const stage = a.data.stage;
    if (a.kind === 'halt') halts += 1;
    if (a.kind === 'error') {
      errors += 1;
      if (a.data.stage === 'oco_exit_fallback') ocoFallbacks += 1;
    }
    if (a.kind === 'exit' && typeof a.data.trigger === 'string') {
      exitTriggers[a.data.trigger as string] = (exitTriggers[a.data.trigger as string] ?? 0) + 1;
    }
    if (a.kind !== 'tick') continue;
    switch (stage) {
      case 'tick_summary': {
        ticks += 1;
        entriesPlaced += Number(a.data.entriesPlaced) || 0;
        exitsPlaced += Number(a.data.exitsPlaced) || 0;
        rejected += Number(a.data.rejected) || 0;
        break;
      }
      case 'no_thesis':
        if (a.data.action === 'exits_only') exitsOnlyTicks += 1;
        break;
      case 'stale_quotes':
        staleQuotesDropped += Number(a.data.dropped) || 0;
        break;
      case 'trail_pending':
        trailPending += 1;
        break;
      case 'earnings_warning':
        earningsWarnings += 1;
        break;
      case 'earnings_calendar_degraded':
        calendarDegraded += 1;
        break;
      case 'skip': {
        // Collapse per-name detail so the histogram groups by cause.
        const raw = String(a.data.reason ?? 'unknown');
        const reason = raw
          .replace(/^judge declined:.*/, 'judge declined')
          .replace(/^spread \d+ bps exceeds \d+ bps gate$/, 'spread gate')
          .replace(/^own-earnings guard:.*/, 'own-earnings guard')
          .replace(/^earnings \S+ within.*/, 'own-earnings guard');
        skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
        break;
      }
      default:
        break;
    }
  }

  const judgeStatsRaw = (() => {
    try {
      return readJsonIfExists<{ hits?: number; misses?: number }>(judgeStatsPath());
    } catch {
      return null;
    }
  })();
  const judgeHits = judgeStatsRaw?.hits ?? 0;
  const judgeMisses = judgeStatsRaw?.misses ?? 0;
  const judgeTotal = judgeHits + judgeMisses;

  const tradesPerWeek = Math.round(((exitsPlaced / days) * 7) * 100) / 100;
  const inTargetBand = tradesPerWeek >= 3 && tradesPerWeek <= 5;
  const flags: string[] = [];
  if (!inTargetBand)
    flags.push(
      `trade rate ${tradesPerWeek}/week outside the 3-5 target band — nudge conviction_threshold (0.50) by ±0.02 after ~2 weeks of data, not sooner`,
    );
  if ((skipReasons['insufficient quote size'] ?? 0) > entriesPlaced * 3 && entriesPlaced < 3)
    flags.push(
      "'insufficient quote size' dominating skips — gates_by_session min_top_size 100 may be in round-lot units; verify against a live quote",
    );
  if (exitsOnlyTicks > 0)
    flags.push(`${exitsOnlyTicks} exits_only ticks — pipeline produced no unexpired thesis; check pipeline timers/journal`);
  if (ocoFallbacks > 0) flags.push(`${ocoFallbacks} OCO exit fallbacks — check Alpaca rejection messages in audit errors`);
  if (halts > 0) flags.push(`${halts} halt event(s) in window`);

  const report = {
    generatedAt: now.toISOString(),
    windowDays: days,
    sinceYmd,
    ticks,
    entriesPlaced,
    exitsPlaced,
    tradesPerWeek,
    targetBand: '3-5/week',
    rejected,
    exitsOnlyTicks,
    staleQuotesDropped,
    trailPending,
    exitTriggers,
    skipReasons,
    earningsWarnings,
    calendarDegraded,
    ocoFallbacks,
    halts,
    errors,
    judgeCache: {
      hits: judgeHits,
      misses: judgeMisses,
      hitRate: judgeTotal > 0 ? Math.round((judgeHits / judgeTotal) * 10_000) / 10_000 : null,
    },
    flags,
  };

  const outFile = path.join(OUT_DIR, `health-${nowET(now).ymd}.json`);
  writeJsonAtomic(outFile, report);

  console.log(`health: last ${days}d — ${ticks} ticks, ${entriesPlaced} entries, ${exitsPlaced} exits (${tradesPerWeek}/week vs 3-5 target)`);
  console.log(`  rejected=${rejected} exitsOnlyTicks=${exitsOnlyTicks} staleQuotes=${staleQuotesDropped} trailPending=${trailPending} errors=${errors} halts=${halts}`);
  console.log(`  exit triggers: ${JSON.stringify(exitTriggers)}`);
  const topSkips = Object.entries(skipReasons).sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(`  top skips: ${topSkips.map(([r, n]) => `${r}=${n}`).join(', ') || 'none'}`);
  console.log(`  judge cache: ${judgeHits} hits / ${judgeMisses} misses${judgeTotal > 0 ? ` (${((judgeHits / judgeTotal) * 100).toFixed(0)}% hit rate)` : ''}`);
  for (const f of flags) console.log(`  FLAG: ${f}`);
  if (flags.length === 0) console.log('  no flags');
  console.log(`  report: ${outFile}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`health report failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
