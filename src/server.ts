import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { getAdapter, type ResumeCommand } from './adapters/index.js';
import { loadBoard, sanitizeBoard, saveBoard } from './board.js';
import {
  addDecision,
  decisionMatches,
  deleteDecision,
  isDecisionId,
  loadDecisions,
  resolveDecisions,
  updateDecision,
  type ResolvedDecision,
} from './decisions.js';
import type { Config } from './config.js';
import { indexSources, watchSources, type IndexSummary, type Watcher } from './indexer.js';
import type { Store } from './store.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildBrief, finalizeBrief, handoffTargets, saveBrief, startLaunch } from './handoff.js';
import { commandText, findTerminal, openInTerminal, type Launch, type TerminalInfo } from './platform.js';
import { HANDOFF_ID_RE } from './handoff-marker.js';

/**
 * The local web UI server.
 *
 * Security model: the server binds to 127.0.0.1 only and serves transcripts, so
 *  - every request must carry a Host header naming this loopback address
 *    (blocks DNS-rebinding attacks from web pages you visit),
 *  - no CORS headers are ever sent, so other sites can't read responses,
 *  - every request that changes something needs a per-run random token that is
 *    only embedded in the page this server serves, and a matching Origin,
 *  - the page runs under a strict Content-Security-Policy with no external
 *    sources, so it makes no network requests beyond this server.
 */

const UI_DIR = fileURLToPath(new URL('../../ui/', import.meta.url));

const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  '/favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml' },
  '/fonts/geist-latin-wght-normal.woff2': { file: 'fonts/geist-latin-wght-normal.woff2', type: 'font/woff2' },
  '/fonts/geist-latin-ext-wght-normal.woff2': { file: 'fonts/geist-latin-ext-wght-normal.woff2', type: 'font/woff2' },
  '/fonts/geist-mono-latin-wght-normal.woff2': { file: 'fonts/geist-mono-latin-wght-normal.woff2', type: 'font/woff2' },
  '/fonts/geist-mono-latin-ext-wght-normal.woff2': { file: 'fonts/geist-mono-latin-ext-wght-normal.woff2', type: 'font/woff2' },
};

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGES = 600;

export interface UiServerOptions {
  port?: number;
  /** Try this many ports above `port` if it is taken. */
  portAttempts?: number;
  /** Watch the session folders and push updates to open pages. Default true. */
  watch?: boolean;
  /** Override the platform: command style and "open in terminal" (tests). */
  platform?: NodeJS.Platform;
  /** Override terminal detection; null means none available (tests). */
  terminal?: TerminalInfo | null;
  /** Replace the terminal launcher (tests). */
  launchTerminal?: (launch: Launch) => Promise<void>;
  /** Summary of the index run that happened just before starting, shown in the UI. */
  initialIndex?: IndexSummary;
}

export interface UiServer {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A resume command as a platform-neutral launch. */
export function resumeLaunch(cmd: ResumeCommand): Launch {
  return { cwd: cmd.cwd, command: cmd.command, args: cmd.args };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(json);
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large.');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.');
  }
}

export async function startUiServer(store: Store, cfg: Config, opts: UiServerOptions = {}): Promise<UiServer> {
  const token = randomBytes(24).toString('base64url');
  const platform = opts.platform ?? process.platform;
  const terminal = opts.terminal !== undefined ? opts.terminal : findTerminal(platform);
  const canOpenTerminal = !!terminal;
  const noTerminal =
    platform === 'linux'
      ? 'No terminal app was found (or there is no graphical session). Copy the command instead.'
      : 'Opening a terminal is not supported on this system. Copy the command instead.';
  const launchTerminal = async (l: Launch) => {
    try {
      await (opts.launchTerminal ? opts.launchTerminal(l) : openInTerminal(l, platform).then(() => {}));
    } catch (err) {
      throw new HttpError(500, `Couldn't open a terminal: ${(err as Error).message}`);
    }
  };
  const clients = new Set<ServerResponse>();
  let port = 0;
  let lastIndex: IndexSummary | null = opts.initialIndex ?? null;
  let version = 0;

  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const allowedOrigins = () => new Set([...allowedHosts()].map((h) => `http://${h}`));

  const broadcast = (event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(payload);
  };

  // ── API handlers ─────────────────────────────────────────────────────────

  const board = () => {
    const graph = store.workstreams();
    const sessions = store.listSessions({ limit: 5000 });
    return {
      version,
      generatedAt: new Date().toISOString(),
      sessions,
      decisionCounts: decisionCounts(),
      subagentCounts: store.subagentCounts(),
      ...graph,
      providers: [...new Set(sessions.map((s) => s.provider))].sort().map((id) => ({
        id,
        label: getAdapter(id)?.label ?? id,
        shortPrefix: getAdapter(id)?.shortPrefix ?? id.slice(0, 2),
      })),
      lastIndex,
      sources: cfg.sources.map((s) => ({ provider: s.adapter.id, label: s.adapter.label, root: s.root })),
      capabilities: {
        openTerminal: canOpenTerminal,
        terminalName: terminal?.name ?? null,
        handoffTargets: handoffTargets().map((a) => ({ id: a.id, label: a.label })),
      },
    };
  };

  const decisionCounts = () => {
    const counts: Record<string, number> = {};
    for (const d of loadDecisions(cfg.home).decisions) counts[d.sessionId] = (counts[d.sessionId] ?? 0) + 1;
    return counts;
  };

  /** A decision as the UI needs it: the decision plus a short summary of its session. */
  const decisionView = (d: ResolvedDecision) => ({
    id: d.id,
    sessionId: d.sessionId,
    seq: d.seq,
    text: d.text,
    anchored: d.anchored,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    session: d.session
      ? {
          id: d.session.id,
          shortId: d.session.shortId,
          title: d.session.title,
          provider: d.session.provider,
          project: d.session.project,
          cwd: d.session.cwd,
          gitBranch: d.session.gitBranch,
          updatedAt: d.session.updatedAt,
        }
      : null,
  });

  const allDecisions = () => resolveDecisions(store, loadDecisions(cfg.home).decisions);

  /**
   * One session for the side panel. Long sessions send a window of messages:
   * the latest ones, or the ones around `around` when jumping to a search
   * match or a decision.
   */
  const sessionDetail = (ref: string, around?: number) => {
    const s = store.resolve(ref);
    const resume = getAdapter(s.provider)?.resumeCommand(s) ?? null;
    const all = store.messages(s.id);
    let start = Math.max(0, all.length - MAX_MESSAGES);
    if (around != null && all.length > MAX_MESSAGES) {
      const at = all.findIndex((m) => m.seq >= around);
      if (at >= 0) start = Math.min(Math.max(0, at - Math.floor(MAX_MESSAGES / 2)), all.length - MAX_MESSAGES);
    }
    const messages = all.slice(start, start + MAX_MESSAGES);
    const decisions = resolveDecisions(
      store,
      loadDecisions(cfg.home).decisions.filter((d) => d.sessionId === s.id),
    ).sort((a, b) => a.seq - b.seq);
    return {
      session: s,
      filesTouched: store.filesTouched(s.id),
      contextSeries: store.contextSeries(s.id),
      messages,
      truncatedMessages: start,
      truncatedAfter: all.length - start - messages.length,
      decisions: decisions.map(decisionView),
      related: store.related(s.id, 12),
      subagents: store.subagents(s.id),
      resume: resume ? { ...resume, shell: commandText(resumeLaunch(resume), platform) } : null,
    };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const host = req.headers.host ?? '';
    if (!allowedHosts().has(host)) throw new HttpError(403, 'Unexpected Host header.');

    const url = new URL(req.url ?? '/', `http://${host}`);
    const method = req.method ?? 'GET';
    const path = url.pathname;

    const isWrite = method !== 'GET' && method !== 'HEAD';
    if (isWrite) {
      const origin = req.headers.origin;
      if (origin && !allowedOrigins().has(origin)) throw new HttpError(403, 'Cross-origin request refused.');
      const given = req.headers['x-contextdeck-token'];
      if (typeof given !== 'string' || !safeEqual(given, token)) throw new HttpError(403, 'Missing or wrong token.');
    }

    // Static files
    if (!path.startsWith('/api/')) {
      const asset = STATIC[path];
      if (!asset || isWrite) throw new HttpError(404, 'Not found.');
      let body: Buffer | string = await readFile(UI_DIR + asset.file);
      if (asset.file === 'index.html') body = body.toString('utf8').replace('__CONTEXTDECK_TOKEN__', token);
      res.writeHead(200, {
        'Content-Type': asset.type,
        'Cache-Control': asset.file.startsWith('fonts/') ? 'public, max-age=86400' : 'no-store',
        'Content-Security-Policy': CSP,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cross-Origin-Resource-Policy': 'same-origin',
      });
      res.end(method === 'HEAD' ? undefined : body);
      return;
    }

    if (method === 'GET' && path === '/api/board') return send(res, 200, board());

    if (method === 'GET' && path.startsWith('/api/session/')) {
      const ref = decodeURIComponent(path.slice('/api/session/'.length));
      const aroundParam = url.searchParams.get('around');
      const around = aroundParam != null && /^\d{1,9}$/.test(aroundParam) ? Number(aroundParam) : undefined;
      try {
        return send(res, 200, sessionDetail(ref, around));
      } catch (err) {
        throw new HttpError(404, (err as Error).message);
      }
    }

    if (method === 'GET' && path === '/api/search') {
      const q = (url.searchParams.get('q') ?? '').slice(0, 500);
      const provider = url.searchParams.get('provider') ?? undefined;
      try {
        const hits = store.search(q, { provider, limit: 200 });
        const decisions = q.trim() ? allDecisions().filter((d) => decisionMatches(d, q) && (!provider || d.session?.provider === provider)) : [];
        return send(res, 200, { query: q, hits, decisions: decisions.map(decisionView) });
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
    }

    // Every match inside one session, for "find in this conversation"
    if (method === 'GET' && path === '/api/matches') {
      const id = url.searchParams.get('id') ?? '';
      const q = (url.searchParams.get('q') ?? '').slice(0, 500);
      let s;
      try {
        s = store.resolve(id);
      } catch (err) {
        throw new HttpError(404, (err as Error).message);
      }
      try {
        return send(res, 200, { query: q, matches: store.matchesIn(s.id, q) });
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
    }

    if (method === 'GET' && path === '/api/decisions') {
      return send(res, 200, { decisions: allDecisions().map(decisionView) });
    }

    if (method === 'POST' && path === '/api/decisions') {
      const body = (await readBody(req)) as { sessionId?: unknown; seq?: unknown; text?: unknown } | null;
      if (!body || typeof body.sessionId !== 'string' || typeof body.seq !== 'number' || typeof body.text !== 'string') {
        throw new HttpError(400, 'Expected {"sessionId", "seq", "text"}.');
      }
      let created;
      try {
        created = addDecision(cfg.home, store, { sessionId: body.sessionId, seq: body.seq, text: body.text });
      } catch (err) {
        const msg = (err as Error).message;
        throw new HttpError(/No session matches/.test(msg) ? 404 : 400, msg);
      }
      broadcast('decisions', { count: loadDecisions(cfg.home).decisions.length });
      return send(res, 201, decisionView(resolveDecisions(store, [created])[0]!));
    }

    if ((method === 'PUT' || method === 'DELETE') && path.startsWith('/api/decisions/')) {
      const id = decodeURIComponent(path.slice('/api/decisions/'.length));
      if (!isDecisionId(id)) throw new HttpError(404, 'No such decision.');
      if (method === 'DELETE') {
        if (!deleteDecision(cfg.home, id)) throw new HttpError(404, 'No such decision.');
        broadcast('decisions', { count: loadDecisions(cfg.home).decisions.length });
        return send(res, 200, { ok: true });
      }
      const body = (await readBody(req)) as { text?: unknown } | null;
      if (!body || typeof body.text !== 'string') throw new HttpError(400, 'Expected {"text"}.');
      let updated;
      try {
        updated = updateDecision(cfg.home, id, body.text);
      } catch (err) {
        const msg = (err as Error).message;
        throw new HttpError(/No such/.test(msg) ? 404 : 400, msg);
      }
      broadcast('decisions', { count: loadDecisions(cfg.home).decisions.length });
      return send(res, 200, decisionView(resolveDecisions(store, [updated])[0]!));
    }

    if (method === 'GET' && path === '/api/layout') return send(res, 200, loadBoard(cfg.home));

    if (method === 'PUT' && path === '/api/layout') {
      const next = sanitizeBoard(await readBody(req));
      saveBoard(cfg.home, next);
      return send(res, 200, next);
    }

    if (method === 'POST' && path === '/api/reindex') {
      const sum = await indexSources(store, cfg.sources);
      lastIndex = sum;
      version++;
      broadcast('index', { version, summary: sum });
      return send(res, 200, sum);
    }

    if (method === 'GET' && path === '/api/handoff/preview') {
      const ref = url.searchParams.get('id') ?? '';
      const to = url.searchParams.get('to') ?? '';
      const target = getAdapter(to);
      if (!target?.startCommand) throw new HttpError(400, `Can't hand off to "${to}".`);
      let brief;
      try {
        brief = buildBrief(store, ref, {
          to,
          checkIn: url.searchParams.get('checkIn') !== '0',
          handoffId: url.searchParams.get('handoffId') ?? undefined,
          home: cfg.home,
        });
      } catch (err) {
        throw new HttpError(404, (err as Error).message);
      }
      const cwd = brief.from.cwd;
      return send(res, 200, {
        handoffId: brief.handoffId,
        brief: brief.text,
        tokens: brief.tokens,
        from: brief.from,
        to: brief.to,
        toLabel: brief.toLabel,
        fromLabel: getAdapter(brief.from.provider)?.label ?? brief.from.provider,
        targetWindow: brief.targetWindow,
        cwd,
        cwdExists: !!cwd && existsSync(cwd),
        crossProvider: brief.from.provider !== to,
        briefPath: join(cfg.home, 'handoffs', `${brief.handoffId}.md`),
        canOpenTerminal,
      });
    }

    if (method === 'POST' && path === '/api/handoff') {
      const body = (await readBody(req)) as { id?: unknown; to?: unknown; brief?: unknown; handoffId?: unknown; launch?: unknown } | null;
      if (!body || typeof body.id !== 'string' || typeof body.to !== 'string' || typeof body.brief !== 'string' || typeof body.handoffId !== 'string') {
        throw new HttpError(400, 'Expected {"id", "to", "handoffId", "brief"}.');
      }
      if (!HANDOFF_ID_RE.test(body.handoffId)) throw new HttpError(400, 'Invalid handoff id.');
      const target = getAdapter(body.to);
      if (!target?.startCommand) throw new HttpError(400, `Can't hand off to "${body.to}".`);
      let from;
      try {
        from = store.resolve(body.id);
      } catch (err) {
        throw new HttpError(404, (err as Error).message);
      }
      let text;
      try {
        text = finalizeBrief(body.brief, body.handoffId, from.id);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      const briefPath = saveBrief(cfg.home, body.handoffId, text);
      const launch = startLaunch(target, from, briefPath, body.handoffId, platform);
      const line = commandText(launch, platform);
      let launched = false;
      if (body.launch === true) {
        if (!canOpenTerminal) throw new HttpError(501, noTerminal);
        await launchTerminal(launch);
        launched = true;
      }
      return send(res, 200, { handoffId: body.handoffId, path: briefPath, command: line, launched });
    }

    if (method === 'POST' && path === '/api/open-terminal') {
      if (!canOpenTerminal) throw new HttpError(501, noTerminal);
      const body = (await readBody(req)) as { id?: unknown } | null;
      if (!body || typeof body.id !== 'string') throw new HttpError(400, 'Expected {"id": "<session id>"}.');
      let s;
      try {
        s = store.resolve(body.id);
      } catch (err) {
        throw new HttpError(404, (err as Error).message);
      }
      const cmd = getAdapter(s.provider)?.resumeCommand(s);
      if (!cmd) throw new HttpError(404, `No adapter for ${s.provider}.`);
      const launch = resumeLaunch(cmd);
      const line = commandText(launch, platform);
      await launchTerminal(launch);
      return send(res, 200, { ok: true, command: line });
    }

    if (method === 'GET' && path === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Content-Type-Options': 'nosniff',
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ version })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    throw new HttpError(404, 'Not found.');
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) send(res, status, { error: message });
      else res.end();
    });
  });

  // Find a free port on loopback only
  const basePort = opts.port ?? 4977;
  const attempts = basePort === 0 ? 1 : (opts.portAttempts ?? 10);
  for (let i = 0; i < attempts; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(basePort === 0 ? 0 : basePort + i, '127.0.0.1');
      });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || i === attempts - 1) throw err;
    }
  }
  port = (server.address() as AddressInfo).port;

  let watcher: Watcher | null = null;
  if (opts.watch !== false) {
    watcher = watchSources(store, cfg.sources, (summary) => {
      lastIndex = summary;
      version++;
      broadcast('index', { version, summary });
    });
  }
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': keep-alive\n\n');
  }, 25_000);

  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        watcher?.close();
        for (const res of clients) res.end();
        clients.clear();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

/** Open a URL in the default browser. Failures are ignored; the URL is printed anyway. */
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* ignore */
  }
}
