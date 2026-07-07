import type { AnalystName, CandidateFile, Direction, Verdict, VerdictFile } from '../types.js';
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

export interface VerdictData {
  barsBySymbol: BySymbol<DailyBar[]>;
  newsBySymbol: BySymbol<NewsItem[]>;
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

export async function runVerdicts(
  cfg: Config,
  candidates: CandidateFile,
  data: VerdictData,
  client?: LlmClient,
): Promise<VerdictFile> {
  if (candidates.candidates.length === 0) {
    return { date: candidates.date, verdicts: [], droppedAnalysts: [] };
  }

  const tickers = candidates.candidates.map((c) => c.ticker.toUpperCase());
  const tickerSet = new Set(tickers);

  const payload = candidates.candidates.map((c) => ({
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
    })),
  }));

  const user = [
    VERDICT_INSTRUCTIONS,
    `Candidate set (${tickers.length} tickers): ${tickers.join(', ')}`,
    'Per-candidate data (JSON):',
    JSON.stringify(payload),
  ].join('\n\n');

  const results = await Promise.allSettled(
    ANALYSTS.map(async (analyst): Promise<Verdict[]> => {
      const raw = await callStructured<unknown>(
        {
          model: cfg.model.analysts,
          system: ANALYST_SYSTEM[analyst],
          user,
          toolName: 'submit_verdicts',
          toolSchema: verdictSchema(tickers),
          maxTokens: 4000,
        },
        client,
      );
      return sanitizeVerdicts(raw, analyst, tickerSet);
    }),
  );

  const verdicts: Verdict[] = [];
  const droppedAnalysts: AnalystName[] = [];
  ANALYSTS.forEach((analyst, i) => {
    const result = results[i];
    if (result?.status === 'fulfilled') verdicts.push(...result.value);
    else droppedAnalysts.push(analyst);
  });

  return { date: candidates.date, verdicts, droppedAnalysts };
}
