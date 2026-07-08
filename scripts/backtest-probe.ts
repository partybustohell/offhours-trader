// T8 CLI — hindsight-leakage probe runner. Logic lives in src/backtest/probe.ts;
// this script only wires the real Anthropic client, config, and pair files.
//
// Usage:
//   tsx scripts/backtest-probe.ts controls [flags]
//       Run only the 3 hardcoded positive controls (schedule: from T+0:20).
//       Exits 3 if any control fails to trip (probe has no power).
//   tsx scripts/backtest-probe.ts arm1 <pairs.json> [flags]
//       Sampled candidate pairs + positive controls. Exits 3 if powerless.
//   tsx scripts/backtest-probe.ts arm2 <pairs.json> [flags]
//       Every traded (date, ticker) pair; power is inherited from arm1.
//   tsx scripts/backtest-probe.ts cutoff [model=YYYY-MM-DD ...]
//       Print the cutoff-verification note (operator supplies verified
//       cutoffs; nothing is guessed).
//
// Flags: --out <file>  --analyst <name>  --concurrency <n>  --classifier-model <id>
//
// pairs.json: ProbePair[] — [{ "day": "YYYY-MM-DD", "ticker": "NVDA",
//   "data": { "lastPrice": n, "avgDollarVolume20d": n, "nominatedBy": [...],
//             "bars": [{t,o,h,l,c,v}...], "news": [{headline,summary,symbols,created_at,source}...] } }]
import 'dotenv/config';
import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { ANALYSTS, type AnalystName } from '../src/types.js';
import { loadConfig } from '../src/config.js';
import type { LlmClient } from '../src/agents/llm.js';
import {
  arm1,
  arm2,
  cutoffNote,
  POSITIVE_CONTROLS,
  runProbeArm,
  type ArmResult,
  type ProbeDeps,
  type ProbePair,
} from '../src/backtest/probe.js';

const args = process.argv.slice(2);
const cmd = args[0];

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function usage(): never {
  console.error(
    'usage: tsx scripts/backtest-probe.ts <controls|arm1 <pairs.json>|arm2 <pairs.json>|cutoff [model=YYYY-MM-DD ...]> [--out file] [--analyst name] [--concurrency n] [--classifier-model id]',
  );
  process.exit(1);
}

function readPairs(file: string | undefined): ProbePair[] {
  if (!file) usage();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  if (!Array.isArray(raw)) throw new Error(`${file}: expected a JSON array of pairs`);
  for (const [i, p] of (raw as Partial<ProbePair>[]).entries()) {
    const d = p?.data;
    if (
      typeof p?.day !== 'string' ||
      typeof p?.ticker !== 'string' ||
      typeof d?.lastPrice !== 'number' ||
      typeof d?.avgDollarVolume20d !== 'number' ||
      !Array.isArray(d?.bars) ||
      !Array.isArray(d?.news)
    ) {
      throw new Error(`${file}: pair ${i} missing day/ticker/data{lastPrice,avgDollarVolume20d,bars,news}`);
    }
  }
  return raw as ProbePair[];
}

function emit(result: unknown, outFile: string | undefined): void {
  const json = JSON.stringify(result, null, 2);
  if (outFile) fs.writeFileSync(outFile, json);
  console.log(json);
}

function summarize(r: ArmResult): void {
  console.error(
    `[probe] ${r.arm}: n=${r.n} tripped=${r.tripped} rate=${r.rate.toFixed(3)} ` +
      `95% CI [${r.binomial95[0].toFixed(3)}, ${r.binomial95[1].toFixed(3)}] ` +
      `controls=${r.controls.filter((c) => c.tripped).length}/${r.controls.length} ` +
      `errors=${r.errors} powerless=${r.powerless}`,
  );
}

async function main(): Promise<void> {
  if (!cmd) usage();
  const cfg = loadConfig();

  if (cmd === 'cutoff') {
    const verified: Record<string, string> = {};
    for (const a of args.slice(1)) {
      const eq = a.indexOf('=');
      if (eq > 0 && !a.startsWith('--')) verified[a.slice(0, eq)] = a.slice(eq + 1);
    }
    emit(cutoffNote(cfg, verified), flag('out'));
    return;
  }

  const analystFlag = flag('analyst');
  if (analystFlag !== undefined && !ANALYSTS.includes(analystFlag as AnalystName)) {
    throw new Error(`--analyst must be one of ${ANALYSTS.join(', ')}`);
  }
  const concurrencyFlag = flag('concurrency');
  const concurrency = concurrencyFlag === undefined ? undefined : Number(concurrencyFlag);
  if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1)) {
    throw new Error('--concurrency must be a positive integer');
  }

  const deps: ProbeDeps = {
    cfg,
    client: new Anthropic() as LlmClient,
    analyst: analystFlag as AnalystName | undefined,
    classifierModel: flag('classifier-model'),
    concurrency,
    log: (msg) => console.error(`[probe ${new Date().toISOString().slice(11, 19)}] ${msg}`),
  };

  let result: ArmResult;
  if (cmd === 'controls') {
    result = await runProbeArm('arm1', [], POSITIVE_CONTROLS, deps);
  } else if (cmd === 'arm1') {
    result = await arm1(readPairs(args[1]), POSITIVE_CONTROLS, deps);
  } else if (cmd === 'arm2') {
    result = await arm2(readPairs(args[1]), deps);
  } else {
    usage();
  }

  emit(result, flag('out'));
  summarize(result);
  if (result.powerless) {
    console.error('[probe] POSITIVE CONTROLS FAILED TO TRIP — probe has no power; a null result bounds nothing');
    process.exit(3);
  }
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
