import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import express, { type NextFunction, type Request, type Response } from 'express';
import { loadConfig, saveConfig } from './config.js';
import { currentSession, nowET } from './clock.js';
import { appendAudit, readAuditTail } from './audit.js';
import { readHaltState, writeHalt, clearHalt } from './state.js';
import { candidatesPath, verdictsPath, thesisPath, readJsonIfExists } from './paths.js';
import { AlpacaBroker } from './broker/client.js';

const PORT = 4310;
const ROOT = process.cwd();

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type Handler = (req: Request, res: Response) => void | Promise<void>;

function wrap(handler: Handler) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await handler(req, res);
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: errorMessage(err) });
    }
  };
}

function previousYmd(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function latestDatedJson(pathFor: (ymd: string) => string): unknown {
  const today = nowET().ymd;
  return (
    readJsonIfExists(pathFor(today)) ?? readJsonIfExists(pathFor(previousYmd(today))) ?? {}
  );
}

type RunKind = 'pipeline' | 'executor';
const RUN_SCRIPTS: Record<RunKind, string> = {
  pipeline: 'src/pipeline.ts',
  executor: 'src/executor-loop.ts',
};
const running: Partial<Record<RunKind, ChildProcess>> = {};

function startRun(kind: RunKind, res: Response): void {
  const existing = running[kind];
  if (existing && existing.exitCode === null && existing.signalCode === null) {
    res.status(409).json({ error: 'already running' });
    return;
  }
  const child = spawn('pnpm', ['tsx', RUN_SCRIPTS[kind]], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', () => {
    delete running[kind];
  });
  child.on('exit', () => {
    delete running[kind];
  });
  child.unref();
  running[kind] = child;
  res.status(202).json({ started: true });
}

const app = express();
app.use(express.json());

const distDir = path.resolve(ROOT, 'frontend', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
}

app.get(
  '/api/status',
  wrap(async (_req, res) => {
    const cfg = loadConfig();
    const halt = readHaltState();
    const session = currentSession();
    let equity: number | null = null;
    let error: string | undefined;
    try {
      // constructor throws when credentials for the mode are missing
      const broker = new AlpacaBroker(cfg);
      equity = (await broker.getAccount()).equity;
    } catch (err) {
      error = errorMessage(err);
    }
    res.json({
      mode: cfg.mode,
      session,
      halt,
      equity,
      ...(error !== undefined ? { error } : {}),
    });
  }),
);

app.get(
  '/api/candidates',
  wrap((_req, res) => {
    res.json(latestDatedJson(candidatesPath));
  }),
);

app.get(
  '/api/thesis',
  wrap((_req, res) => {
    res.json(latestDatedJson(thesisPath));
  }),
);

app.get(
  '/api/verdicts',
  wrap((_req, res) => {
    res.json(latestDatedJson(verdictsPath));
  }),
);

app.get(
  '/api/positions',
  wrap(async (_req, res) => {
    try {
      const broker = new AlpacaBroker(loadConfig());
      const account = await broker.getAccount();
      res.json({ items: account.positions });
    } catch (err) {
      res.json({ items: [], error: errorMessage(err) });
    }
  }),
);

app.get(
  '/api/orders',
  wrap(async (_req, res) => {
    try {
      const broker = new AlpacaBroker(loadConfig());
      const orders = await broker.getTodayOrders();
      res.json({ items: orders });
    } catch (err) {
      res.json({ items: [], error: errorMessage(err) });
    }
  }),
);

app.get(
  '/api/audit',
  wrap((req, res) => {
    const parsed = Number(req.query.limit);
    const limit = Number.isInteger(parsed) && parsed > 0 ? parsed : 100;
    res.json({ items: readAuditTail(limit) });
  }),
);

app.get(
  '/api/config',
  wrap((_req, res) => {
    res.json(loadConfig());
  }),
);

app.put(
  '/api/config',
  wrap((req, res) => {
    try {
      const saved = saveConfig(req.body);
      res.json(saved);
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  }),
);

app.post(
  '/api/pipeline/run',
  wrap((_req, res) => {
    startRun('pipeline', res);
  }),
);

app.post(
  '/api/executor/tick',
  wrap((_req, res) => {
    startRun('executor', res);
  }),
);

app.post(
  '/api/halt',
  wrap((req, res) => {
    const body = req.body as { reason?: unknown } | undefined;
    const reason =
      typeof body?.reason === 'string' && body.reason.trim() !== ''
        ? body.reason.trim()
        : 'manual halt';
    const state = writeHalt(reason);
    appendAudit({ kind: 'halt', data: { reason, source: 'api' } });
    res.json(state);
  }),
);

app.post(
  '/api/resume',
  wrap((_req, res) => {
    const state = clearHalt();
    appendAudit({ kind: 'resume', data: { source: 'api' } });
    res.json(state);
  }),
);

// SPA fallback for non-API GETs when a frontend build exists
const indexHtml = path.join(distDir, 'index.html');
if (fs.existsSync(indexHtml)) {
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/')) {
      res.sendFile(indexHtml);
    } else {
      next();
    }
  });
}

// express requires the 4-arg signature to register an error handler
// (catches express.json() parse failures among others)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (!res.headersSent) res.status(400).json({ error: errorMessage(err) });
});

process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection:', err);
});

app.listen(PORT, () => {
  console.log(`offhours-trader server listening on http://localhost:${PORT}`);
});
