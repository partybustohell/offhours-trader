// Stage 0 helper — build ProbePair[] inputs for scripts/backtest-probe.ts.
//
//   tsx scripts/backtest-probe-pairs.ts arm2 <tagDir...> --out pairs-arm2.json
//       Every unique (day, ticker) pair traded in the given run dirs. A tag
//       dir may be a flat run (backtest-out/defaults) or a sweep root
//       (backtest-out/v2-sip) — sweep/<cell>/<day> layouts are walked too.
//   tsx scripts/backtest-probe-pairs.ts arm1 --n 20 --seed 20260710 --out pairs-arm1.json
//       Deterministic sample of candidate pairs across all prep files
//       (mulberry32; excludes nothing — arm 1 is sampled candidates, traded
//       or not, per the probe design).
//
// Pair data mirrors what precompute fed runVerdicts: last 25 IEX daily bars
// as of day D and uncapped (D-1 17:00, D 17:00] news for the ticker.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDailyBars, readJson } from '../src/backtest/data.js';
import { uncappedNewsFor } from '../src/backtest/scans.js';
import { mulberry32, type EpisodeResult } from '../src/backtest/metrics.js';
import type { ProbePair } from '../src/backtest/probe.js';
import type { DailyBar } from '../src/agents/verdicts.js';
import type { PrepFile } from './backtest-episode.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_ROOT = process.env.BACKTEST_OUT_DIR ?? path.join(REPO_ROOT, 'backtest-out');
const PREP_DIR = path.join(OUT_ROOT, 'prep');
const BARS_LOOKBACK = 25; // production getDailyBars lookback

const args = process.argv.slice(2);
const cmd = args[0];

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function iexBarsUpTo(symbol: string, day: string): DailyBar[] {
  return loadDailyBars('iex', symbol)
    .filter((b) => b.t.slice(0, 10) <= day)
    .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
    .slice(-BARS_LOOKBACK);
}

function loadPrep(day: string): PrepFile | null {
  return readJson<PrepFile>(path.join(PREP_DIR, `${day}.json`));
}

function buildPair(day: string, ticker: string): ProbePair | null {
  const prep = loadPrep(day);
  const candidate = prep?.candidates.candidates.find(
    (c) => c.ticker.toUpperCase() === ticker.toUpperCase(),
  );
  if (!candidate) {
    console.error(`[pairs] ${day} ${ticker}: no candidate in prep file — skipped`);
    return null;
  }
  const news = uncappedNewsFor(day).filter((n) =>
    n.symbols.some((s) => s.toUpperCase() === ticker.toUpperCase()),
  );
  return {
    day,
    ticker: ticker.toUpperCase(),
    data: {
      lastPrice: candidate.lastPrice,
      avgDollarVolume20d: candidate.avgDollarVolume20d,
      nominatedBy: candidate.nominatedBy,
      bars: iexBarsUpTo(ticker, day),
      news,
    },
  };
}

/** Episode-result files under a run dir, covering flat and sweep layouts. */
function episodeResults(root: string): EpisodeResult[] {
  const out: EpisodeResult[] = [];
  const dayDirs = (dir: string): string[] => {
    try {
      return fs
        .readdirSync(dir)
        .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
        .map((n) => path.join(dir, n));
    } catch {
      return [];
    }
  };
  const roots = [root];
  const sweepRoot = path.join(root, 'sweep');
  try {
    for (const cell of fs.readdirSync(sweepRoot)) roots.push(path.join(sweepRoot, cell));
  } catch {
    /* no sweep layout */
  }
  for (const r of roots) {
    for (const dayDir of dayDirs(r)) {
      const result = readJson<EpisodeResult>(path.join(dayDir, 'episode-result.json'));
      if (result) out.push(result);
    }
  }
  return out;
}

function writePairs(pairs: ProbePair[], outFile: string | undefined): void {
  const json = JSON.stringify(pairs, null, 2);
  if (outFile) {
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    fs.writeFileSync(outFile, json);
    console.error(`[pairs] wrote ${pairs.length} pairs -> ${outFile}`);
  } else {
    console.log(json);
  }
}

function main(): void {
  if (cmd === 'arm2') {
    const tagDirs = args.slice(1).filter((a) => !a.startsWith('--') && a !== flag('out'));
    if (tagDirs.length === 0) {
      throw new Error('usage: backtest-probe-pairs.ts arm2 <tagDir...> [--out file]');
    }
    const seen = new Set<string>();
    const pairs: ProbePair[] = [];
    for (const dir of tagDirs) {
      for (const episode of episodeResults(path.resolve(dir))) {
        for (const trade of episode.trades) {
          const key = `${episode.day}|${trade.ticker.toUpperCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const pair = buildPair(episode.day, trade.ticker);
          if (pair) pairs.push(pair);
        }
      }
    }
    writePairs(pairs, flag('out'));
    return;
  }
  if (cmd === 'arm1') {
    const n = Number(flag('n') ?? 20);
    const seed = Number(flag('seed') ?? 20260710);
    const days = fs
      .readdirSync(PREP_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .sort();
    const universe: { day: string; ticker: string }[] = [];
    for (const day of days) {
      const prep = loadPrep(day);
      for (const c of prep?.candidates.candidates ?? []) {
        universe.push({ day, ticker: c.ticker.toUpperCase() });
      }
    }
    // Deterministic Fisher-Yates prefix via mulberry32 — reproducible sample.
    const rand = mulberry32(seed);
    for (let i = universe.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [universe[i], universe[j]] = [universe[j]!, universe[i]!];
    }
    const pairs: ProbePair[] = [];
    for (const { day, ticker } of universe) {
      if (pairs.length >= n) break;
      const pair = buildPair(day, ticker);
      if (pair) pairs.push(pair);
    }
    console.error(`[pairs] sampled ${pairs.length}/${n} from ${universe.length} candidates (seed ${seed})`);
    writePairs(pairs, flag('out'));
    return;
  }
  console.error('usage: backtest-probe-pairs.ts <arm1 [--n 20] [--seed N]|arm2 <tagDir...>> [--out file]');
  process.exit(1);
}

main();
