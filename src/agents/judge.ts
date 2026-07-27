import crypto from 'node:crypto';
import type { Position, QuoteSnapshot, ThesisEntry } from '../types.js';
import type { Config } from '../config.js';
import { judgeCachePath, readJsonIfExists, writeJsonAtomic } from '../paths.js';
import { callStructured, type LlmClient } from './llm.js';
import { EXECUTOR_JUDGE_SYSTEM } from './prompts.js';
import type { NewsItem } from './nominate.js';

export interface JudgeInput {
  entry: ThesisEntry;
  quote: QuoteSnapshot;
  headlines: NewsItem[];
  position?: Position;
}

export interface ExecutionDecision {
  proceed: boolean;
  exitPosition: boolean;
  reasons: string[];
}

const DECISION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    proceed: {
      type: 'boolean',
      description: 'Whether the thesis entry conditions still hold for a new entry',
    },
    exitPosition: {
      type: 'boolean',
      description:
        'Whether a stated invalidation condition has clearly triggered for the held position',
    },
    reasons: {
      type: 'array',
      items: { type: 'string' },
      description: 'Short, specific reasons for the decision',
    },
  },
  required: ['proceed', 'exitPosition', 'reasons'],
  additionalProperties: false,
};

// ---- decision cache (live executor only; see config judge_cache) ----------
// Keyed on the decision-relevant inputs: model, the FULL thesis entry (a new
// thesis therefore keys fresh), the headline set, and the position SIDE. The
// live quote is deliberately EXCLUDED: the judge is instructed not to
// re-derive numbers (every quantitative gate is code-enforced each tick), so
// identical entry+headlines must yield the identical decision instead of
// re-rolling LLM nondeterminism every 15 minutes. A cached proceed=false is
// the decline cooldown: the name stays declined until its inputs change.
// LLM FAILURES are never cached (transient by definition).

interface CachedDecision {
  decision: ExecutionDecision;
  atMs: number;
}
type JudgeCacheFile = Record<string, CachedDecision>;

function cacheKey(model: string, input: JudgeInput): string {
  const material = JSON.stringify({
    model,
    entry: input.entry,
    headlines: input.headlines,
    positionSide: input.position?.side ?? 'none',
  });
  return crypto.createHash('sha256').update(material, 'utf8').digest('hex');
}

/** Tolerant read: missing/corrupt/wrong shape -> empty (cache miss). */
function readCache(): JudgeCacheFile {
  try {
    const raw = readJsonIfExists<JudgeCacheFile>(judgeCachePath());
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function isCachedDecision(v: unknown): v is CachedDecision {
  if (v === null || typeof v !== 'object') return false;
  const c = v as CachedDecision;
  return (
    typeof c.atMs === 'number' &&
    c.decision !== null &&
    typeof c.decision === 'object' &&
    typeof c.decision.proceed === 'boolean' &&
    typeof c.decision.exitPosition === 'boolean' &&
    Array.isArray(c.decision.reasons)
  );
}

/**
 * LLM veto/confirm on one executor tick. Code enforces all quantitative
 * gates regardless of this answer. Any failure or timeout resolves to
 * do-nothing: proceed=false, exitPosition=false.
 */
export async function judgeTick(
  cfg: Config,
  input: JudgeInput,
  client?: LlmClient,
): Promise<ExecutionDecision> {
  const useCache = cfg.judge_cache.enabled;
  const maxAgeMs = cfg.judge_cache.max_age_hours * 3_600_000;
  const key = useCache ? cacheKey(cfg.model.executor, input) : '';
  if (useCache) {
    const hit = readCache()[key];
    if (hit && isCachedDecision(hit) && Date.now() - hit.atMs <= maxAgeMs) {
      return hit.decision;
    }
  }
  try {
    const user = [
      'Judge this executor tick.',
      'Thesis entry (JSON):',
      JSON.stringify(input.entry),
      'Live quote (JSON):',
      JSON.stringify(input.quote),
      'Headlines since thesis generation (JSON):',
      JSON.stringify(input.headlines),
      'Current position (JSON, null if none held):',
      JSON.stringify(input.position ?? null),
    ].join('\n\n');

    const raw = await callStructured<Record<string, unknown>>(
      {
        model: cfg.model.executor,
        system: EXECUTOR_JUDGE_SYSTEM,
        user,
        toolName: 'submit_execution_decision',
        toolSchema: DECISION_SCHEMA,
        maxTokens: 1000,
      },
      client,
    );

    const decision: ExecutionDecision = {
      // strict === true: anything else resolves to the do-nothing default
      proceed: raw.proceed === true,
      exitPosition: input.position !== undefined && raw.exitPosition === true,
      reasons: Array.isArray(raw.reasons)
        ? raw.reasons.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
        : [],
    };
    if (useCache) {
      // re-read before write: exits placed earlier this tick may have written
      const cache = readCache();
      const cutoff = Date.now() - maxAgeMs;
      for (const [k, v] of Object.entries(cache)) {
        if (!isCachedDecision(v) || v.atMs < cutoff) delete cache[k];
      }
      cache[key] = { decision, atMs: Date.now() };
      writeJsonAtomic(judgeCachePath(), cache);
    }
    return decision;
  } catch {
    // never cached: an unavailable judge must be retried next tick
    return { proceed: false, exitPosition: false, reasons: ['judge unavailable'] };
  }
}
