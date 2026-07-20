import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAudit, postAction, putConfig } from './api';
import { configFixture } from './test/fixtures';

describe('API normalization', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('preserves known counterfactual and unknown audit kinds', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({
        items: [
          { ts: '2026-07-12T14:00:00.000Z', kind: 'counterfactual', data: { ticker: 'AMD' } },
          { ts: '2026-07-12T14:01:00.000Z', kind: 'broker_heartbeat', data: { ok: true } },
        ],
      }), { status: 200 }),
    );

    await expect(fetchAudit()).resolves.toEqual([
      { ts: '2026-07-12T14:00:00.000Z', kind: 'counterfactual', data: { ticker: 'AMD' } },
      { ts: '2026-07-12T14:01:00.000Z', kind: 'broker_heartbeat', data: { ok: true } },
    ]);
  });

  it('returns the saved configuration from PUT', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(configFixture), { status: 200 }),
    );

    await expect(putConfig(configFixture)).resolves.toEqual({
      ok: true,
      data: configFixture,
    });
  });

  it('surfaces backend validation text from PUT', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Confidence must be between 0 and 1.' }), {
        status: 400,
      }),
    );

    await expect(putConfig(configFixture)).resolves.toEqual({
      ok: false,
      error: 'Confidence must be between 0 and 1.',
    });
  });

  it('states that no order was confirmed after an execution network failure', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(postAction('/api/executor/tick')).resolves.toEqual({
      ok: false,
      error: 'Failed to fetch',
    });
  });
});
