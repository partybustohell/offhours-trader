// Pre-flight readiness check. Run before scheduling or any live session.
// Verifies keys, mode gating, broker reachability, feed-vs-session coverage,
// thesis freshness, and halt state. Prints a go/no-go report and exits
// non-zero if any BLOCKER is present. Places no orders, changes nothing.
import 'dotenv/config';
import { loadConfig, assertModeRunnable } from '../src/config.js';
import { currentSession, nowET } from '../src/clock.js';
import { readHaltState } from '../src/state.js';
import { thesisPath, readJsonIfExists } from '../src/paths.js';
import { AlpacaBroker } from '../src/broker/client.js';
import {
  alphaTrialCount,
  loadTrialRegistry,
  unregisteredEnabledAlphaFlags,
} from '../src/trial-registry.js';
import type { Thesis } from '../src/types.js';

type Level = 'ok' | 'warn' | 'blocker';
const lines: { level: Level; msg: string }[] = [];
const ok = (msg: string) => lines.push({ level: 'ok', msg });
const warn = (msg: string) => lines.push({ level: 'warn', msg });
const blocker = (msg: string) => lines.push({ level: 'blocker', msg });

async function main(): Promise<void> {
  const { ymd, hm } = nowET();
  console.log(`Pre-flight — ${ymd} ${hm} ET\n`);

  let cfg;
  try {
    cfg = loadConfig();
    ok(`config.yaml parsed; mode=${cfg.mode}`);
  } catch (err) {
    blocker(`config.yaml invalid: ${err instanceof Error ? err.message : String(err)}`);
    return report();
  }

  // Credentials + mode gating
  if (!process.env.ANTHROPIC_API_KEY) blocker('ANTHROPIC_API_KEY missing (pipeline/executor cannot call the analysts)');
  else ok('ANTHROPIC_API_KEY present');

  try {
    assertModeRunnable(cfg, process.env);
    ok(`mode ${cfg.mode} is runnable (credentials + acknowledgment satisfied)`);
  } catch (err) {
    blocker(err instanceof Error ? err.message : String(err));
  }
  if (cfg.mode === 'live') warn('mode is LIVE — real money. Confirm this is intended.');
  if (cfg.mode === 'dry-run') ok('mode dry-run: orders are logged, never sent (safe)');

  // Trial-registry gate: an ENABLED alpha signal must be pre-registered, so
  // multiple-testing discipline is enforced, not just documented.
  try {
    const trials = loadTrialRegistry();
    const unreg = unregisteredEnabledAlphaFlags(cfg, trials);
    if (unreg.length > 0) {
      blocker(
        `enabled alpha signal(s) not pre-registered in trial-registry.yaml: ${unreg.join(', ')} — add a type:alpha row BEFORE enabling (docs/QUANT-TESTING-PLAN.md)`,
      );
    } else {
      ok(`trial registry: nTrials=${alphaTrialCount(trials)} (summed alpha cells); no unregistered enabled signals`);
    }
  } catch (err) {
    blocker(`trial-registry.yaml invalid: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Broker reachability
  try {
    const broker = new AlpacaBroker(cfg);
    const acct = await broker.getAccount();
    ok(`broker reachable; equity=$${acct.equity.toLocaleString('en-US')}, positions=${acct.positions.length}`);
  } catch (err) {
    blocker(`broker unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Feed vs enabled sessions — the load-bearing "real market" check.
  // IEX trades 08:00-17:00 ET; enabled sessions are 04:00-09:30 / 16:00-20:00.
  if (cfg.data_feed === 'iex') {
    const blind: string[] = [];
    if (cfg.sessions.premarket) blind.push('pre-market 04:00-08:00');
    if (cfg.sessions.afterhours) blind.push('after-hours 17:00-20:00');
    if (blind.length > 0) {
      warn(
        `data_feed=iex is BLIND during ${blind.join(' and ')} — the staleness guard will make the executor abstain there. ` +
          'Real extended-hours trading requires data_feed=sip (paid real-time subscription).',
      );
    }
    if (cfg.sessions.regularhours) {
      ok('data_feed=iex FULLY covers the regular session 09:30-16:00 — RTH trades on the free feed, no SIP needed');
    } else if (blind.length === 0) {
      warn('data_feed=iex but no session it can see is enabled — nothing will trade');
    }
  } else {
    ok('data_feed=sip: consolidated real-time book available across all enabled sessions');
  }
  ok(`staleness guard: max_quote_age_sec=${cfg.max_quote_age_sec}`);

  // Halt state
  const halt = readHaltState();
  if (halt.halted) blocker(`system is HALTED (${halt.reason}, at ${halt.at}) — resume before running (POST /api/resume)`);
  else ok('not halted');

  // Thesis freshness
  const todayThesis = readJsonIfExists<Thesis>(thesisPath(ymd));
  if (!todayThesis) {
    warn(`no thesis for ${ymd} yet — run "pnpm pipeline" after the close to generate one`);
  } else {
    const expired = new Date(todayThesis.expiresAt).getTime() <= Date.now();
    if (expired) warn(`thesis for ${ymd} has expired (${todayThesis.expiresAt}) — regenerate with "pnpm pipeline"`);
    else ok(`thesis for ${ymd}: ${todayThesis.entries.length} entries, expires ${todayThesis.expiresAt}`);
  }

  // Session context (informational)
  ok(`current session: ${currentSession()}`);

  report();
}

function report(): void {
  const icon = { ok: '  ok  ', warn: ' warn ', blocker: 'BLOCK ' } as const;
  for (const l of lines) console.log(`[${icon[l.level]}] ${l.msg}`);
  const blockers = lines.filter((l) => l.level === 'blocker').length;
  const warns = lines.filter((l) => l.level === 'warn').length;
  console.log('');
  if (blockers > 0) {
    console.log(`NOT READY — ${blockers} blocker(s), ${warns} warning(s).`);
    process.exit(1);
  }
  console.log(`READY — 0 blockers, ${warns} warning(s). Review warnings before scheduling.`);
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
