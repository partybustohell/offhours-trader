import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import type { Thesis, ThesisEntry } from './types.js';
import type { Config } from './config.js';
import { loadConfig } from './config.js';
import { nowET } from './clock.js';
import { appendAudit } from './audit.js';
import { candidatesPath, thesisPath, verdictsPath, writeJsonAtomic } from './paths.js';
import { buildCandidates } from './candidates.js';
import { computeThesisEntries, thesisExpiry, rthThesisExpiry } from './synthesis.js';
import type { ThesisKind } from './types.js';
import type { BrokerClient } from './broker/client.js';
import { AlpacaBroker } from './broker/client.js';
import { AlpacaMarketData, type NewsItem } from './broker/marketdata.js';
import { runNominations } from './agents/nominate.js';
import { runVerdicts } from './agents/verdicts.js';
import { writeNarratives } from './agents/narrative.js';
import type { LlmClient } from './agents/llm.js';

export interface PipelineDeps {
  cfg?: Config;
  marketData?: AlpacaMarketData;
  broker?: BrokerClient;
  llm?: LlmClient;
  now?: Date;
  kind?: ThesisKind; // 'offhours' (default, evening) | 'rth' (morning)
}

function groupNewsBySymbol(news: NewsItem[], tickers: string[]): Map<string, NewsItem[]> {
  const wanted = new Set(tickers.map((t) => t.toUpperCase()));
  const out = new Map<string, NewsItem[]>();
  for (const item of news) {
    for (const symbol of item.symbols) {
      const key = symbol.toUpperCase();
      if (!wanted.has(key)) continue;
      const list = out.get(key) ?? [];
      list.push(item);
      out.set(key, list);
    }
  }
  return out;
}

export async function runPipeline(deps: PipelineDeps = {}): Promise<Thesis> {
  const now = deps.now ?? new Date();
  const ymd = nowET(now).ymd;
  const cfg = deps.cfg ?? loadConfig();
  const kind: ThesisKind = deps.kind ?? 'offhours';
  const expiresAt = kind === 'rth' ? rthThesisExpiry(ymd) : thesisExpiry(ymd);
  if (!deps.llm && !process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set; add it to .env');
  }
  const md = deps.marketData ?? new AlpacaMarketData();

  appendAudit({ kind: 'tick', data: { stage: 'pipeline_start', date: ymd, mode: cfg.mode, thesisKind: kind } });

  const [movers, mostActives, news] = await Promise.all([
    md.getMovers(),
    md.getMostActives(),
    md.getNews(),
  ]);
  const moverSymbols = [
    ...new Set([...movers.gainers, ...movers.losers].map((m) => m.symbol.toUpperCase())),
  ];
  const moverBars =
    moverSymbols.length > 0 ? Object.fromEntries(await md.getDailyBars(moverSymbols)) : {};

  const round1 = await runNominations(
    cfg,
    { movers, mostActives, news, barsBySymbol: moverBars },
    deps.llm,
  );
  for (const an of round1.nominations) {
    appendAudit({ kind: 'nomination', data: an });
  }
  for (const analyst of round1.dropped) {
    appendAudit({ kind: 'nomination', data: { analyst, dropped: true } });
  }

  const nominatedTickers = [
    ...new Set(
      round1.nominations.flatMap((an) => an.nominations.map((n) => n.ticker.toUpperCase())),
    ),
  ];
  const marketInfo = await md.marketInfoFor(nominatedTickers);
  const candidateFile = buildCandidates(round1.nominations, marketInfo, cfg, ymd);
  writeJsonAtomic(candidatesPath(ymd), candidateFile);
  appendAudit({
    kind: 'candidates',
    data: {
      date: ymd,
      candidates: candidateFile.candidates.map((c) => c.ticker),
      rejected: candidateFile.rejected,
    },
  });

  if (candidateFile.candidates.length === 0) {
    const empty: Thesis = {
      date: ymd,
      kind,
      generatedAt: now.toISOString(),
      expiresAt,
      entries: [],
      skipped: [],
    };
    writeJsonAtomic(thesisPath(ymd, kind), empty);
    appendAudit({ kind: 'thesis', data: { date: ymd, entries: [], note: 'no candidates' } });
    return empty;
  }

  const candidateTickers = candidateFile.candidates.map((c) => c.ticker);
  const [barsBySymbol, candidateNews] = await Promise.all([
    md.getDailyBars(candidateTickers),
    md.getNews(50, candidateTickers),
  ]);
  const verdictFile = await runVerdicts(
    cfg,
    candidateFile,
    { barsBySymbol, newsBySymbol: groupNewsBySymbol(candidateNews, candidateTickers) },
    deps.llm,
  );
  writeJsonAtomic(verdictsPath(ymd), verdictFile);
  for (const verdict of verdictFile.verdicts) {
    appendAudit({ kind: 'verdict', data: verdict });
  }
  for (const analyst of verdictFile.droppedAnalysts) {
    appendAudit({ kind: 'verdict', data: { analyst, dropped: true } });
  }

  const broker = deps.broker ?? new AlpacaBroker(cfg);
  const account = await broker.getAccount();
  const computed = computeThesisEntries(verdictFile.verdicts, marketInfo, account, cfg);

  const narratives = await writeNarratives(cfg, computed.entries, verdictFile.verdicts, deps.llm);
  const entries: ThesisEntry[] = computed.entries.map((entry) => {
    const n = narratives.get(entry.ticker);
    return {
      ...entry,
      narrative: n?.narrative ?? '',
      invalidationConditions: n?.invalidationConditions ?? entry.invalidationConditions,
    };
  });

  const thesis: Thesis = {
    date: ymd,
    kind,
    generatedAt: now.toISOString(),
    expiresAt,
    entries,
    skipped: computed.skipped,
  };
  writeJsonAtomic(thesisPath(ymd, kind), thesis);
  appendAudit({
    kind: 'thesis',
    data: {
      date: ymd,
      entries: entries.map((e) => ({
        ticker: e.ticker,
        direction: e.direction,
        weightedConviction: e.weightedConviction,
        targetNotionalUsd: e.targetNotionalUsd,
      })),
      skipped: computed.skipped,
      expiresAt: thesis.expiresAt,
    },
  });
  return thesis;
}

export async function main(): Promise<void> {
  try {
    const kind: ThesisKind = process.argv.includes('--session=rth') || process.argv.includes('rth')
      ? 'rth'
      : 'offhours';
    await runPipeline({ kind });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`pipeline failed: ${message}`);
    try {
      appendAudit({ kind: 'error', data: { stage: 'pipeline', message } });
    } catch {
      // audit failure must not mask the original error
    }
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
