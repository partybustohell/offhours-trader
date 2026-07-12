import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../api';
import { statusFixture } from '../test/fixtures';
import type { OperatorAction, PollResults } from './operatorState';
import { useOperatorController, type OperatorApi } from './useOperatorController';

function rejectedPoll(error = 'offline'): PollResults {
  return Object.fromEntries(
    [
      'status', 'candidates', 'thesis', 'thesisRth', 'verdicts',
      'positions', 'orders', 'audit', 'config', 'backtest',
    ].map((key) => [key, { ok: false, error }]),
  ) as PollResults;
}

describe('useOperatorController', () => {
  afterEach(() => vi.useRealTimers());

  it('polls immediately, every ten seconds, and never overlaps', async () => {
    vi.useFakeTimers();
    let release: ((value: PollResults) => void) | undefined;
    const poll = vi.fn(() => new Promise<PollResults>((resolve) => { release = resolve; }));
    const api: OperatorApi = {
      poll,
      action: vi.fn<(
        action: OperatorAction,
      ) => Promise<ApiResult<unknown>>>(),
    };
    renderHook(() => useOperatorController(api));

    expect(poll).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(poll).toHaveBeenCalledTimes(1);

    await act(async () => { release?.(rejectedPoll()); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('retains an action failure and does not imply an order was submitted', async () => {
    const api: OperatorApi = {
      poll: vi.fn().mockResolvedValue(rejectedPoll()),
      action: vi.fn().mockResolvedValue({ ok: false, error: 'Broker did not respond.' }),
    };
    const { result } = renderHook(() => useOperatorController(api));

    await act(async () => { await result.current.runAction('executionCheck'); });

    expect(result.current.actions.executionCheck).toMatchObject({
      phase: 'error',
      message: 'Execution check failed. Broker did not respond. No order was submitted.',
    });
  });

  it('keeps mutation success even if its follow-up refresh is stale', async () => {
    const poll = vi.fn()
      .mockResolvedValueOnce(rejectedPoll())
      .mockResolvedValueOnce({
        ...rejectedPoll('quote timeout'),
        status: { ok: true, value: statusFixture },
      });
    const api: OperatorApi = {
      poll,
      action: vi.fn().mockResolvedValue({ ok: true, data: {}, message: 'Execution complete.' }),
    };
    const { result } = renderHook(() => useOperatorController(api));

    await act(async () => { await result.current.runAction('executionCheck'); });

    expect(result.current.actions.executionCheck.phase).toBe('success');
    expect(result.current.polling.stale).toBe(true);
  });
});
