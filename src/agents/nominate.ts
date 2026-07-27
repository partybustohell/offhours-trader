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
  /** Stripped article body; present only on verdict-round candidate news. */
  content?: string;
}
export interface EarningsScanItem {
  symbol: string;
  name: string;
  time: 'pre' | 'post' | 'unknown';
}
export interface Scans {
  movers: MoversScan;
  mostActives: MostActiveItem[];
  news: NewsItem[];
  /** Daily bars for mover symbols; consumed by the technical analyst. */
  barsBySymbol?: Record<string, unknown>;
  /** Catalyst scan (universe.earnings_scan): names scheduled to report today
   *  post-close / tomorrow pre-open — the panel evaluates them BEFORE the
   *  reaction instead of after they hit the movers list. Absent when the
   *  flag is off or the calendar fetch degraded (fail-open). */
  earnings?: {
    reportingPostCloseToday: EarningsScanItem[];
    reportingPreOpenTomorrow: EarningsScanItem[];
  };
}

export interface NominationRound {
  nominations: AnalystNominations[];
  dropped: AnalystName[];
}

function payloadFor(analyst: AnalystName, scans: Scans): Record<string, unknown> {
  // Earnings-calendar scan goes to the analysts whose purview covers
  // catalysts: fundamental (their highest-signal events), sentiment (fresh
  // reaction plays), bear (binary-event risk inside the horizon). Technical
  // reads bars, macro reads the macro calendar — neither gets it.
  const earnings = scans.earnings ? { scheduledEarnings: scans.earnings } : {};
  switch (analyst) {
    case 'fundamental':
      return { news: scans.news, mostActives: scans.mostActives, ...earnings };
    case 'technical':
      return { movers: scans.movers, mostActives: scans.mostActives, bars: scans.barsBySymbol ?? {} };
    case 'macro':
      return { movers: scans.movers, news: scans.news };
    case 'sentiment':
      return { news: scans.news, ...earnings };
    case 'bear':
      return { movers: scans.movers, mostActives: scans.mostActives, news: scans.news, ...earnings };
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

// Plausible US equity symbol; model output that is not a symbol (prose,
// hallucinated strings) is dropped at this boundary, before it can reach a
// market-data request.
const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

function sanitize(raw: unknown, max: number): Nomination[] {
  const items = (raw as { nominations?: unknown })?.nominations;
  if (!Array.isArray(items)) return [];
  const out: Nomination[] = [];
  for (const item of items) {
    const ticker = (item as { ticker?: unknown })?.ticker;
    const reason = (item as { reason?: unknown })?.reason;
    if (typeof ticker !== 'string') continue;
    const t = ticker.trim().toUpperCase();
    if (!TICKER_RE.test(t)) continue;
    if (typeof reason !== 'string') continue;
    out.push({ ticker: t, reason: reason.trim() });
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
          // Per-persona override for ensemble-diversity trials; falls back to
          // the shared analysts model (the shipped default — overrides are an
          // A/B decision gated by the trial registry).
          model: cfg.model.analysts_by_name[analyst] ?? cfg.model.analysts,
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
