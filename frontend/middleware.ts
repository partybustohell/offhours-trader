// Vercel Edge Middleware: HTTP Basic Auth over every path (pages, assets,
// and the /api proxy). The password lives in the DASHBOARD_PASSWORD env var;
// with it unset the deployment fails closed. Any username is accepted — the
// password is the lock. Browsers cache the credential per realm and attach it
// to the SPA's same-origin /api fetches automatically.
export const config = { matcher: '/(.*)' };

export default function middleware(req: Request): Response | undefined {
  const expected = process.env.DASHBOARD_PASSWORD ?? '';
  if (!expected) return new Response('dashboard password not configured', { status: 503 });

  const header = req.headers.get('authorization') ?? '';
  if (header.startsWith('Basic ')) {
    try {
      const decoded = atob(header.slice('Basic '.length));
      const password = decoded.slice(decoded.indexOf(':') + 1);
      if (password === expected) return undefined; // authenticated: fall through
    } catch {
      // malformed base64: treat as unauthenticated
    }
  }
  return new Response('authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="offhours-dashboard", charset="UTF-8"' },
  });
}
