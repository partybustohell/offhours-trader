// Writes a coherent demo dataset into out/ for today's ET date so the
// dashboard renders without any API keys. Idempotent: overwrites prior seed.
import fs from 'node:fs';
import type { AuditEvent, CandidateFile, Thesis, VerdictFile } from '../src/types.js';
import {
  auditPath,
  candidatesPath,
  ensureOut,
  thesisPath,
  verdictsPath,
  writeJsonAtomic,
} from '../src/paths.js';
import { nowET } from '../src/clock.js';
// state.js deliberately not imported: seeding must never alter halt state
// import { clearHalt } from '../src/state.js';

const today = nowET().ymd;
const now = new Date();

const candidates: CandidateFile = {
  date: today,
  candidates: [
    {
      ticker: 'NVDA',
      nominatedBy: [
        { analyst: 'fundamental', reason: 'Data-center revenue reaccelerating; guidance raised twice this year' },
        { analyst: 'technical', reason: 'Breakout above 30-day range on rising volume' },
        { analyst: 'sentiment', reason: 'Post-close upgrade cycle dominating headlines' },
      ],
      lastPrice: 176.42,
      avgDollarVolume20d: 32_000_000_000,
    },
    {
      ticker: 'TSLA',
      nominatedBy: [
        { analyst: 'bear', reason: 'Crowded long after delivery beat; positioning looks fragile' },
        { analyst: 'technical', reason: 'Failed retest of 250 resistance; momentum rolling over' },
        { analyst: 'sentiment', reason: 'Headline flow turned negative on margin guidance' },
      ],
      lastPrice: 242.87,
      avgDollarVolume20d: 21_000_000_000,
    },
    {
      ticker: 'AMD',
      nominatedBy: [
        { analyst: 'fundamental', reason: 'Server CPU share gains not reflected in valuation' },
        { analyst: 'bear', reason: 'AI accelerator narrative stale; downgrade risk into earnings' },
      ],
      lastPrice: 138.55,
      avgDollarVolume20d: 8_900_000_000,
    },
    {
      ticker: 'PLTR',
      nominatedBy: [
        { analyst: 'macro', reason: 'Defense budget tailwind from appropriations headlines' },
        { analyst: 'sentiment', reason: 'Contract-win chatter across newswires this week' },
      ],
      lastPrice: 64.3,
      avgDollarVolume20d: 4_500_000_000,
    },
    {
      ticker: 'SNOW',
      nominatedBy: [
        { analyst: 'fundamental', reason: 'Consumption trends stabilizing per management commentary' },
      ],
      lastPrice: 189.12,
      avgDollarVolume20d: 1_100_000_000,
    },
  ],
  rejected: [
    { ticker: 'GNS', reason: 'price below min_price' },
    { ticker: 'FFIE', reason: 'dollar volume below min_avg_dollar_volume' },
    { ticker: 'ZZZT', reason: 'no market data' },
  ],
};

const verdicts: VerdictFile = {
  date: today,
  droppedAnalysts: [],
  verdicts: [
    {
      analyst: 'fundamental',
      ticker: 'NVDA',
      direction: 'long',
      conviction: 0.85,
      horizon: 'weeks',
      evidence: [
        'Data-center segment grew 94% YoY with margin expansion',
        'Forward P/E below 3-year median despite raised guidance',
      ],
      invalidation_conditions: [
        'Guidance cut or delay in next-gen accelerator shipments',
        'Close below 165 on above-average volume',
      ],
    },
    {
      analyst: 'technical',
      ticker: 'NVDA',
      direction: 'long',
      conviction: 0.8,
      horizon: 'days',
      evidence: [
        'Cleared 30-day consolidation high at 172 on 1.6x average volume',
        'Higher lows since early June; 20-day MA rising',
      ],
      invalidation_conditions: ['Close below 170 breakout level'],
    },
    {
      analyst: 'sentiment',
      ticker: 'NVDA',
      direction: 'long',
      conviction: 0.9,
      horizon: 'days',
      evidence: [
        'Three sell-side upgrades in the last two sessions',
        'Headline tone strongly positive after partner capex announcements',
      ],
      invalidation_conditions: ['Negative supply-chain headline from a major partner'],
    },
    {
      analyst: 'bear',
      ticker: 'TSLA',
      direction: 'short',
      conviction: 0.85,
      horizon: 'days',
      evidence: [
        'Delivery beat already fully priced; call-skew at 6-month high',
        'Margin guidance walked back on the analyst call',
      ],
      invalidation_conditions: [
        'Close above 252 invalidates distribution pattern',
        'Positive regulatory ruling on robotaxi program',
      ],
    },
    {
      analyst: 'technical',
      ticker: 'TSLA',
      direction: 'short',
      conviction: 0.7,
      horizon: 'days',
      evidence: [
        'Rejected at 250 twice; lower highs on declining volume',
        'RSI divergence against last week high',
      ],
      invalidation_conditions: ['Two consecutive closes above 250'],
    },
    {
      analyst: 'sentiment',
      ticker: 'TSLA',
      direction: 'short',
      conviction: 0.65,
      horizon: 'days',
      evidence: ['Headline flow negative on margin guidance and price cuts'],
      invalidation_conditions: ['Headline tone reverses on new product announcement'],
    },
    {
      analyst: 'fundamental',
      ticker: 'AMD',
      direction: 'long',
      conviction: 0.7,
      horizon: 'weeks',
      evidence: ['Server CPU share gains continuing; datacenter backlog growing'],
      invalidation_conditions: ['Hyperscaler capex guidance cut'],
    },
    {
      analyst: 'technical',
      ticker: 'AMD',
      direction: 'short',
      conviction: 0.72,
      horizon: 'days',
      evidence: ['Broke below 50-day MA on rising volume; failed retest at 142'],
      invalidation_conditions: ['Reclaim of 142 on volume'],
    },
    {
      analyst: 'sentiment',
      ticker: 'AMD',
      direction: 'long',
      conviction: 0.65,
      horizon: 'days',
      evidence: ['Positive coverage of new accelerator benchmarks'],
      invalidation_conditions: ['Benchmark claims disputed by third parties'],
    },
    {
      analyst: 'bear',
      ticker: 'AMD',
      direction: 'short',
      conviction: 0.6,
      horizon: 'weeks',
      evidence: ['AI accelerator roadmap slipping vs competition; consensus too high'],
      invalidation_conditions: ['Major hyperscaler design win announced'],
    },
    {
      analyst: 'macro',
      ticker: 'SNOW',
      direction: 'none',
      conviction: 0.2,
      horizon: 'weeks',
      evidence: ['No clear macro driver; software multiples rate-sensitive both ways'],
      invalidation_conditions: [],
    },
    {
      analyst: 'fundamental',
      ticker: 'SNOW',
      direction: 'none',
      conviction: 0.3,
      horizon: 'weeks',
      evidence: ['Consumption stabilizing but valuation already reflects recovery'],
      invalidation_conditions: [],
    },
  ],
};

// NVDA long band: 176.42 * [0.97, 1.01]; TSLA short band: 242.87 * [0.99, 1.03]
// expiresAt is deliberately in the PAST: this thesis is fabricated demo data
// and must never be actionable — loadUnexpiredThesis rejects expired theses,
// so a scheduled executor tick cannot trade on it.
const thesis: Thesis = {
  date: today,
  kind: 'offhours',
  generatedAt: now.toISOString(),
  expiresAt: new Date(now.getTime() - 60_000).toISOString(),
  entries: [
    {
      ticker: 'NVDA',
      direction: 'long',
      weightedConviction: 0.85,
      limitBand: { low: 171.13, high: 178.18 },
      targetNotionalUsd: 1707.14,
      narrative:
        'Three analysts independently converge on NVDA long: fundamentals show data-center reacceleration with raised guidance, the tape confirms a clean breakout above the 30-day range on expanding volume, and sentiment has flipped decisively positive with a cluster of upgrades. No responding analyst offered a short case. The trade risks a crowded entry after the breakout, so the band caps chase at 1% above reference while allowing a 3% pullback fill. Position is sized to conviction under the per-order notional cap.',
      invalidationConditions: [
        'Guidance cut or delay in next-gen accelerator shipments',
        'Close below 165 on above-average volume',
        'Close below 170 breakout level',
        'Negative supply-chain headline from a major partner',
      ],
    },
    {
      ticker: 'TSLA',
      direction: 'short',
      weightedConviction: 0.74,
      limitBand: { low: 240.44, high: 250.16 },
      targetNotionalUsd: 1486.67,
      narrative:
        'The bear desk leads a short thesis on TSLA: the delivery beat is fully priced with call-skew at extremes, and management walked back margin guidance on the call. Technicals agree, showing a double rejection at 250 with fading volume, and headline tone has turned negative on price cuts. Fundamental abstained rather than defending the long side. The short band mirrors entry discipline: no chasing more than 1% below reference, exits invalidated on strength above 252.',
      invalidationConditions: [
        'Close above 252 invalidates distribution pattern',
        'Positive regulatory ruling on robotaxi program',
        'Two consecutive closes above 250',
        'Headline tone reverses on new product announcement',
      ],
    },
  ],
  skipped: [
    { ticker: 'SNOW', reason: 'quorum' },
    { ticker: 'AMD', reason: 'disagreement' },
  ],
};

const auditEvents: Omit<AuditEvent, 'ts'>[] = [
  { kind: 'tick', data: { stage: 'pipeline_start', date: today } },
  {
    kind: 'nomination',
    data: { analyst: 'fundamental', tickers: ['NVDA', 'AMD', 'SNOW'] },
  },
  { kind: 'nomination', data: { analyst: 'technical', tickers: ['NVDA', 'TSLA'] } },
  { kind: 'nomination', data: { analyst: 'bear', tickers: ['TSLA', 'AMD'] } },
  {
    kind: 'candidates',
    data: { date: today, kept: 5, rejected: 3, tickers: ['NVDA', 'TSLA', 'AMD', 'PLTR', 'SNOW'] },
  },
  {
    kind: 'verdict',
    data: { analyst: 'fundamental', ticker: 'NVDA', direction: 'long', conviction: 0.85 },
  },
  {
    kind: 'verdict',
    data: { analyst: 'bear', ticker: 'TSLA', direction: 'short', conviction: 0.85 },
  },
  {
    kind: 'verdict',
    data: { analyst: 'macro', ticker: 'SNOW', direction: 'none', conviction: 0.2 },
  },
  {
    kind: 'thesis',
    data: { date: today, entries: ['NVDA', 'TSLA'], skipped: ['SNOW', 'AMD'] },
  },
  {
    kind: 'tick',
    data: { stage: 'executor_tick', session: 'afterhours', thesisDate: today },
  },
  {
    kind: 'proposed_order',
    data: {
      ticker: 'NVDA',
      side: 'buy',
      qty: 9,
      limitPrice: 177.55,
      intent: 'entry',
      reason: 'entry conditions hold; judge confirmed',
    },
  },
  {
    kind: 'order_placed',
    data: {
      id: 'demo-a1b2c3',
      ticker: 'NVDA',
      side: 'buy',
      qty: 9,
      limitPrice: 177.55,
      status: 'accepted',
    },
  },
  {
    kind: 'proposed_order',
    data: {
      ticker: 'TSLA',
      side: 'sell',
      qty: 6,
      limitPrice: 241.1,
      intent: 'entry',
      reason: 'short entry within band',
    },
  },
  {
    kind: 'order_rejected',
    data: {
      ticker: 'TSLA',
      side: 'sell',
      reasons: ['exceeds max daily deployment', 'duplicate open order'],
    },
  },
  {
    kind: 'tick',
    data: { stage: 'executor_tick_summary', placed: 1, rejected: 1, skippedEntries: 0 },
  },
];

ensureOut();
writeJsonAtomic(candidatesPath(today), candidates);
writeJsonAtomic(verdictsPath(today), verdicts);
writeJsonAtomic(thesisPath(today), thesis);

// Spread timestamps over the preceding ~100 minutes, oldest first.
const stepMs = 7 * 60_000;
const lines = auditEvents.map((event, i) => {
  const ts = new Date(now.getTime() - (auditEvents.length - i) * stepMs).toISOString();
  const stamped: AuditEvent = { ts, kind: event.kind, data: event.data };
  return JSON.stringify(stamped);
});
fs.writeFileSync(auditPath(today), `${lines.join('\n')}\n`);

// Never touch out/state.json: a tripped kill switch or manual halt must
// survive demo seeding ("until manually reset").

console.log(`seeded demo data for ${today}:`);
console.log(`  ${candidatesPath(today)}`);
console.log(`  ${verdictsPath(today)}`);
console.log(`  ${thesisPath(today)}`);
console.log(`  ${auditPath(today)} (${auditEvents.length} events)`);
console.log('  (thesis is pre-expired; the executor will not act on demo data)');
