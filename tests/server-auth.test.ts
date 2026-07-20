import { describe, expect, it, vi } from 'vitest';
import { assertBindAllowed, requireBearerToken } from '../src/server-auth.js';

type MockRes = {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
};

function run(opts: {
  token: string;
  path: string;
  header?: string;
  remote?: string;
}): { next: boolean; status?: number } {
  const mw = requireBearerToken(opts.token);
  let nextCalled = false;
  const res: MockRes = { status: vi.fn(), json: vi.fn(), set: vi.fn() };
  res.status.mockReturnValue(res);
  const req = {
    path: opts.path,
    get: (name: string) => (name.toLowerCase() === 'authorization' ? opts.header : undefined),
    socket: { remoteAddress: opts.remote ?? '203.0.113.7' },
  };
  mw(req as never, res as never, () => {
    nextCalled = true;
  });
  const status = res.status.mock.calls[0]?.[0] as number | undefined;
  return { next: nextCalled, status };
}

describe('requireBearerToken', () => {
  const token = 'sekrit-token';

  it('rejects a network /api request with no header', () => {
    expect(run({ token, path: '/api/status' })).toEqual({ next: false, status: 401 });
  });

  it('rejects a wrong or malformed bearer', () => {
    expect(run({ token, path: '/api/status', header: 'Bearer nope' }).status).toBe(401);
    expect(run({ token, path: '/api/status', header: 'sekrit-token' }).status).toBe(401);
  });

  it('accepts the exact bearer token', () => {
    expect(run({ token, path: '/api/config', header: `Bearer ${token}` })).toEqual({
      next: true,
      status: undefined,
    });
  });

  it('exempts loopback clients (SSH-tunnel workflow keeps working tokenless)', () => {
    for (const remote of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect(run({ token, path: '/api/status', remote }).next).toBe(true);
    }
  });

  it('never gates non-API paths (static assets)', () => {
    expect(run({ token, path: '/assets/index.js' }).next).toBe(true);
    expect(run({ token, path: '/' }).next).toBe(true);
  });
});

describe('assertBindAllowed (fail-closed exposure invariant)', () => {
  it('allows loopback binds with or without a token', () => {
    expect(() => assertBindAllowed('127.0.0.1', '')).not.toThrow();
    expect(() => assertBindAllowed('localhost', '')).not.toThrow();
    expect(() => assertBindAllowed('::1', 'tok')).not.toThrow();
  });

  it('refuses a non-loopback bind without DASHBOARD_TOKEN', () => {
    expect(() => assertBindAllowed('0.0.0.0', '')).toThrow(/DASHBOARD_TOKEN/);
    expect(() => assertBindAllowed('0.0.0.0', undefined)).toThrow(/DASHBOARD_TOKEN/);
  });

  it('allows a non-loopback bind once a token is set', () => {
    expect(() => assertBindAllowed('0.0.0.0', 'tok')).not.toThrow();
  });
});
