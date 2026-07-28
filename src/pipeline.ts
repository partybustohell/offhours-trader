import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import type { Thesis, ThesisEntry } from './types.js';
import type { Config } from './config.js';
import { loadConfig } from './config.js';
import { nowET } from './clock.js';
import { appendAudit } from './audit.js';
import { candidatesPath, readJsonIfExists, thesisPath, verdictsPath, verdictsShadowPath, writeJsonAtomic } from './paths.js';
import { buildCandidates, type TickerMarketInfo } from './candidates.js';
import { computeThesisEntries, thesisExpiry, rthThesisExpiry } from './synthesis.js';
import { computeRegime, NEUTRAL_REGIME } from './regime.js';
import { computeTickerFeatures, dailyReturns } from './signals.js';
import type { ThesisKind } from './types.js';
import type { BrokerClient } from './broker/client.js';
import { AlpacaBroker } from './broker/client.js';
import { AlpacaMarketData, type NewsItem } from './broker/marketdata.js';
import { runNominations, type EarningsScanItem, type Scans } from './agents/nominate.js';
import { runVerdicts } from './agents/verdicts.js';
import { writeNarratives } from './agents/narrative.js';
import type { LlmClient } from './agents/llm.js';
import { mergedExitPlan } from './exits.js';
import { loadEarningsCalendar, ymdRange } from './broker/earnings.js';
import { loadRecentFilings } from './broker/edgar.js';
import { shadowEntryRecord, shadowPortfolioScalar, shadowRegime, verdictAgreement } from './shadow.js';

export interface PipelineDeps {
  cfg?: Config;
  marketData?: AlpacaMarketData;
  broker?: BrokerClient;
  llm?: LlmClient;
  now?: Date;
  kind?: ThesisKind; // 'offhours' (default, evening) | 'rth' (morning)
}

/**
 * Same-day thesis refresh safety (the 16:35 early pass + 17:05 main pass both
 * write the same file): entries from the PREVIOUS same-day thesis whose ticker
 * is currently held or has a resting order are CARRIED into the refreshed
 * thesis when the new run didn't re-emit them. Without this, the overwrite
 * would orphan a position opened from the earlier pass — its entry-carried
 * exit plan (invalidation price, target, time stop) would silently vanish.
 * Carried entries keep their original narrative and exit plan. Pure.
 */
export function carryoverEntries(
  previous: ThesisEntry[],
  fresh: ThesisEntry[],
  activeTickers: Set<string>,
  // Degraded refresh (>=2 analysts dropped in the verdict round): the re-run's
  // evidence is broken, so carry ALL previous entries it failed to re-emit —
  // a malfunctioning refresh must never erase a healthy thesis (observed
  // 2026-07-27: the 21:05 pass lost three analysts to truncation, skipped
  // every candidate on quorum, and wiped the 16:35 NUE catalyst entry).
  // A HEALTHY refresh still replaces pending entries by design.
  carryAllOnDegraded = false,
): ThesisEntry[] {
  const freshTickers = new Set(fresh.map((e) => e.ticker.toUpperCase()));
  return previous.filter(
    (e) =>
      !freshTickers.has(e.ticker.toUpperCase()) &&
      (carryAllOnDegraded || activeTickers.has(e.ticker.toUpperCase())),
  );
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
  // data_feed governs bars here: the ADV floor and every volume-derived
  // feature must see consolidated volume when SIP is subscribed, not the
  // single-venue IEX default this constructor would otherwise fall back to.
  const md =
    deps.marketData ?? new AlpacaMarketData(process.env, globalThis.fetch, undefined, cfg.data_feed);

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

  // Catalyst scan (universe.earnings_scan): names scheduled to report today
  // post-close and tomorrow pre-open, so the panel can be EARLY on a catalyst
  // instead of late to its reaction. Fail-open: degraded dates are audited and
  // the scan is simply absent.
  let earningsScan: Scans['earnings'];
  if (cfg.universe.earnings_scan.enabled) {
    const [todayEt, tomorrowEt] = ymdRange(now, 1) as [string, string];
    const { days, degraded } = await loadEarningsCalendar(1, now);
    if (degraded.length > 0) {
      appendAudit({
        kind: 'tick',
        data: { stage: 'earnings_calendar_degraded', dates: degraded, note: 'scan proceeds without those dates (fail-open)' },
      });
    }
    const toItem = (e: { symbol: string; name: string; time: EarningsScanItem['time'] }): EarningsScanItem => ({
      symbol: e.symbol,
      name: e.name,
      time: e.time,
    });
    const postToday = (days[todayEt] ?? []).filter((e) => e.time === 'post').map(toItem);
    const preTomorrow = (days[tomorrowEt] ?? []).filter((e) => e.time === 'pre').map(toItem);
    if (postToday.length > 0 || preTomorrow.length > 0) {
      earningsScan = { reportingPostCloseToday: postToday, reportingPreOpenTomorrow: preTomorrow };
      appendAudit({
        kind: 'tick',
        data: {
          stage: 'earnings_scan',
          postCloseToday: postToday.length,
          preOpenTomorrow: preTomorrow.length,
        },
      });
    }
  }

  const round1 = await runNominations(
    cfg,
    {
      movers,
      mostActives,
      news,
      barsBySymbol: moverBars,
      ...(earningsScan ? { earnings: earningsScan } : {}),
    },
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

  // Broker state is needed for sizing AND for the same-day carryover merge
  // (held/ordered tickers), including on the empty-candidate path — a barren
  // refresh must not orphan positions opened from an earlier same-day pass.
  const broker = deps.broker ?? new AlpacaBroker(cfg);
  const [account, openOrders] = await Promise.all([broker.getAccount(), broker.getOpenOrders()]);
  const activeTickers = new Set([
    ...account.positions.map((p) => p.ticker.toUpperCase()),
    ...openOrders.map((o) => o.ticker.toUpperCase()),
  ]);
  const readPreviousSameDay = (): Thesis | null => {
    try {
      return readJsonIfExists<Thesis>(thesisPath(ymd, kind));
    } catch {
      return null; // corrupt previous file: refresh proceeds without carryover
    }
  };
  const withCarryover = (fresh: ThesisEntry[], degradedRefresh = false): ThesisEntry[] => {
    const previous = readPreviousSameDay();
    if (!previous) return fresh;
    const carried = carryoverEntries(previous.entries, fresh, activeTickers, degradedRefresh);
    if (carried.length > 0) {
      appendAudit({
        kind: 'tick',
        data: {
          stage: degradedRefresh ? 'degraded_refresh_carryover' : 'carried_entries',
          tickers: carried.map((e) => e.ticker),
          note: degradedRefresh
            ? 'verdict round degraded (>=2 analysts dropped): previous same-day entries preserved wholesale'
            : 'held/ordered entries preserved across same-day thesis refresh',
        },
      });
    }
    return [...fresh, ...carried];
  };

  if (candidateFile.candidates.length === 0) {
    const empty: Thesis = {
      date: ymd,
      kind,
      generatedAt: now.toISOString(),
      expiresAt,
      entries: withCarryover([]),
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
    // Verdict-round news optionally carries the stripped article BODY
    // (universe.news_content) — primary text beats headline+summary for
    // reading guidance language. Nomination-round news above is unchanged.
    md.getNews(
      50,
      candidateTickers,
      cfg.universe.news_content.enabled ? cfg.universe.news_content.max_chars : 0,
    ),
    md.getDailyBars(['SPY'], 260),
  ]);
  // The analyst summarizer (verdicts.ts summarizeBars) reduces high/low/avgVolume
  // over its WHOLE bar array into the LLM prompt, so it MUST see only the trailing
  // 25 bars (the historical default) — the 260-bar history is used ONLY for the
  // deterministic features and must never leak the 52-week extremes back into the
  // prompt. This keeps the verdict prompt byte-identical to before.
  const barsBySymbol = new Map([...featureBarsBySymbol].map(([sym, bars]) => [sym, bars.slice(-25)]));

  // SEC primary text (universe.edgar_content, flag-off): each candidate's
  // recent 8-K / press-release exhibit, fetched fail-open — a degraded ticker
  // just carries no filing text. Audited either way for coverage tracking.
  let filingsBySymbol: Map<string, { form: string; filed: string; text: string }> | undefined;
  if (cfg.universe.edgar_content.enabled) {
    const { filings, degraded } = await loadRecentFilings(
      candidateTickers,
      cfg.universe.edgar_content,
      now,
    );
    filingsBySymbol = filings;
    appendAudit({
      kind: 'tick',
      data: {
        stage: 'edgar_content',
        fetched: [...filings.keys()],
        degraded,
        note: 'fail-open: degraded tickers proceed without primary text',
      },
    });
  }

  const verdictData = {
    barsBySymbol,
    newsBySymbol: groupNewsBySymbol(candidateNews, candidateTickers),
    ...(filingsBySymbol ? { filingsBySymbol } : {}),
  };
  const verdictFile = await runVerdicts(cfg, candidateFile, verdictData, deps.llm);

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
    const mi: TickerMarketInfo =
      enrichedInfo.get(key) ?? { lastPrice: closes[closes.length - 1] ?? 0, avgDollarVolume20d: 0 };
    Object.assign(mi, computeTickerFeatures(bars, cfg));
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

  // Shadow-MODEL verdict round (model.shadow_analysts, deprecation bridge):
  // identical inputs, candidate model, never traded. Audit-only agreement
  // stats accumulate the continuity evidence for a future model swap. Any
  // failure is audited and ignored — the bridge must never block a thesis.
  if (cfg.model.shadow_analysts && cfg.model.shadow_analysts !== cfg.model.analysts) {
    try {
      const shadowCfg: Config = {
        ...cfg,
        model: { ...cfg.model, analysts: cfg.model.shadow_analysts, analysts_by_name: {} },
      };
      // Identical inputs to the primary round — that is the whole point.
      const shadowFile = await runVerdicts(shadowCfg, candidateFile, verdictData, deps.llm);
      writeJsonAtomic(verdictsShadowPath(ymd), shadowFile);
      appendAudit({
        kind: 'counterfactual',
        data: {
          note: 'SHADOW MODEL verdict round (deprecation bridge; not traded)',
          date: ymd,
          thesisKind: kind,
          model: cfg.model.shadow_analysts,
          agreement: verdictAgreement(verdictFile.verdicts, shadowFile.verdicts),
          droppedAnalysts: shadowFile.droppedAnalysts,
        },
      });
    } catch (err) {
      appendAudit({
        kind: 'error',
        data: {
          stage: 'shadow_model_verdicts',
          model: cfg.model.shadow_analysts,
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  const computed = computeThesisEntries(
    verdictFile.verdicts,
    enrichedInfo,
    account,
    cfg,
    regime,
    returnsByTicker,
  );

  // Shadow-mode evaluation of the flag-off signals (src/shadow.ts): what each
  // would have done to this thesis, params frozen at schema defaults, nothing
  // applied. Audit-only — this is the out-of-sample evidence the 50-trade
  // governance gate will read before any signal is enabled.
  const spyCloses = spyBars.map((b) => b.c);
  const shadowReg = shadowRegime(spyCloses, cfg);
  appendAudit({
    kind: 'counterfactual',
    data: {
      note: 'SHADOW book-level (flag-off, schema-default params)',
      date: ymd,
      thesisKind: kind,
      regime: {
        state: shadowReg.state,
        longScalar: shadowReg.longScalar,
        shortScalar: shadowReg.shortScalar,
        volScalar: shadowReg.volScalar,
        thresholdBump: shadowReg.thresholdBump,
      },
      portfolioTargetVolScalar: shadowPortfolioScalar(
        computed.entries,
        returnsByTicker,
        account.equity,
        cfg,
      ),
    },
  });
  for (const e of computed.entries) {
    const agreeing = verdictFile.verdicts
      .filter((v) => v.ticker.toUpperCase() === e.ticker && v.direction === e.direction)
      .map((v) => v.conviction);
    appendAudit({
      kind: 'counterfactual',
      data: {
        note: 'SHADOW signal evaluation (flag-off, schema-default params)',
        date: ymd,
        thesisKind: kind,
        ...shadowEntryRecord(e.ticker, e.direction, enrichedInfo.get(e.ticker), agreeing, cfg),
      },
    });
  }

  const narratives = await writeNarratives(cfg, computed.entries, verdictFile.verdicts, deps.llm);
  const entries: ThesisEntry[] = computed.entries.map((entry) => {
    const n = narratives.get(entry.ticker);
    return {
      ...entry,
      narrative: n?.narrative ?? '',
      invalidationConditions: n?.invalidationConditions ?? entry.invalidationConditions,
      // Structured exit plan: deterministic fallback (config hard stop +
      // horizon time-stop) with sanitized LLM levels on top. Emitted
      // unconditionally — enforcement is gated by exit_engine.enabled, so
      // on/off sweep cells share byte-identical LLM inputs AND thesis files.
      exit: mergedExitPlan(entry, n?.exit, cfg),
    };
  });

  const thesis: Thesis = {
    date: ymd,
    kind,
    generatedAt: now.toISOString(),
    expiresAt,
    entries: withCarryover(entries, verdictFile.droppedAnalysts.length >= 2),
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
