import type { Position, QuoteSnapshot, ThesisEntry } from '../types.js';
import type { Config } from '../config.js';
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

    return {
      // strict === true: anything else resolves to the do-nothing default
      proceed: raw.proceed === true,
      exitPosition: input.position !== undefined && raw.exitPosition === true,
      reasons: Array.isArray(raw.reasons)
        ? raw.reasons.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
        : [],
    };
  } catch {
    return { proceed: false, exitPosition: false, reasons: ['judge unavailable'] };
  }
}
