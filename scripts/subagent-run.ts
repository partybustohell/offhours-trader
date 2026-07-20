// Offline run harness: executes the real pipeline stages with agent outputs
// supplied from the outside (e.g. produced by Claude Code subagents playing
// the analyst/synthesizer/judge roles) instead of calls to the Anthropic API.
// The deterministic layers — candidate filter, synthesis math, risk gate,
// session/lock gates — are the production functions, not mirrors.
//
// Usage: tsx scripts/subagent-run.ts <candidates|synthesize|finalize> <input.json>
import 'dotenv/config';
import fs from 'node:fs';
import type Anthropic from '@anthropic-ai/sdk';
import type {
  AccountSnapshot,
  AnalystName,
  AnalystNominations,
  BrokerOrder,
  ProposedOrder,
  QuoteSnapshot,
  Thesis,
  Verdict,
  VerdictFile,
} from '../src/types.js';
import { loadConfig } from '../src/config.js';
import { nowET } from '../src/clock.js';
import { appendAudit } from '../src/audit.js';
import { candidatesPath, thesisPath, verdictsPath, writeJsonAtomic } from '../src/paths.js';
import { buildCandidates, type TickerMarketInfo } from '../src/candidates.js';
import { computeThesisEntries, thesisExpiry } from '../src/synthesis.js';
import { runTick } from '../src/executor-loop.js';
import type { BrokerClient } from '../src/broker/client.js';
import type { AlpacaMarketData } from '../src/broker/marketdata.js';
import type { LlmClient } from '../src/agents/llm.js';
import type { ExecutionDecision } from '../src/agents/judge.js';

interface CandidatesInput {
  nominations: AnalystNominations[];
  droppedAnalysts?: AnalystName[];
  marketInfo: Record<string, TickerMarketInfo>;
}

interface SynthesizeInput {
  verdicts: Verdict[];
  droppedAnalysts?: AnalystName[];
  marketInfo: Record<string, TickerMarketInfo>;
  equity?: number;
}

interface FinalizeInput {
  computed: {
    entries: (Omit<Thesis['entries'][number], 'narrative'> & { narrative?: string })[];
    skipped: { ticker: string; reason: string }[];
  };
  narratives: Record<string, { narrative: string; invalidationConditions: string[] }>;
  quotes: QuoteSnapshot[];
  decisions: Record<string, ExecutionDecision>;
  equity?: number;
}

const [cmd, inputFile] = process.argv.slice(2);
if (!cmd || !inputFile) {
  console.error('usage: tsx scripts/subagent-run.ts <candidates|synthesize|finalize> <input.json>');
  process.exit(1);
}
const input = JSON.parse(fs.readFileSync(inputFile, 'utf8')) as unknown;
const cfg = loadConfig();
const ymd = nowET().ymd;

function asMap(info: Record<string, TickerMarketInfo>): Map<string, TickerMarketInfo> {
  return new Map(Object.entries(info).map(([k, v]) => [k.toUpperCase(), v]));
}

async function main(): Promise<void> {
  if (cmd === 'candidates') {
    const inp = input as CandidatesInput;
    appendAudit({ kind: 'tick', data: { stage: 'pipeline_start', date: ymd, mode: cfg.mode, runner: 'subagent-harness' } });
    for (const an of inp.nominations) appendAudit({ kind: 'nomination', data: an });
    for (const analyst of inp.droppedAnalysts ?? []) {
      appendAudit({ kind: 'nomination', data: { analyst, dropped: true } });
    }
    const file = buildCandidates(inp.nominations, asMap(inp.marketInfo), cfg, ymd);
    writeJsonAtomic(candidatesPath(ymd), file);
    appendAudit({
      kind: 'candidates',
      data: {
        date: ymd,
        candidates: file.candidates.map((c) => c.ticker),
        rejected: file.rejected,
      },
    });
    console.log(JSON.stringify(file));
    return;
  }

  if (cmd === 'synthesize') {
    const inp = input as SynthesizeInput;
    const vf: VerdictFile = {
      date: ymd,
      verdicts: inp.verdicts,
      droppedAnalysts: inp.droppedAnalysts ?? [],
    };
    writeJsonAtomic(verdictsPath(ymd), vf);
    for (const v of inp.verdicts) appendAudit({ kind: 'verdict', data: v });
    const equity = inp.equity ?? 100_000;
    const account: AccountSnapshot = { equity, cash: equity, positions: [] };
    const computed = computeThesisEntries(inp.verdicts, asMap(inp.marketInfo), account, cfg);
    console.log(JSON.stringify(computed));
    return;
  }

  if (cmd === 'finalize') {
    const inp = input as FinalizeInput;
    const entries = inp.computed.entries.map((e) => {
      const t = e.ticker.toUpperCase();
      const n = inp.narratives[t];
      return {
        ...e,
        narrative: n?.narrative ?? '',
        invalidationConditions:
          n?.invalidationConditions && n.invalidationConditions.length > 0
            ? n.invalidationConditions
            : e.invalidationConditions,
      };
    });
    const thesis: Thesis = {
      date: ymd,
      kind: 'offhours',
      generatedAt: new Date().toISOString(),
      expiresAt: thesisExpiry(ymd),
      entries,
      skipped: inp.computed.skipped,
    };
    writeJsonAtomic(thesisPath(ymd), thesis);
    appendAudit({
      kind: 'thesis',
      data: { date: ymd, entries: entries.map((e) => e.ticker), skipped: inp.computed.skipped },
    });

    const equity = inp.equity ?? 100_000;
    let placed = 0;
    const broker: BrokerClient = {
      getAccount: async () => ({ equity, cash: equity, positions: [] }),
      getDailyPl: async () => 0,
      getOpenOrders: async () => [],
      getTodayOrders: async () => [],
      cancelOrdersFor: async (): Promise<void> => {},
      getAsset: async () => ({ shortable: true, easyToBorrow: true }),
      placeLimitOrder: async (o: ProposedOrder): Promise<BrokerOrder> => {
        placed++;
        return {
          id: `subagent-dry-${placed}`,
          ticker: o.ticker,
          side: o.side,
          qty: o.qty,
          limitPrice: o.limitPrice,
          status: 'dry_run',
          submittedAt: new Date().toISOString(),
          clientOrderId: `${o.intent}-subagent-${placed}`,
          filledQty: 0,
        };
      },
    };
    const marketData = {
      getLatestQuotes: async () => inp.quotes,
      getNews: async () => [],
    } as unknown as AlpacaMarketData;
    const llm: LlmClient = {
      messages: {
        create: async (params) => {
          const user = JSON.stringify(params.messages);
          const sym = Object.keys(inp.decisions).find((s) =>
            user.includes(`\\"ticker\\":\\"${s.toUpperCase()}\\"`) || user.includes(`"ticker":"${s.toUpperCase()}"`),
          );
          const decision: ExecutionDecision =
            (sym ? inp.decisions[sym] : undefined) ?? {
              proceed: false,
              exitPosition: false,
              reasons: ['no subagent decision available'],
            };
          return {
            content: [
              { type: 'tool_use', id: 'subagent', name: 'submit_execution_decision', input: decision },
            ],
          } as unknown as Anthropic.Messages.Message;
        },
      },
    };
    // Executor gates only open in extended hours; pin the tick to today's
    // after-hours window so the run exercises the real session gate.
    const forcedNow = new Date(`${ymd}T16:30:00-04:00`);
    await runTick({ cfg, broker, marketData, llm, now: forcedNow });
    console.log(JSON.stringify({ tick: 'complete', ordersPlaced: placed }));
    return;
  }

  console.error(`unknown subcommand: ${cmd}`);
  process.exit(1);
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
