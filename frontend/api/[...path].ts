// Vercel serverless proxy: forwards /api/* to the VPS dashboard API, adding
// the bearer token the server requires from network clients (src/server-auth.ts).
// The token never reaches the browser — the Edge basic-auth middleware gates
// who can invoke this function, and the function injects the credential.
type Req = {
  method?: string;
  query: Record<string, string | string[] | undefined>;
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
  const segs = req.query.path;
  const apiPath = Array.isArray(segs) ? segs.join('/') : (segs ?? '');
  const url = new URL(`/api/${apiPath}`, upstream);
  for (const [key, value] of Object.entries(req.query)) {
    if (key === 'path' || value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) url.searchParams.append(key, v);
    else url.searchParams.set(key, value);
  }
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
