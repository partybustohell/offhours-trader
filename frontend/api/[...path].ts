// Vercel serverless proxy: forwards /api/* to the VPS dashboard API, adding
// the bearer token the server requires from network clients (src/server-auth.ts).
// The token never reaches the browser — the Edge basic-auth middleware gates
// who can invoke this function, and the function injects the credential.
// Path + query come from req.url (not injected query params, whose shape
// varies by runtime).
type Req = {
  method?: string;
  url?: string;
  body?: unknown;
};
type Res = {
  status: (code: number) => Res;
  setHeader: (name: string, value: string) => void;
  send: (body: string) => void;
  json: (body: unknown) => void;
};

export default async function handler(req: Req, res: Res): Promise<void> {
  const token = process.env.DASHBOARD_TOKEN ?? '';
  const upstream = process.env.DASHBOARD_UPSTREAM ?? '';
  if (!token || !upstream) {
    res.status(503).json({ error: 'proxy not configured (DASHBOARD_TOKEN / DASHBOARD_UPSTREAM)' });
    return;
  }
  const incoming = new URL(req.url ?? '/', 'http://internal');
  if (!incoming.pathname.startsWith('/api/')) {
    res.status(404).json({ error: 'not an api path' });
    return;
  }
  const url = new URL(incoming.pathname + incoming.search, upstream);
  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD' && req.body !== undefined;
  const r = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(req.body) } : {}),
  });
  const text = await r.text();
  res.setHeader('content-type', r.headers.get('content-type') ?? 'application/json');
  res.status(r.status).send(text);
}
