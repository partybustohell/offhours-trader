import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import express, { type NextFunction, type Request, type Response } from 'express';
import { loadConfig, saveConfig } from './config.js';
import { currentSession, nowET, thesisKindForSession } from './clock.js';
import { appendAudit, readAuditTail } from './audit.js';
import { readHaltState, writeHalt, clearHalt } from './state.js';
import { candidatesPath, verdictsPath, thesisPath, readJsonIfExists } from './paths.js';
import { AlpacaBroker } from './broker/client.js';
import { resolveBacktestNetPnl } from './server-backtest.js';

const PORT = Number(process.env.PORT) || 4310;
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
  // A pipeline run must produce the thesis kind the executor will consume for
  // the current session, or the plan is stranded (see thesisKindForSession).
  // The executor tick takes no session argument.
  const sessionArgs =
    kind === 'pipeline' && thesisKindForSession(currentSession()) === 'rth' ? ['rth'] : [];
  const child = spawn('pnpm', ['tsx', RUN_SCRIPTS[kind], ...sessionArgs], {
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
  wrap((req, res) => {
    const kind = req.query.kind === 'rth' ? 'rth' : 'offhours';
    res.json(latestDatedJson((ymd) => thesisPath(ymd, kind)));
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

// Latest backtest results, aggregated from backtest-out/. Read-only; the
// backtest itself runs via scripts/backtest.ts, never through this server.
interface BacktestCellRow {
  cell: string;
  threshold: number;
  bear?: number;
  bearWeight?: number;
  abstained: number;
  ordersPlaced: number;
  ordersFilled: number;
  trades: number;
  netPnlUsd: number | null;
}
type RawBacktestCellRow = Omit<BacktestCellRow, 'netPnlUsd'> & {
  netPnlUsd?: unknown;
  netPnlTotalUsd?: unknown;
};
interface BacktestTradeRow {
  day: string;
  stratum: string;
  ticker: string;
  side: string;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  pnlUsd: number;
  exitReason: string;
}
let backtestCache: { at: number; payload: unknown } | null = null;

app.get(
  '/api/backtest',
  wrap((_req, res) => {
    if (backtestCache && Date.now() - backtestCache.at < 60_000) {
      res.json(backtestCache.payload);
      return;
    }
    const btRoot = path.resolve(process.cwd(), 'backtest-out');
    const tags = fs.existsSync(btRoot)
      ? fs
          .readdirSync(btRoot)
          .filter((t) => t !== 'prep' && fs.existsSync(path.join(btRoot, t, 'sweep-results.json')))
          .sort(
            (a, b) =>
              fs.statSync(path.join(btRoot, b, 'sweep-results.json')).mtimeMs -
              fs.statSync(path.join(btRoot, a, 'sweep-results.json')).mtimeMs,
          )
      : [];
    const tag = tags[0];
    if (!tag) {
      res.json({ available: false });
      return;
    }
    const readTradesOf = (dir: string): BacktestTradeRow[] => {
      const out: BacktestTradeRow[] = [];
      if (!fs.existsSync(dir)) return out;
      for (const day of fs.readdirSync(dir)) {
        const f = path.join(dir, day, 'episode-result.json');
        if (!fs.existsSync(f)) continue;
        try {
          const ep = JSON.parse(fs.readFileSync(f, 'utf8')) as {
            day: string;
            stratum?: string;
            trades?: Omit<BacktestTradeRow, 'day' | 'stratum'>[];
          };
          for (const t of ep.trades ?? []) {
            out.push({ ...t, day: ep.day, stratum: ep.stratum ?? '?' });
          }
        } catch {
          // unreadable episode: skip
        }
      }
      return out.sort((a, b) => a.day.localeCompare(b.day));
    };
    const rawCells = JSON.parse(
      fs.readFileSync(path.join(btRoot, tag, 'sweep-results.json'), 'utf8'),
    ) as RawBacktestCellRow[] | { cells: RawBacktestCellRow[] };
    const cellList = Array.isArray(rawCells)
      ? rawCells
      : rawCells.cells;
    const cells: BacktestCellRow[] = cellList.map((cell) => ({
      ...cell,
      netPnlUsd: resolveBacktestNetPnl(cell),
    }));
    // trade log from the loosest cell that actually traded
    const traded = [...cells].sort((a, b) => b.trades - a.trades)[0];
    const trades = traded ? readTradesOf(path.join(btRoot, tag, 'sweep', traded.cell)) : [];
    const reportPath = path.join(btRoot, tag, 'REPORT.md');
    const payload = {
      available: true,
      tag,
      generatedAt: fs.existsSync(reportPath) ? fs.statSync(reportPath).mtime.toISOString() : null,
      cells,
      tradeLogCell: traded?.cell ?? null,
      trades,
    };
    backtestCache = { at: Date.now(), payload };
    res.json(payload);
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

// Bind loopback only by default: the dashboard has no auth and can edit the
// config, so it must never be reachable from the network. HOST is an explicit
// escape hatch for a trusted-network deployment.
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`offhours-trader server listening on http://${HOST}:${PORT}`);
});
