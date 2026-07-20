import crypto from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

// Loopback client addresses (IPv4, IPv6, and v4-mapped-v6) — requests arriving
// here came through the box itself (SSH tunnel), not the network.
const LOOPBACK_REMOTES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_BINDS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Bearer-token gate for /api routes. Loopback clients are exempt so the
 * original ssh -L tunnel workflow keeps working tokenless; anything arriving
 * over the network must present `Authorization: Bearer <token>`. Static
 * assets are never gated — the UI shell reveals nothing without the API.
 */
export function requireBearerToken(token: string): RequestHandler {
  const expected = Buffer.from(`Bearer ${token}`);
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith('/api/')) return next();
    if (LOOPBACK_REMOTES.has(req.socket.remoteAddress ?? '')) return next();
    const presented = Buffer.from(req.get('authorization') ?? '');
    if (presented.length === expected.length && crypto.timingSafeEqual(presented, expected)) {
      return next();
    }
    res.status(401).json({ error: 'unauthorized' });
  };
}

/**
 * Fail-closed exposure invariant: the dashboard can PATCH config and halt
 * trading, so a non-loopback bind without DASHBOARD_TOKEN must refuse to
 * start rather than expose an unauthenticated control surface.
 */
export function assertBindAllowed(host: string, token: string | undefined): void {
  if (LOOPBACK_BINDS.has(host)) return;
  if (!token) {
    throw new Error(
      `refusing to bind ${host}: set DASHBOARD_TOKEN before exposing the dashboard beyond loopback`,
    );
  }
}
