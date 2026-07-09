import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import type { Thesis, ThesisEntry } from './types.js';
import type { Config } from './config.js';
import { loadConfig } from './config.js';
import { nowET } from './clock.js';
import { appendAudit } from './audit.js';
import { candidatesPath, thesisPath, verdictsPath, writeJsonAtomic } from './paths.js';
import { buildCandidates, type TickerMarketInfo } from './candidates.js';
import { computeThesisEntries, thesisExpiry, rthThesisExpiry } from './synthesis.js';
import { computeRegime, NEUTRAL_REGIME } from './regime.js';
import {
  amihudIlliquidity,
  dailyReturns,
  gapSignature,
  momentumPct,
  pctOf52wHigh,
  recentReturnPct,
} from './signals.js';
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
  // ~260 daily bars so the P3 momentum / 52-week-high features have history;
  // ADV and realized vol stay on their trailing-20 windows inside marketInfoFor.
  const [featureBarsBySymbol, candidateNews, spyBarsMap] = await Promise.all([
    md.getDailyBars(candidateTickers, 260),
    md.getNews(50, candidateTickers),
    md.getDailyBars(['SPY'], 260),
  ]);
  // The analyst summarizer (verdicts.ts summarizeBars) reduces high/low/avgVolume
  // over its WHOLE bar array into the LLM prompt, so it MUST see only the trailing
  // 25 bars (the historical default) — the 260-bar history is used ONLY for the
  // deterministic features and must never leak the 52-week extremes back into the
  // prompt. This keeps the verdict prompt byte-identical to before.
  const barsBySymbol = new Map([...featureBarsBySymbol].map(([sym, bars]) => [sym, bars.slice(-25)]));
  const verdictFile = await runVerdicts(
    cfg,
    candidateFile,
    { barsBySymbol, newsBySymbol: groupNewsBySymbol(candidateNews, candidateTickers) },
    deps.llm,
  );

  // Enrich market info with per-name signal features from the FULL candidate-bar
  // history, and build the per-ticker return series for the whole-book portfolio
  // pass. Features are computed unconditionally (cheap) and consumed only by
  // enabled signals; all P1-P3 signals ship flag-off, so this changes nothing yet.
  const enrichedInfo = new Map<string, TickerMarketInfo>();
  for (const [t, mi] of marketInfo) enrichedInfo.set(t.toUpperCase(), { ...mi });
  const returnsByTicker = new Map<string, number[]>();
  for (const [sym, bars] of featureBarsBySymbol) {
    if (bars.length === 0) continue;
    const key = sym.toUpperCase();
    const closes = bars.map((b) => b.c);
    const opens = bars.map((b) => b.o);
    const vols = bars.map((b) => b.v);
    const mi: TickerMarketInfo =
      enrichedInfo.get(key) ?? { lastPrice: closes[closes.length - 1] ?? 0, avgDollarVolume20d: 0 };
    mi.recentReturnPct = recentReturnPct(closes, cfg.signals.anti_chase.lookback_days);
    mi.amihudIlliquidity = amihudIlliquidity(closes, vols, cfg.signals.amihud.window_days);
    mi.momentumPct = momentumPct(closes, cfg.signals.trend_gate.lookback_days, cfg.signals.trend_gate.skip_days);
    mi.pctOf52wHigh = pctOf52wHigh(closes, cfg.signals.trend_gate.lookback_days);
    const g = gapSignature(opens, closes, vols);
    if (g) {
      mi.gapPct = g.gapPct;
      mi.gapRelVolume = g.relVolume;
    }
    enrichedInfo.set(key, mi);
    returnsByTicker.set(key, dailyReturns(closes));
  }
  const spyBars = spyBarsMap.get('SPY') ?? [];
  const regime = spyBars.length > 0 ? computeRegime(spyBars.map((b) => b.c), cfg.regime) : NEUTRAL_REGIME;
  writeJsonAtomic(verdictsPath(ymd), verdictFile);
  for (const verdict of verdictFile.verdicts) {
    appendAudit({ kind: 'verdict', data: verdict });
  }
  for (const analyst of verdictFile.droppedAnalysts) {
    appendAudit({ kind: 'verdict', data: { analyst, dropped: true } });
  }

  const broker = deps.broker ?? new AlpacaBroker(cfg);
  const account = await broker.getAccount();
  const computed = computeThesisEntries(
    verdictFile.verdicts,
    enrichedInfo,
    account,
    cfg,
    regime,
    returnsByTicker,
  );

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
    regime: {
      state: regime.state,
      longScalar: regime.longScalar,
      shortScalar: regime.shortScalar,
      volScalar: regime.volScalar,
      thresholdBump: regime.thresholdBump,
    },
  };
  writeJsonAtomic(thesisPath(ymd, kind), thesis);
  // Live counterfactual sizing record (MODELED): same-thesis leave-one-out, so
  // each enabled signal's marginal effect on the notional is attributable. Only
  // emitted when a signal shrank the size; feeds docs/QUANT-TESTING-PLAN.md.
  for (const e of entries) {
    if (e.sizing) {
      appendAudit({
        kind: 'counterfactual',
        data: { ticker: e.ticker, direction: e.direction, targetNotionalUsd: e.targetNotionalUsd, sizing: e.sizing, note: 'MODELED same-thesis leave-one-out' },
      });
    }
  }
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
