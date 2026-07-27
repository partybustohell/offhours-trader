import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../src/config.js';
import type { LlmClient } from '../src/agents/llm.js';
import type { QuoteSnapshot, ThesisEntry } from '../src/types.js';

// judge.ts -> paths.ts resolves OUT_DIR from process.cwd() at import time, so
// each test chdirs into a fresh temp dir and re-imports the module graph
// (same pattern as the executor tests).
let judgeTick: (typeof import('../src/agents/judge.js'))['judgeTick'];
let dir: string;
const originalCwd = process.cwd();

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offhours-judge-cache-'));
  process.chdir(dir);
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  vi.resetModules();
  ({ judgeTick } = await import('../src/agents/judge.js'));
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(dir, { recursive: true, force: true });
});

function countingClient(
  calls: { n: number },
  decision: Record<string, unknown> = { proceed: true, exitPosition: false, reasons: ['ok'] },
): LlmClient {
  return {
    messages: {
      create: async () => {
        calls.n += 1;
        return {
          content: [{ type: 'tool_use', id: 't1', name: 'submit_execution_decision', input: decision }],
        } as never;
      },
    },
  };
}

const entry: ThesisEntry = {
  ticker: 'GS',
  direction: 'long',
  weightedConviction: 0.6,
  limitBand: { low: 97, high: 103 },
  targetNotionalUsd: 1000,
  narrative: 'earnings re-rating',
  invalidationConditions: ['closes below 95'],
  horizon: 'days',
};

const quoteAt = (bid: number): QuoteSnapshot => ({
  ticker: 'GS',
  bid,
  ask: bid + 0.1,
  bidSize: 100,
  askSize: 100,
  last: bid + 0.05,
  asOf: '2026-07-15T13:00:00Z',
});

const headline = {
  headline: 'GS beats',
  summary: 's',
  symbols: ['GS'],
  created_at: '2026-07-15T12:00:00Z',
  source: 'wire',
};

describe('judge decision cache', () => {
  it('returns the cached decision for identical inputs and ignores the quote', async () => {
    const cfg = ConfigSchema.parse({ mode: 'paper', judge_cache: { enabled: true } });
    const calls = { n: 0 };
    const client = countingClient(calls);
    const d1 = await judgeTick(cfg, { entry, quote: quoteAt(100), headlines: [] }, client);
    const d2 = await judgeTick(cfg, { entry, quote: quoteAt(101.5), headlines: [] }, client);
    expect(calls.n).toBe(1); // second call served from cache despite the new quote
    expect(d2).toEqual(d1);
    expect(fs.existsSync(path.join(dir, 'out', 'judge-cache.json'))).toBe(true);
  });

  it('a new headline busts the cache', async () => {
    const cfg = ConfigSchema.parse({ mode: 'paper', judge_cache: { enabled: true } });
    const calls = { n: 0 };
    const client = countingClient(calls);
    await judgeTick(cfg, { entry, quote: quoteAt(100), headlines: [] }, client);
    await judgeTick(cfg, { entry, quote: quoteAt(100), headlines: [headline] }, client);
    expect(calls.n).toBe(2);
  });

  it('position side is part of the key (entry check vs held-position check)', async () => {
    const cfg = ConfigSchema.parse({ mode: 'paper', judge_cache: { enabled: true } });
    const calls = { n: 0 };
    const client = countingClient(calls);
    await judgeTick(cfg, { entry, quote: quoteAt(100), headlines: [] }, client);
    await judgeTick(
      cfg,
      {
        entry,
        quote: quoteAt(100),
        headlines: [],
        position: { ticker: 'GS', qty: 10, avgEntryPrice: 100, marketValue: 1000, unrealizedPl: 0, side: 'long' },
      },
      client,
    );
    expect(calls.n).toBe(2);
  });

  it('disabled (default): every call reaches the LLM', async () => {
    const cfg = ConfigSchema.parse({ mode: 'paper' });
    const calls = { n: 0 };
    const client = countingClient(calls);
    await judgeTick(cfg, { entry, quote: quoteAt(100), headlines: [] }, client);
    await judgeTick(cfg, { entry, quote: quoteAt(100), headlines: [] }, client);
    expect(calls.n).toBe(2);
    expect(fs.existsSync(path.join(dir, 'out', 'judge-cache.json'))).toBe(false);
  });

  it('an LLM failure is never cached — the next tick retries', async () => {
    const cfg = ConfigSchema.parse({ mode: 'paper', judge_cache: { enabled: true } });
    const failing: LlmClient = {
      messages: {
        create: async () => {
          throw new Error('boom');
        },
      },
    };
    const failed = await judgeTick(cfg, { entry, quote: quoteAt(100), headlines: [] }, failing);
    expect(failed).toEqual({ proceed: false, exitPosition: false, reasons: ['judge unavailable'] });
    const calls = { n: 0 };
    const good = await judgeTick(cfg, { entry, quote: quoteAt(100), headlines: [] }, countingClient(calls));
    expect(calls.n).toBe(1); // not served from a cached failure
    expect(good.proceed).toBe(true);
  });

  it('a corrupt cache file degrades to a miss', async () => {
    const cfg = ConfigSchema.parse({ mode: 'paper', judge_cache: { enabled: true } });
    fs.writeFileSync(path.join(dir, 'out', 'judge-cache.json'), '{not json');
    const calls = { n: 0 };
    const d = await judgeTick(cfg, { entry, quote: quoteAt(100), headlines: [] }, countingClient(calls));
    expect(calls.n).toBe(1);
    expect(d.proceed).toBe(true);
  });
});
