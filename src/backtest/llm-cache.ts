// Two-level disk cache for LLM calls during the backtest, anchored under
// backtest-data/llm-cache/ (via DATA_DIR).
//
// Level 1 — exact: sha256(model|system|toolName|user) -> stored response.
//   All headline-run calls flow through this level.
// Level 2 — canonical (sweep-only judge cache): keyed on the decision-relevant
//   parts of the judge prompt — model, ticker, direction,
//   invalidationConditions, quote JSON, headlines JSON, position side —
//   deliberately EXCLUDING weightedConviction, targetNotionalUsd, limitBand,
//   and position qty/avg-entry (full plan §3), so sweep cells that differ only
//   in sizing share judge decisions. Non-judge calls in canonical mode fall
//   through to the exact level.
//
// Every stored entry records the model and per-call token usage
// (response.usage.input_tokens/output_tokens) so totalsUsage() can sum actual
// spend per model. A corrupt cache file is treated as a miss and overwritten.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { LlmClient } from '../agents/llm.js';
import { DATA_DIR } from './data.js';

export const LLM_CACHE_DIR = path.join(DATA_DIR, 'llm-cache');

const JUDGE_TOOL_NAME = 'submit_execution_decision';

export interface CachedCallEntry {
  input: { model: string; toolName: string };
  response: unknown; // full Anthropic.Messages.Message, replayed verbatim on hit
  usage: { input_tokens: number; output_tokens: number };
  ts: string;
}

type CreateParams = Anthropic.Messages.MessageCreateParamsNonStreaming;

/**
 * Returns the canonical key string for a call, or null to fall through to the
 * exact cache. The returned string is hashed before use as a filename.
 */
export type CanonicalKeyFn = (params: CreateParams) => string | null;

export type CacheMode = 'exact' | { canonical: CanonicalKeyFn };

export interface ModelUsage {
  calls: number;
  input_tokens: number;
  output_tokens: number;
}

const sha256 = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function toolNameOf(params: CreateParams): string {
  const choice = params.tool_choice;
  if (choice && choice.type === 'tool') return choice.name;
  const first = params.tools?.[0];
  return first && 'name' in first ? first.name : '';
}

function systemTextOf(params: CreateParams): string {
  const sys = params.system;
  if (typeof sys === 'string') return sys;
  return sys === undefined ? '' : JSON.stringify(sys);
}

function userTextOf(params: CreateParams): string {
  const messages = params.messages;
  if (messages.length === 1 && typeof messages[0]!.content === 'string') {
    return messages[0]!.content;
  }
  return JSON.stringify(messages);
}

function exactKey(params: CreateParams): string {
  return [params.model, systemTextOf(params), toolNameOf(params), userTextOf(params)].join('|');
}

// The judge user message is five labeled sections joined by '\n\n'
// (src/agents/judge.ts); JSON.stringify output never contains raw newlines,
// so splitting on '\n\n' recovers the sections exactly.
const JUDGE_LABELS: readonly (readonly [number, string])[] = [
  [0, 'Judge this executor tick.'],
  [1, 'Thesis entry (JSON):'],
  [3, 'Live quote (JSON):'],
  [5, 'Headlines since thesis generation (JSON):'],
  [7, 'Current position (JSON, null if none held):'],
];

/**
 * Canonical key for executor-judge calls; null for anything that is not a
 * well-formed judge prompt (which then falls through to the exact cache).
 * Includes: model, entry ticker/direction/invalidationConditions, the full
 * quote JSON (whose asOf carries the tick time), the full headlines JSON, and
 * the position SIDE only. Excludes weightedConviction, targetNotionalUsd,
 * limitBand, narrative, and position qty/avg-entry/market-value.
 */
export function judgeCanonicalKey(params: CreateParams): string | null {
  if (toolNameOf(params) !== JUDGE_TOOL_NAME) return null;
  const parts = userTextOf(params).split('\n\n');
  if (parts.length !== 9) return null;
  for (const [i, label] of JUDGE_LABELS) if (parts[i] !== label) return null;
  let entry: unknown;
  let position: unknown;
  try {
    entry = JSON.parse(parts[2]!);
    position = JSON.parse(parts[8]!);
  } catch {
    return null;
  }
  if (entry === null || typeof entry !== 'object') return null;
  const e = entry as { ticker?: unknown; direction?: unknown; invalidationConditions?: unknown };
  const positionSide =
    position !== null && typeof position === 'object'
      ? String((position as { side?: unknown }).side ?? 'none')
      : 'none';
  return JSON.stringify({
    model: params.model,
    ticker: e.ticker ?? null,
    direction: e.direction ?? null,
    invalidationConditions: e.invalidationConditions ?? null,
    quote: parts[4],
    headlines: parts[6],
    positionSide,
  });
}

/** Tolerant read: missing, unparseable, or wrong-shaped file -> null (miss). */
function readEntry(file: string): CachedCallEntry | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object') return null;
    const e = parsed as CachedCallEntry;
    if (e.response === null || typeof e.response !== 'object') return null;
    if (e.usage === null || typeof e.usage !== 'object') return null;
    if (e.input === null || typeof e.input !== 'object') return null;
    return e;
  } catch {
    return null;
  }
}

/** Atomic write (tmp + rename), creating directories as needed. */
function writeEntry(file: string, entry: CachedCallEntry): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry));
  fs.renameSync(tmp, file);
}

/**
 * Wrap an LlmClient with the disk cache. In 'exact' mode every call is keyed
 * by sha256(model|system|toolName|user). In canonical mode the supplied
 * function maps a call to its canonical key (e.g. judgeCanonicalKey); calls it
 * maps to null use the exact level instead. On a miss the inner client is
 * called once and the full response plus token usage is persisted.
 */
export function makeCachingClient(
  inner: LlmClient,
  mode: CacheMode,
  cacheDir: string = LLM_CACHE_DIR,
): LlmClient {
  return {
    messages: {
      async create(params: CreateParams): Promise<Anthropic.Messages.Message> {
        const canonicalKey = mode === 'exact' ? null : mode.canonical(params);
        const file =
          canonicalKey !== null
            ? path.join(cacheDir, 'canonical', `${sha256(canonicalKey)}.json`)
            : path.join(cacheDir, 'exact', `${sha256(exactKey(params))}.json`);
        const hit = readEntry(file);
        if (hit) return hit.response as Anthropic.Messages.Message;
        const response = await inner.messages.create(params);
        const usage = (response as { usage?: { input_tokens?: unknown; output_tokens?: unknown } })
          .usage;
        writeEntry(file, {
          input: { model: params.model, toolName: toolNameOf(params) },
          response,
          usage: {
            input_tokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0,
            output_tokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0,
          },
          ts: new Date().toISOString(),
        });
        return response;
      },
    },
  };
}

/**
 * Sum cached call counts and token usage per model across both cache levels.
 * Each stored file is exactly one real inner call (hits never re-persist), so
 * there is no double counting. Corrupt files are skipped.
 */
export function totalsUsage(cacheDir: string = LLM_CACHE_DIR): Record<string, ModelUsage> {
  const totals: Record<string, ModelUsage> = {};
  for (const level of ['exact', 'canonical'] as const) {
    const dir = path.join(cacheDir, level);
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue; // level not created yet
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const entry = readEntry(path.join(dir, f));
      if (!entry) continue;
      const model = typeof entry.input.model === 'string' ? entry.input.model : 'unknown';
      const t = (totals[model] ??= { calls: 0, input_tokens: 0, output_tokens: 0 });
      t.calls += 1;
      t.input_tokens += Number(entry.usage.input_tokens) || 0;
      t.output_tokens += Number(entry.usage.output_tokens) || 0;
    }
  }
  return totals;
}
