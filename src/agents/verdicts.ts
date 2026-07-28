import type { AnalystName, Candidate, CandidateFile, Direction, Verdict, VerdictFile } from '../types.js';
import { ANALYSTS } from '../types.js';
import type { Config } from '../config.js';
import { callStructured, type LlmClient } from './llm.js';
import { ANALYST_SYSTEM, VERDICT_INSTRUCTIONS } from './prompts.js';
import type { NewsItem } from './nominate.js';

export interface DailyBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type BySymbol<T> = Record<string, T> | Map<string, T>;

/** Primary-document text for a candidate (universe.edgar_content). Kept
 *  structural so this module stays decoupled from broker/edgar. */
export interface PrimaryFiling {
  form: string;
  filed: string;
  text: string;
}

export interface VerdictData {
  barsBySymbol: BySymbol<DailyBar[]>;
  newsBySymbol: BySymbol<NewsItem[]>;
  /** Absent (or missing per symbol) = no filing text; the payload field is
   *  simply omitted, keeping prompts byte-identical to the flag-off form. */
  filingsBySymbol?: BySymbol<PrimaryFiling>;
}

function lookup<T>(source: BySymbol<T>, key: string): T | undefined {
  return source instanceof Map ? source.get(key) : source[key];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Compact, informational-only summary handed to the LLM; not used in any
// money math.
function summarizeBars(bars: DailyBar[]): Record<string, unknown> {
  if (bars.length === 0) return { barCount: 0 };
  const closes = bars.map((b) => b.c);
  const last = closes[closes.length - 1] ?? 0;
  const pctFrom = (back: number): number | null => {
    const prev = closes[closes.length - 1 - back];
    if (prev === undefined || prev === 0) return null;
    return round2(((last - prev) / prev) * 100);
  };
  return {
    barCount: bars.length,
    lastClose: last,
    pctChange1d: pctFrom(1),
    pctChange5d: pctFrom(5),
    pctChange20d: pctFrom(20),
    high: Math.max(...bars.map((b) => b.h)),
    low: Math.min(...bars.map((b) => b.l)),
    avgVolume: Math.round(bars.reduce((sum, b) => sum + b.v, 0) / bars.length),
    lastVolume: bars[bars.length - 1]?.v ?? 0,
    recentCloses: closes.slice(-10),
  };
}

function verdictSchema(tickers: string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ticker: { type: 'string', enum: tickers },
            direction: { type: 'string', enum: ['long', 'short', 'none'] },
            conviction: { type: 'number', minimum: 0, maximum: 1 },
            horizon: { type: 'string', enum: ['days', 'weeks'] },
            evidence: { type: 'array', items: { type: 'string' } },
            invalidation_conditions: { type: 'array', items: { type: 'string' } },
          },
          required: [
            'ticker',
            'direction',
            'conviction',
            'horizon',
            'evidence',
            'invalidation_conditions',
          ],
          additionalProperties: false,
        },
      },
    },
    required: ['verdicts'],
    additionalProperties: false,
  };
}

function clampConviction(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((s): s is string => typeof s === 'string' && s.trim() !== '');
}

function sanitizeVerdicts(raw: unknown, analyst: AnalystName, tickerSet: Set<string>): Verdict[] {
  const items = (raw as { verdicts?: unknown })?.verdicts;
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  const out: Verdict[] = [];
  for (const item of items) {
    const record = item as Record<string, unknown>;
    const ticker =
      typeof record.ticker === 'string' ? record.ticker.trim().toUpperCase() : '';
    if (!tickerSet.has(ticker) || seen.has(ticker)) continue;
    const direction = record.direction;
    if (direction !== 'long' && direction !== 'short' && direction !== 'none') continue;
    seen.add(ticker);
    out.push({
      // analyst is attached by code, never taken from the model
      analyst,
      ticker,
      direction: direction as Direction,
      conviction: clampConviction(record.conviction),
      horizon: record.horizon === 'weeks' ? 'weeks' : 'days',
      evidence: stringArray(record.evidence),
      invalidation_conditions: stringArray(record.invalidation_conditions),
    });
  }
  return out;
}

function verdictPayload(list: Candidate[], data: VerdictData): Record<string, unknown>[] {
  return list.map((c) => {
    const filing = data.filingsBySymbol
      ? lookup(data.filingsBySymbol, c.ticker.toUpperCase()) ?? lookup(data.filingsBySymbol, c.ticker)
      : undefined;
    return {
      ticker: c.ticker,
      lastPrice: c.lastPrice,
      avgDollarVolume20d: c.avgDollarVolume20d,
      nominatedBy: c.nominatedBy,
      bars: summarizeBars(lookup(data.barsBySymbol, c.ticker) ?? []),
      news: (lookup(data.newsBySymbol, c.ticker) ?? []).slice(0, 10).map((n) => ({
        headline: n.headline,
        summary: n.summary,
        created_at: n.created_at,
        source: n.source,
        // Primary text (universe.news_content): stripped article body so the
        // panel reads actual guidance language, not just the headline.
        ...(n.content ? { content: n.content } : {}),
      })),
      // SEC primary document (universe.edgar_content): the candidate's recent
      // 8-K / press-release exhibit text, straight from the filing.
      ...(filing ? { primaryFiling: { form: filing.form, filed: filing.filed, text: filing.text } } : {}),
    };
  });
}

export async function runVerdicts(
  cfg: Config,
  candidates: CandidateFile,
  data: VerdictData,
  client?: LlmClient,
): Promise<VerdictFile> {
  if (candidates.candidates.length === 0) {
    return { date: candidates.date, verdicts: [], droppedAnalysts: [] };
  }

  // CHUNKED verdict round: at most verdict_chunk_size candidates per LLM call,
  // so the per-candidate output budget (~900 tokens/candidate, measured after
  // the 2026-07-27 truncation incident) can always be honored. The old single
  // call capped maxTokens at 16k, which the formula's own model exceeds from
  // ~18 candidates (18*900 = 16.2k) — the incident class was latent again the
  // moment max_candidates rose to 25. Chunks are self-contained (verdicts are
  // per-candidate; the instructions never require cross-candidate context) and
  // run SEQUENTIALLY per analyst so concurrency stays at 5, same as before.
  const chunkSize = Math.max(1, cfg.universe.verdict_chunk_size);
  const chunks: Candidate[][] = [];
  for (let i = 0; i < candidates.candidates.length; i += chunkSize) {
    chunks.push(candidates.candidates.slice(i, i + chunkSize));
  }

  const perAnalyst = await Promise.all(
    ANALYSTS.map(async (analyst): Promise<{ verdicts: Verdict[]; failedChunks: number }> => {
      const verdicts: Verdict[] = [];
      let failedChunks = 0;
      for (const chunk of chunks) {
        const chunkTickers = chunk.map((c) => c.ticker.toUpperCase());
        const user = [
          VERDICT_INSTRUCTIONS,
          `Candidate set (${chunkTickers.length} tickers): ${chunkTickers.join(', ')}`,
          'Per-candidate data (JSON):',
          JSON.stringify(verdictPayload(chunk, data)),
        ].join('\n\n');
        try {
          const raw = await callStructured<unknown>(
            {
              // Per-persona override (ensemble diversity); default falls back.
              model: cfg.model.analysts_by_name[analyst] ?? cfg.model.analysts,
              system: ANALYST_SYSTEM[analyst],
              user,
              toolName: 'submit_verdicts',
              toolSchema: verdictSchema(chunkTickers),
              // Per-chunk output budget; the 16k ceiling is unreachable at the
              // default chunk size (8 * 900 = 7.2k) and guards only degenerate
              // configs that set verdict_chunk_size near max_candidates.
              maxTokens: Math.min(16_000, Math.max(4000, chunkTickers.length * 900)),
            },
            client,
          );
          const sanitized = sanitizeVerdicts(raw, analyst, new Set(chunkTickers));
          // Zero verdicts against a non-empty chunk is a malfunction, not an
          // opinion — the instructions require one verdict per candidate
          // ("none" is the abstention channel). Count the chunk as failed.
          if (sanitized.length === 0) {
            throw new Error(
              `analyst ${analyst} returned zero verdicts for ${chunkTickers.length} candidates`,
            );
          }
          verdicts.push(...sanitized);
        } catch {
          failedChunks++;
        }
      }
      return { verdicts, failedChunks };
    }),
  );

  // An analyst with ANY failed chunk is counted as dropped: their evidence is
  // incomplete, and quorum math plus the degraded-refresh carryover must see
  // that. Verdicts from their SUCCESSFUL chunks are still kept — quorum is
  // per-ticker and verified evidence is never discarded.
  const verdicts: Verdict[] = [];
  const droppedAnalysts: AnalystName[] = [];
  ANALYSTS.forEach((analyst, i) => {
    const result = perAnalyst[i]!;
    verdicts.push(...result.verdicts);
    if (result.failedChunks > 0) droppedAnalysts.push(analyst);
  });

  return { date: candidates.date, verdicts, droppedAnalysts };
}
