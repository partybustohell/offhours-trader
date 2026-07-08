import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { LlmClient } from '../src/agents/llm.js';
import { judgeTick, type JudgeInput } from '../src/agents/judge.js';
import type { NewsItem } from '../src/agents/nominate.js';
import { ConfigSchema } from '../src/config.js';
import type { Position, QuoteSnapshot, ThesisEntry } from '../src/types.js';
import {
  judgeCanonicalKey,
  makeCachingClient,
  totalsUsage,
} from '../src/backtest/llm-cache.js';

// Unit tests for the two-level LLM disk cache. The inner client is a mock
// that records calls and returns canned tool_use responses; nothing touches
// the network and everything writes into a per-test temp dir (the production
// default DATA_DIR anchor is never used here).

type CreateParams = Anthropic.Messages.MessageCreateParamsNonStreaming;

function toolUseMessage(
  model: string,
  toolName: string,
  input: unknown,
  usage: { input_tokens: number; output_tokens: number },
): Anthropic.Messages.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'tool_use', id: 'tu_1', name: toolName, input }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage,
  } as unknown as Anthropic.Messages.Message;
}

function makeInner(
  respond: (params: CreateParams) => Anthropic.Messages.Message = (params) =>
    toolUseMessage(params.model, 'submit_thing', { ok: true }, { input_tokens: 100, output_tokens: 20 }),
): { calls: CreateParams[]; client: LlmClient } {
  const calls: CreateParams[] = [];
  return {
    calls,
    client: {
      messages: {
        create: async (params) => {
          calls.push(params);
          return respond(params);
        },
      },
    },
  };
}

function params(over: Partial<CreateParams> = {}): CreateParams {
  return {
    model: 'claude-sonnet-5',
    max_tokens: 1000,
    system: 'SYSTEM PROMPT',
    messages: [{ role: 'user', content: 'analyze this' }],
    tools: [
      { name: 'submit_thing', input_schema: { type: 'object' } as Anthropic.Messages.Tool.InputSchema },
    ],
    tool_choice: { type: 'tool', name: 'submit_thing' },
    ...over,
  };
}

const toolInput = (msg: Anthropic.Messages.Message): unknown => {
  const block = msg.content.find((b) => b.type === 'tool_use');
  return block && block.type === 'tool_use' ? block.input : undefined;
};

// Judge fixtures: entries/positions differing ONLY in sizing fields must map
// to the same canonical entry.
const cfg = ConfigSchema.parse({});
const quote: QuoteSnapshot = {
  ticker: 'NVDA',
  bid: 100,
  ask: 100.1,
  bidSize: 5,
  askSize: 4,
  last: 100.05,
  asOf: '2026-03-04T22:15:00.000Z',
};
const headlines: NewsItem[] = [
  {
    headline: 'NVDA ships new part',
    summary: 'details',
    symbols: ['NVDA'],
    created_at: '2026-03-04T21:00:00Z',
    source: 'wire',
  },
];
function entryWith(over: Partial<ThesisEntry> = {}): ThesisEntry {
  return {
    ticker: 'NVDA',
    direction: 'long',
    weightedConviction: 0.7,
    limitBand: { low: 97, high: 101 },
    targetNotionalUsd: 1330.43,
    narrative: 'the story',
    invalidationConditions: ['NVDA closes below 95'],
    ...over,
  };
}
function positionWith(over: Partial<Position> = {}): Position {
  return {
    ticker: 'NVDA',
    qty: 13,
    avgEntryPrice: 100.1,
    marketValue: 1301.3,
    unrealizedPl: 0,
    side: 'long',
    ...over,
  };
}
const judgeInner = () =>
  makeInner((p) =>
    toolUseMessage(
      p.model,
      'submit_execution_decision',
      { proceed: true, exitPosition: false, reasons: ['ok'] },
      { input_tokens: 500, output_tokens: 30 },
    ),
  );

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-cache-test-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('exact cache', () => {
  it('misses then hits: identical call served from disk without touching inner', async () => {
    const { calls, client } = makeInner();
    const caching = makeCachingClient(client, 'exact', dir);
    const first = await caching.messages.create(params());
    expect(calls).toHaveLength(1);
    const second = await caching.messages.create(params());
    expect(calls).toHaveLength(1);
    expect(toolInput(second)).toEqual(toolInput(first));
    // persisted under the exact level
    expect(fs.readdirSync(path.join(dir, 'exact'))).toHaveLength(1);
  });

  it('any of model/system/toolName/user changing is a miss', async () => {
    const { calls, client } = makeInner();
    const caching = makeCachingClient(client, 'exact', dir);
    await caching.messages.create(params());
    await caching.messages.create(params({ model: 'claude-fable-5' }));
    await caching.messages.create(params({ system: 'OTHER SYSTEM' }));
    await caching.messages.create(
      params({
        tools: [{ name: 'submit_other', input_schema: { type: 'object' } as Anthropic.Messages.Tool.InputSchema }],
        tool_choice: { type: 'tool', name: 'submit_other' },
      }),
    );
    await caching.messages.create(params({ messages: [{ role: 'user', content: 'different' }] }));
    expect(calls).toHaveLength(5);
    expect(fs.readdirSync(path.join(dir, 'exact'))).toHaveLength(5);
  });

  it('survives across client instances (disk, not memory)', async () => {
    const { calls, client } = makeInner();
    await makeCachingClient(client, 'exact', dir).messages.create(params());
    const again = await makeCachingClient(client, 'exact', dir).messages.create(params());
    expect(calls).toHaveLength(1);
    expect(toolInput(again)).toEqual({ ok: true });
  });
});

describe('canonical judge cache', () => {
  const mode = { canonical: judgeCanonicalKey };

  it('two judge prompts differing only in sizing fields hit the same entry', async () => {
    const { calls, client } = judgeInner();
    const caching = makeCachingClient(client, mode, dir);
    const a: JudgeInput = { entry: entryWith(), quote, headlines, position: positionWith() };
    const b: JudgeInput = {
      // differs ONLY in weightedConviction / targetNotionalUsd / limitBand / position qty
      entry: entryWith({
        weightedConviction: 0.42,
        targetNotionalUsd: 500,
        limitBand: { low: 90, high: 95 },
      }),
      quote,
      headlines,
      position: positionWith({ qty: 5, avgEntryPrice: 99, marketValue: 495 }),
    };
    const first = await judgeTick(cfg, a, caching);
    expect(first).toEqual({ proceed: true, exitPosition: false, reasons: ['ok'] });
    expect(calls).toHaveLength(1);
    const second = await judgeTick(cfg, b, caching);
    expect(second).toEqual(first);
    expect(calls).toHaveLength(1); // served from the canonical entry
    expect(fs.readdirSync(path.join(dir, 'canonical'))).toHaveLength(1);
  });

  it('decision-relevant fields are part of the key', async () => {
    const { calls, client } = judgeInner();
    const caching = makeCachingClient(client, mode, dir);
    const base: JudgeInput = { entry: entryWith(), quote, headlines, position: positionWith() };
    await judgeTick(cfg, base, caching);
    await judgeTick(cfg, { ...base, entry: entryWith({ ticker: 'COIN' }) }, caching);
    await judgeTick(
      cfg,
      { ...base, entry: entryWith({ invalidationConditions: ['guidance walked back'] }) },
      caching,
    );
    await judgeTick(cfg, { ...base, position: undefined }, caching); // side none vs long
    await judgeTick(cfg, { ...base, quote: { ...quote, asOf: '2026-03-04T22:30:00.000Z' } }, caching);
    expect(calls).toHaveLength(5);
  });

  it('non-judge calls in canonical mode fall through to the exact level', async () => {
    const { calls, client } = makeInner();
    const caching = makeCachingClient(client, mode, dir);
    await caching.messages.create(params());
    await caching.messages.create(params());
    expect(calls).toHaveLength(1);
    expect(fs.readdirSync(path.join(dir, 'exact'))).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, 'canonical'))).toBe(false);
  });

  it('judgeCanonicalKey returns null for non-judge or malformed prompts', () => {
    expect(judgeCanonicalKey(params())).toBeNull();
    // right tool name, wrong message shape
    expect(
      judgeCanonicalKey(
        params({
          tools: [
            {
              name: 'submit_execution_decision',
              input_schema: { type: 'object' } as Anthropic.Messages.Tool.InputSchema,
            },
          ],
          tool_choice: { type: 'tool', name: 'submit_execution_decision' },
          messages: [{ role: 'user', content: 'not a judge prompt' }],
        }),
      ),
    ).toBeNull();
  });
});

describe('corruption recovery', () => {
  it('a corrupt cache file is a miss and gets overwritten with a valid entry', async () => {
    const { calls, client } = makeInner();
    const caching = makeCachingClient(client, 'exact', dir);
    await caching.messages.create(params());
    const exactDir = path.join(dir, 'exact');
    const file = path.join(exactDir, fs.readdirSync(exactDir)[0]!);
    fs.writeFileSync(file, 'not json {{{');
    expect(totalsUsage(dir)).toEqual({}); // corrupt file skipped in totals
    const recovered = await caching.messages.create(params());
    expect(calls).toHaveLength(2); // refetched
    expect(toolInput(recovered)).toEqual({ ok: true });
    // overwritten in place: next identical call is a hit again
    await caching.messages.create(params());
    expect(calls).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).usage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
    });
  });
});

describe('totalsUsage', () => {
  it('sums calls and tokens per model across both levels; hits add nothing', async () => {
    const usageByModel: Record<string, { input_tokens: number; output_tokens: number }> = {
      'claude-sonnet-5': { input_tokens: 100, output_tokens: 20 },
      'claude-fable-5': { input_tokens: 300, output_tokens: 50 },
    };
    const { client } = makeInner((p) =>
      toolUseMessage(p.model, 'submit_thing', { ok: true }, usageByModel[p.model]!),
    );
    const caching = makeCachingClient(client, { canonical: judgeCanonicalKey }, dir);
    // two exact-level sonnet calls + one exact-level fable call
    await caching.messages.create(params());
    await caching.messages.create(params({ messages: [{ role: 'user', content: 'second' }] }));
    await caching.messages.create(params({ model: 'claude-fable-5' }));
    // one canonical-level judge call (executor model is sonnet)
    const { client: jClient } = judgeInner();
    const judgeCaching = makeCachingClient(jClient, { canonical: judgeCanonicalKey }, dir);
    await judgeTick(cfg, { entry: entryWith(), quote, headlines }, judgeCaching);
    // repeats are hits and must not change the totals
    await caching.messages.create(params());
    await judgeTick(cfg, { entry: entryWith(), quote, headlines }, judgeCaching);

    expect(totalsUsage(dir)).toEqual({
      'claude-sonnet-5': { calls: 3, input_tokens: 700, output_tokens: 70 },
      'claude-fable-5': { calls: 1, input_tokens: 300, output_tokens: 50 },
    });
  });

  it('returns {} for a dir with no cache levels', () => {
    expect(totalsUsage(path.join(dir, 'nope'))).toEqual({});
  });
});
