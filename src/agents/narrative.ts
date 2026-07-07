import type { ThesisEntry, Verdict } from '../types.js';
import type { Config } from '../config.js';
import { callStructured, type LlmClient } from './llm.js';
import { SYNTH_NARRATIVE_SYSTEM } from './prompts.js';

export type ComputedEntry = Omit<ThesisEntry, 'narrative'>;

export interface NarrativeResult {
  narrative: string;
  invalidationConditions: string[];
}

const NARRATIVE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    narratives: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ticker: { type: 'string' },
          narrative: {
            type: 'string',
            description: '3-5 sentence cohesive thesis reconciling the analyst viewpoints',
          },
          invalidation_conditions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Merged, deduplicated, concrete invalidation conditions',
          },
        },
        required: ['ticker', 'narrative', 'invalidation_conditions'],
        additionalProperties: false,
      },
    },
  },
  required: ['narratives'],
  additionalProperties: false,
};

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((s): s is string => typeof s === 'string' && s.trim() !== '');
}

function fallbackFor(entry: ComputedEntry, verdicts: Verdict[]): NarrativeResult {
  const agreeing = verdicts.filter(
    (v) => v.ticker === entry.ticker && v.direction === entry.direction,
  );
  const lines = agreeing
    .map((v) => v.evidence[0])
    .filter((s): s is string => typeof s === 'string' && s.trim() !== '');
  const narrative =
    lines.length > 0
      ? lines.join(' ')
      : `${entry.direction === 'long' ? 'Long' : 'Short'} ${entry.ticker} at weighted conviction ${entry.weightedConviction}; synthesizer narrative unavailable.`;
  return { narrative, invalidationConditions: entry.invalidationConditions };
}

/**
 * Single synthesizer call producing per-ticker narratives. On any failure —
 * API error, missing tickers, malformed output — the affected entries get a
 * deterministic fallback built from the agreeing verdicts' top evidence
 * lines. The pipeline never dies on narrative polish.
 */
export async function writeNarratives(
  cfg: Config,
  computedEntries: ComputedEntry[],
  verdicts: Verdict[],
  client?: LlmClient,
): Promise<Map<string, NarrativeResult>> {
  const out = new Map<string, NarrativeResult>();
  if (computedEntries.length === 0) return out;

  try {
    const payload = computedEntries.map((entry) => ({
      ticker: entry.ticker,
      direction: entry.direction,
      weightedConviction: entry.weightedConviction,
      limitBand: entry.limitBand,
      targetNotionalUsd: entry.targetNotionalUsd,
      computedInvalidationConditions: entry.invalidationConditions,
      verdicts: verdicts
        .filter((v) => v.ticker === entry.ticker)
        .map((v) => ({
          analyst: v.analyst,
          direction: v.direction,
          conviction: v.conviction,
          evidence: v.evidence,
          invalidation_conditions: v.invalidation_conditions,
        })),
    }));

    const user = [
      `Write one narrative item per ticker (${computedEntries.length} total): ${computedEntries
        .map((e) => e.ticker)
        .join(', ')}`,
      'Computed entries and their verdicts (JSON):',
      JSON.stringify(payload),
    ].join('\n\n');

    const raw = await callStructured<unknown>(
      {
        model: cfg.model.synthesizer,
        system: SYNTH_NARRATIVE_SYSTEM,
        user,
        toolName: 'submit_narratives',
        toolSchema: NARRATIVE_SCHEMA,
        maxTokens: 4000,
      },
      client,
    );

    const byTicker = new Map(computedEntries.map((e) => [e.ticker, e]));
    const items = (raw as { narratives?: unknown })?.narratives;
    if (Array.isArray(items)) {
      for (const item of items) {
        const record = item as Record<string, unknown>;
        const ticker =
          typeof record.ticker === 'string' ? record.ticker.trim().toUpperCase() : '';
        const entry = byTicker.get(ticker);
        if (!entry || out.has(ticker)) continue;
        const narrative =
          typeof record.narrative === 'string' ? record.narrative.trim() : '';
        if (narrative === '') continue;
        const merged = stringArray(record.invalidation_conditions);
        out.set(ticker, {
          narrative,
          invalidationConditions: merged.length > 0 ? merged : entry.invalidationConditions,
        });
      }
    }
  } catch {
    // fall through to fallbacks for all entries
  }

  for (const entry of computedEntries) {
    if (!out.has(entry.ticker)) out.set(entry.ticker, fallbackFor(entry, verdicts));
  }
  return out;
}
