// Backtest data downloader. Idempotent and resumable: rerun any subcommand
// safely; existing files are skipped.
// Usage: tsx scripts/backtest-fetch.ts <probe|universe|calendar|daily|news|actions|benchmarks|all>
import 'dotenv/config';
import {
  fetchActions,
  fetchCalendar,
  fetchDailyBars,
  fetchNewsDay,
  fetchUniverse,
  probeFeeds,
  RateLimiter,
  WINDOW,
} from '../src/backtest/data.js';

const log = (msg: string) => console.log(`[fetch ${new Date().toISOString().slice(11, 19)}] ${msg}`);
const ctx = { log, limiter: new RateLimiter(180) };

async function daily(feed: 'sip' | 'iex'): Promise<void> {
  const universe = await fetchUniverse(ctx);
  const symbols = universe.map((a) => a.symbol);
  log(`daily bars for ${symbols.length} symbols, feed=${feed}`);
  await fetchDailyBars(symbols, feed, ctx);
  log(`daily bars ${feed} done`);
}

async function news(): Promise<void> {
  const cal = await fetchCalendar(ctx);
  // include the calendar day before each trading day (news slice reaches back to D-1 17:00)
  const days = new Set<string>();
  for (const d of cal) {
    days.add(d.date);
    const prev = new Date(`${d.date}T12:00:00Z`);
    prev.setUTCDate(prev.getUTCDate() - 1);
    days.add(prev.toISOString().slice(0, 10));
  }
  const sorted = [...days].sort();
  let i = 0;
  for (const day of sorted) {
    await fetchNewsDay(day, ctx);
    i++;
    if (i % 20 === 0) log(`news ${i}/${sorted.length} days`);
  }
  log(`news done (${sorted.length} days)`);
}

async function benchmarks(): Promise<void> {
  await fetchDailyBars(['SPY', 'QQQ'], 'sip', ctx);
  log('benchmarks done');
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'all';
  if (cmd === 'probe' || cmd === 'all') {
    const probe = await probeFeeds(ctx);
    for (const c of probe.counts) log(`probe ${c.symbol} ${c.session}: sip=${c.sip} iex=${c.iex}`);
    if (!probe.pass) {
      console.error('FEED PROBE FAILED: SIP extended-hours minute bars unavailable — backtest cannot run');
      process.exit(2);
    }
    log('feed probe PASS');
    if (cmd === 'probe') return;
  }
  if (cmd === 'universe' || cmd === 'all') await fetchUniverse(ctx);
  if (cmd === 'calendar' || cmd === 'all') {
    const cal = await fetchCalendar(ctx);
    log(`calendar: ${cal.length} trading days ${WINDOW.start}..${WINDOW.end}`);
  }
  if (cmd === 'daily' || cmd === 'all') await daily('sip');
  if (cmd === 'daily-iex' || cmd === 'all') await daily('iex');
  if (cmd === 'news' || cmd === 'all') await news();
  if (cmd === 'actions' || cmd === 'all') {
    const a = await fetchActions(ctx);
    log(`corporate actions: ${a.length} splits in window`);
  }
  if (cmd === 'benchmarks' || cmd === 'all') await benchmarks();
  log('done');
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
