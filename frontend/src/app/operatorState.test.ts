import { describe, expect, it } from 'vitest';
import { configFixture, statusFixture } from '../test/fixtures';
import {
  applyPoll,
  createInitialOperatorState,
  type PollResults,
} from './operatorState';

function failure(error: string) {
  return { ok: false as const, error };
}

function results(overrides: Partial<PollResults> = {}): PollResults {
  const failed = failure('not supplied');
  return {
    status: failed,
    candidates: failed,
    thesis: failed,
    thesisRth: failed,
    verdicts: failed,
    positions: failed,
    orders: failed,
    audit: failed,
    config: failed,
    backtest: failed,
    ...overrides,
  };
}

describe('applyPoll', () => {
  it('advances full-success time only when every resource succeeds', () => {
    const all: PollResults = {
      status: { ok: true, value: statusFixture },
      candidates: { ok: true, value: null },
      thesis: { ok: true, value: null },
      thesisRth: { ok: true, value: null },
      verdicts: { ok: true, value: null },
      positions: { ok: true, value: { positions: [] } },
      orders: { ok: true, value: { orders: [] } },
      audit: { ok: true, value: [] },
      config: { ok: true, value: configFixture },
      backtest: { ok: true, value: null },
    };

    const next = applyPoll(createInitialOperatorState(), all, 1_000);

    expect(next.polling.lastFullSuccessAt).toBe(1_000);
    expect(next.polling.stale).toBe(false);
    expect(next.polling.connectivity).toBe('online');
  });

  it('retains last-known-good data and labels a partial refresh stale', () => {
    const initial = createInitialOperatorState();
    const seeded = {
      ...initial,
      data: { ...initial.data, status: statusFixture },
    };

    const next = applyPoll(seeded, results({
      status: failure('broker timeout'),
      config: { ok: true, value: configFixture },
    }), 2_000);

    expect(next.data.status).toEqual(statusFixture);
    expect(next.polling.resources.status.state).toBe('stale');
    expect(next.polling.stale).toBe(true);
    expect(next.polling.lastFullSuccessAt).toBeNull();
  });

  it('marks all-rejected polls offline and recovers on a later success', () => {
    const offline = applyPoll(createInitialOperatorState(), results(), 3_000);
    expect(offline.polling.connectivity).toBe('offline');

    const recovered = applyPoll(offline, results({
      status: { ok: true, value: statusFixture },
    }), 4_000);
    expect(recovered.polling.connectivity).toBe('online');
    expect(recovered.polling.stale).toBe(true);
  });
});
