import type { AnalystName, AnalystNominations, Nomination } from '../types.js';
import { ANALYSTS } from '../types.js';
import type { Config } from '../config.js';
import { callStructured, type LlmClient } from './llm.js';
import { ANALYST_SYSTEM, NOMINATE_INSTRUCTIONS } from './prompts.js';

// Structural shapes of the market-data scans; kept local so this module does
// not depend on broker/marketdata. Anything shape-compatible works.
export interface MoverItem {
  symbol: string;
  percent_change: number;
  price: number;
}
export interface MoversScan {
  gainers: MoverItem[];
  losers: MoverItem[];
}
export interface MostActiveItem {
  symbol: string;
  volume: number;
  trade_count?: number;
}
export interface NewsItem {
  headline: string;
  summary: string;
  symbols: string[];
  created_at: string;
  source: string;
}
export interface Scans {
  movers: MoversScan;
  mostActives: MostActiveItem[];
  news: NewsItem[];
}

export interface NominationRound {
  nominations: AnalystNominations[];
  dropped: AnalystName[];
}

function payloadFor(analyst: AnalystName, scans: Scans): Record<string, unknown> {
  switch (analyst) {
    case 'fundamental':
      return { news: scans.news, mostActives: scans.mostActives };
    case 'technical':
      return { movers: scans.movers, mostActives: scans.mostActives };
    case 'macro':
      return { movers: scans.movers, news: scans.news };
    case 'sentiment':
      return { news: scans.news };
    case 'bear':
      return { movers: scans.movers, mostActives: scans.mostActives, news: scans.news };
  }
}

const BEAR_FRAMING =
  'Your nominations are tickers the panel should examine skeptically: names where the crowd looks wrong, the move looks fragile, or a contrary case may exist. They enter the same candidate pool as everyone else\'s nominations.';

function nominationSchema(maxItems: number): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      nominations: {
        type: 'array',
        maxItems,
        items: {
          type: 'object',
          properties: {
            ticker: { type: 'string', description: 'US equity ticker symbol from the scan data' },
            reason: { type: 'string', description: 'One-line reason grounded in the scan data' },
          },
          required: ['ticker', 'reason'],
          additionalProperties: false,
        },
      },
    },
    required: ['nominations'],
    additionalProperties: false,
  };
}

function sanitize(raw: unknown, max: number): Nomination[] {
  const items = (raw as { nominations?: unknown })?.nominations;
  if (!Array.isArray(items)) return [];
  const out: Nomination[] = [];
  for (const item of items) {
    const ticker = (item as { ticker?: unknown })?.ticker;
    const reason = (item as { reason?: unknown })?.reason;
    if (typeof ticker !== 'string' || ticker.trim() === '') continue;
    if (typeof reason !== 'string') continue;
    out.push({ ticker: ticker.trim().toUpperCase(), reason: reason.trim() });
    if (out.length >= max) break;
  }
  return out;
}

export async function runNominations(
  cfg: Config,
  scans: Scans,
  client?: LlmClient,
): Promise<NominationRound> {
  const max = cfg.universe.nominations_per_agent;

  const results = await Promise.allSettled(
    ANALYSTS.map(async (analyst): Promise<AnalystNominations> => {
      const user = [
        NOMINATE_INSTRUCTIONS,
        `Nominate at most ${max} tickers.`,
        analyst === 'bear' ? BEAR_FRAMING : '',
        'Market scan data (JSON):',
        JSON.stringify(payloadFor(analyst, scans)),
      ]
        .filter((s) => s !== '')
        .join('\n\n');

      const raw = await callStructured<unknown>(
        {
          model: cfg.model.analysts,
          system: ANALYST_SYSTEM[analyst],
          user,
          toolName: 'submit_nominations',
          toolSchema: nominationSchema(max),
        },
        client,
      );
      // analyst is attached by code, never taken from the model
      return { analyst, nominations: sanitize(raw, max) };
    }),
  );

  const nominations: AnalystNominations[] = [];
  const dropped: AnalystName[] = [];
  ANALYSTS.forEach((analyst, i) => {
    const result = results[i];
    if (result?.status === 'fulfilled') nominations.push(result.value);
    else dropped.push(analyst);
  });
  return { nominations, dropped };
}
