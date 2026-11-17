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
  confirmDecision,
  decisionMatches,
  deleteDecision,
  isDecisionId,
  loadDecisions,
  resolveDecisions,
  restoreDecision,
  updateDecision,
  type ResolvedDecision,
} from './decisions.js';
import type { Config } from './config.js';
import { indexSources, watchSources, type IndexSummary, type Watcher } from './indexer.js';
import type { Store } from './store.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildBrief, finalizeBrief, handoffTargets, saveBrief, startLaunch } from './handoff.js';
import { MeaningService } from './meaning.js';
import { isLocalUrl, type SemanticSettings } from './settings.js';
import { commandText, findTerminal, openInTerminal, type Launch, type TerminalInfo } from './platform.js';
import { HANDOFF_ID_RE } from './handoff-marker.js';
import { appendAudit } from './audit.js';
import {
  DEFAULT_SCOPES,
  cleanDeviceName,
  cleanLogin,
  findByHash,
  hashSecret,
  idleExpiry,
  isDeviceId,
  isPendingId,
  isScope,
  loadDevices,
  newDeviceId,
  newPendingId,
  newSecret,
  pruneDevices,
  publicDevice,
  publicPending,
  revokeDevices,
  saveDevices,
  PENDING_MS,
  type Device,
} from './devices.js';
import { PairingCodes } from './pairing.js';
import { qrSvg } from './qr.js';
import { routeAccess, runScopes, type RouteAccess } from './scopes.js';
import { isRunId, RunError, RunManager, type RunManagerOptions, type RunRequest } from './runs.js';
import { ADAPTERS } from './adapters/index.js';
import { loadSettings } from './settings.js';

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
 *
 * Phone mode (`opts.phone`) adds this computer's tailnet name as one more Host,
 * for requests proxied by Tailscale Serve. Those are "remote" (see
 * `requestContext`), must carry a Tailscale login, and get nothing until a
 * device is paired.
 */

const UI_DIR = fileURLToPath(new URL('../../ui/', import.meta.url));

const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  '/favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml' },
  '/manifest.webmanifest': { file: 'manifest.webmanifest', type: 'application/manifest+json; charset=utf-8' },
  '/fonts/geist-latin-wght-normal.woff2': { file: 'fonts/geist-latin-wght-normal.woff2', type: 'font/woff2' },
  '/fonts/geist-latin-ext-wght-normal.woff2': { file: 'fonts/geist-latin-ext-wght-normal.woff2', type: 'font/woff2' },
  '/fonts/geist-mono-latin-wght-normal.woff2': { file: 'fonts/geist-mono-latin-wght-normal.woff2', type: 'font/woff2' },
  '/fonts/geist-mono-latin-ext-wght-normal.woff2': { file: 'fonts/geist-mono-latin-ext-wght-normal.woff2', type: 'font/woff2' },
};

/** The only files an unpaired device can load: the pairing page, which holds no token and no data. */
const PAIR_STATIC: Record<string, { file: string; type: string }> = {
  '/pair': { file: 'pair.html', type: 'text/html; charset=utf-8' },
  '/pair.js': { file: 'pair.js', type: 'text/javascript; charset=utf-8' },
  '/pair.css': { file: 'pair.css', type: 'text/css; charset=utf-8' },
  '/favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml' },
};

const DEVICE_COOKIE = 'cd_device';
const PENDING_COOKIE = 'cd_pending';
const DEVICE_COOKIE_MAX_AGE = 30 * 86_400;
/** Update a device's "last seen" at most this often. */
const SEEN_EVERY_MS = 60_000;

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
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
  /** Search by meaning (tests pass their own). */
  meaning?: MeaningService;
  /**
   * Phone mode: also accept requests proxied by Tailscale Serve from this
   * tailnet name. Off unless set; nothing in the CLI sets it yet.
   */
  phone?: PhoneOptions;
  /** Pairing codes and their rate limit (tests pass their own). */
  pairing?: PairingCodes;
  /** Run manager settings (tests use fake agents and short timeouts). */
  runs?: Partial<Omit<RunManagerOptions, 'store' | 'sources' | 'home' | 'onChange' | 'onEvents' | 'onIndexed'>>;
  /** Called when a phone asks to pair, so the terminal can say so. */
  onPairRequest?: (request: { id: string; name: string; tailscaleLogin: string }) => void;
}

export interface PhoneOptions {
  /** This computer's tailnet name, e.g. `laptop.tail1234.ts.net` (from `tailscale status --json`). */
  tailnetHost: string;
}

/**
 * Who a request came from. Local requests come from a browser on this
 * computer; remote ones came through Tailscale Serve from another device.
 */
export interface RequestContext {
  remote: boolean;
  /** The Tailscale login Serve vouched for (remote requests only). */
  login: string | null;
  /** The paired device making a remote request, once its cookie checks out. */
  device: Device | null;
}

/** One cookie's value from the Cookie header, or null. */
function readCookie(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) {
      const v = part.slice(at + 1).trim();
      return /^[A-Za-z0-9_-]{16,128}$/.test(v) ? v : null;
    }
  }
  return null;
}

function cookie(name: string, value: string, path: string, maxAge: number): string {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Strict; Path=${path}; Max-Age=${maxAge}`;
}

/**
 * Headers a reverse proxy adds. A local browser has no reason to send them, so
 * in phone mode a request carrying any of them is treated as remote even if
 * its Host looks local. That way a proxy that rewrites Host can't make a phone
 * look like this computer.
 */
const PROXY_HEADERS = [
  'tailscale-user-login',
  'tailscale-user-name',
  'tailscale-user-profile-pic',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'forwarded',
];

const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * A tailnet name as a Host header carries it: lowercase, no trailing dot, no
 * port. Throws for anything that isn't a plain multi-label DNS name.
 */
export function normalizeTailnetHost(name: string): string {
  const host = name.trim().replace(/\.$/, '').toLowerCase();
  if (!HOSTNAME_RE.test(host)) throw new Error(`"${name}" isn't a tailnet name like laptop.tail1234.ts.net.`);
  return host;
}

export interface UiServer {
  url: string;
  port: number;
  token: string;
  /** Phone mode: a new one-time pairing code and the URL to put in a QR code. Null when phone mode is off. */
  pairingCode(): { code: string; url: string; expiresAt: string } | null;
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
  const meaning = opts.meaning ?? new MeaningService(store, cfg.home);
  const phoneSettings = loadSettings(cfg.home).phone;
  const runs = new RunManager({
    store,
    sources: cfg.sources,
    home: cfg.home,
    timeoutMs: phoneSettings.runTimeoutMinutes * 60_000,
    maxConcurrent: phoneSettings.maxConcurrentRuns,
    ...opts.runs,
    onChange: (run) => broadcast('run', run),
    onEvents: (runId, events) => broadcast('run-event', { runId, events }),
    onIndexed: (summary) => {
      lastIndex = summary;
      version++;
      broadcast('index', { version, summary });
      if (summary.indexed) meaning.kick();
    },
  });
  /** Open event streams, with the paired device each belongs to (null for this computer). */
  const clients = new Map<ServerResponse, string | null>();
  const codes = opts.pairing ?? new PairingCodes();
  let port = 0;
  let lastIndex: IndexSummary | null = opts.initialIndex ?? null;
  let version = 0;

  const phoneHost = opts.phone ? normalizeTailnetHost(opts.phone.tailnetHost) : null;
  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const allowedOrigins = (ctx: RequestContext) =>
    ctx.remote ? new Set([`https://${phoneHost}`]) : new Set([...allowedHosts()].map((h) => `http://${h}`));

  /**
   * Local or remote, decided once per request. Every request arrives from
   * 127.0.0.1 (Serve proxies them), so the Host header and proxy headers are
   * what tell them apart. Remote requests must carry the Tailscale login that
   * Serve adds; Serve strips copies sent by clients.
   */
  const requestContext = (req: IncomingMessage): RequestContext => {
    const host = req.headers.host ?? '';
    if (allowedHosts().has(host)) {
      if (!phoneHost || !PROXY_HEADERS.some((h) => req.headers[h] !== undefined)) return { remote: false, login: null, device: null };
    } else if (!phoneHost || host.toLowerCase() !== phoneHost) {
      throw new HttpError(403, 'Unexpected Host header.');
    }
    const login = req.headers['tailscale-user-login'];
    if (typeof login !== 'string' || !login.trim()) {
      throw new HttpError(
        403,
        'This request came through Tailscale without a signed-in user (for example from a tagged device). Open ContextDeck from a device signed in to your Tailscale account.',
      );
    }
    return { remote: true, login: cleanLogin(login), device: null };
  };

  /**
   * The paired device a remote request comes from: its cookie's hash must
   * match a device, the device must belong to the same Tailscale login, and it
   * must not have expired. Seeing it pushes its expiry back.
   */
  const authenticate = (req: IncomingMessage, login: string): Device | null => {
    const secret = readCookie(req, DEVICE_COOKIE);
    if (!secret) return null;
    const file = loadDevices(cfg.home);
    const pruned = pruneDevices(file);
    const device = findByHash(file.devices, secret, (d) => d.secretHash);
    const now = Date.now();
    if (device && device.tailscaleLogin === login) {
      if (now - Date.parse(device.lastSeenAt) >= SEEN_EVERY_MS) {
        device.lastSeenAt = new Date(now).toISOString();
        device.expiresAt = idleExpiry(now, loadSettings(cfg.home).phone.deviceIdleDays);
        saveDevices(cfg.home, file);
      } else if (pruned) saveDevices(cfg.home, file);
      return device;
    }
    if (pruned) saveDevices(cfg.home, file);
    return null;
  };

  /** End the event streams of devices that were revoked, expired or lost "view". */
  const closeStaleStreams = (only?: string[]) => {
    const remote = [...clients].filter(([, id]) => id !== null);
    if (!remote.length) return;
    const now = Date.now();
    const live = new Map(loadDevices(cfg.home).devices.map((d) => [d.id, d]));
    for (const [res, id] of remote) {
      const d = live.get(id!);
      const stale = only ? only.includes(id!) : !d || Date.parse(d.expiresAt) <= now || !d.scopes.includes('view');
      if (stale) {
        clients.delete(res);
        res.end();
      }
    }
  };

  const newPairingCode = () => {
    if (!phoneHost) return null;
    const { code, expiresAt } = codes.create();
    return { code, url: `https://${phoneHost}/pair#${code}`, expiresAt };
  };

  const devicesView = () => {
    const file = loadDevices(cfg.home);
    pruneDevices(file);
    return {
      phone: !!phoneHost,
      devices: file.devices.map(publicDevice),
      pending: file.pending.filter((p) => p.state === 'waiting').map(publicPending),
    };
  };

  const broadcast = (event: string, data: unknown, opts: { localOnly?: boolean } = {}) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [res, deviceId] of clients) if (!opts.localOnly || deviceId === null) res.write(payload);
  };

  // ── API handlers ─────────────────────────────────────────────────────────

  /**
   * What this page may do, so it only shows controls that will work. A phone
   * sees what its scopes allow; the server enforces the same rules anyway.
   */
  const capabilitiesFor = (ctx: RequestContext) => {
    const scopes = ctx.device?.scopes ?? null;
    const may = (scope: string) => !ctx.remote || !!scopes?.includes(scope as never);
    return {
      openTerminal: canOpenTerminal && !ctx.remote,
      terminalName: ctx.remote ? null : (terminal?.name ?? null),
      // Starting a handoff opens a terminal on this computer, so phones can't yet
      handoffTargets: ctx.remote ? [] : handoffTargets().map((a) => ({ id: a.id, label: a.label })),
      decide: may('decide'),
      arrange: !ctx.remote,
      rescan: !ctx.remote,
      meaningSettings: !ctx.remote,
      /** Phone mode is on and this is the computer: it can pair and manage phones. */
      pairPhones: !!phoneHost && !ctx.remote,
      device: ctx.device ? { id: ctx.device.id, name: ctx.device.name, scopes: ctx.device.scopes } : null,
      /** Runs: what this page may start, and the tools that can run without a terminal. */
      runs: {
        handoff: may('handoff'),
        run: may('run'),
        edit: may('edit'),
        tools: ADAPTERS.filter((a) => a.headless).map((a) => ({ id: a.id, label: a.label })),
      },
    };
  };

  const board = (ctx: RequestContext) => {
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
      meaning: meaning.status(),
      sources: cfg.sources.map((s) => ({ provider: s.adapter.id, label: s.adapter.label, root: s.root })),
      capabilities: capabilitiesFor(ctx),
    };
  };

  const decisionCounts = () => {
    const counts: Record<string, number> = {};
    for (const d of loadDecisions(cfg.home).decisions) if (!d.replacedBy) counts[d.sessionId] = (counts[d.sessionId] ?? 0) + 1;
    return counts;
  };

  /** Short session summaries, for decisions that point at other sessions. */
  const sessionBrief = (id: string) => {
    try {
      const s = store.resolve(id);
      return { id: s.id, shortId: s.shortId, title: s.title, provider: s.provider };
    } catch {
      return null;
    }
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
    decidedAt: d.decidedAt,
    checkedAt: d.checkedAt ?? null,
    replacedBy: d.replacedBy
      ? (() => {
          const by = loadDecisions(cfg.home).decisions.find((x) => x.id === d.replacedBy);
          return by ? { id: by.id, text: by.text, sessionId: by.sessionId } : null;
        })()
      : null,
    changes: d.changes.map((c) => ({
      path: c.path,
      sessions: c.sessions.map((x) => ({ editedAt: x.editedAt, session: sessionBrief(x.id) })).filter((x) => x.session),
    })),
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

  const servePairPage = async (res: ServerResponse, method: string, asset: { file: string; type: string }) => {
    const body = await readFile(UI_DIR + asset.file);
    res.writeHead(200, {
      'Content-Type': asset.type,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    res.end(method === 'HEAD' ? undefined : body);
  };

  /**
   * Gate for remote requests. Only the pairing page and pairing routes are
   * open to unpaired devices. Everything else needs a paired device holding
   * the route's scope, and `local` routes are refused whatever it holds.
   */
  const checkRemote = (req: IncomingMessage, ctx: RequestContext, method: string, path: string, isWrite: boolean): RouteAccess | null => {
    const read = method === 'GET' || method === 'HEAD';
    const access: RouteAccess | null = path.startsWith('/api/')
      ? routeAccess(method, path)
      : read && PAIR_STATIC[path]
        ? 'pairing'
        : read && STATIC[path]
          ? 'view'
          : null;
    // Browsers always send Origin on writes; from a phone it must be the tailnet page
    if (isWrite && req.headers.origin !== `https://${phoneHost}`) throw new HttpError(403, 'Cross-origin request refused.');
    if (access === 'pairing') return access;
    ctx.device = authenticate(req, ctx.login!);
    if (!ctx.device) return null;
    if (access === null) throw new HttpError(404, 'Not found.');
    if (access === 'local') throw new HttpError(403, 'That can only be done on the computer running ContextDeck.');
    // Starting a run: the exact scopes depend on the body, checked in the handler
    if (access === 'runs') {
      if (!ctx.device.scopes.includes('run') && !ctx.device.scopes.includes('handoff')) throw new HttpError(403, 'This device isn’t allowed to start agents. You can change what it may do on your computer.');
      return access;
    }
    if (!ctx.device.scopes.includes(access)) throw new HttpError(403, 'This device isn’t allowed to do that. You can change what it may do on your computer.');
    return access;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? ''}`);
    const method = req.method ?? 'GET';
    const path = url.pathname;
    const isWrite = method !== 'GET' && method !== 'HEAD';

    let access: RouteAccess | null = null;
    if (ctx.remote) {
      access = checkRemote(req, ctx, method, path, isWrite);
      if (access === null) {
        // Not paired (or not any more): the pairing page, and nothing else
        if (method === 'GET' && path === '/') return servePairPage(res, method, PAIR_STATIC['/pair']!);
        throw new HttpError(401, 'This device isn’t paired with ContextDeck. Scan the code on your computer to pair it.');
      }
      if (access === 'pairing' && !path.startsWith('/api/')) return servePairPage(res, method, PAIR_STATIC[path]!);
    }

    // Pairing routes are the one kind of write an unpaired phone makes, so they have no token
    if (isWrite && access !== 'pairing') {
      const origin = req.headers.origin;
      if (origin && !allowedOrigins(ctx).has(origin)) throw new HttpError(403, 'Cross-origin request refused.');
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

    if (method === 'GET' && path === '/api/board') return send(res, 200, board(ctx));

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
        const words = store.search(q, { provider, limit: 200 });
        const found = await meaning.search(q, words, 200);
        const providerId = provider ? (getAdapter(provider)?.id ?? provider) : null;
        const hits = providerId ? found.hits.filter((h) => h.session.provider === providerId) : found.hits;
        const decisions = q.trim() ? allDecisions().filter((d) => decisionMatches(d, q) && (!provider || d.session?.provider === provider)) : [];
        return send(res, 200, {
          query: q,
          hits,
          decisions: decisions.map(decisionView),
          meaning: { used: found.usedMeaning, error: found.error },
        });
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
      const body = (await readBody(req)) as { sessionId?: unknown; seq?: unknown; text?: unknown; replaces?: unknown } | null;
      if (!body || typeof body.sessionId !== 'string' || typeof body.seq !== 'number' || typeof body.text !== 'string') {
        throw new HttpError(400, 'Expected {"sessionId", "seq", "text"}.');
      }
      if (body.replaces != null && (typeof body.replaces !== 'string' || !isDecisionId(body.replaces))) throw new HttpError(400, '"replaces" must be a decision id.');
      let created;
      try {
        created = addDecision(cfg.home, store, { sessionId: body.sessionId, seq: body.seq, text: body.text, replaces: (body.replaces as string | undefined) ?? null });
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
      // One change per request: new words, "still true", or undo a replacement
      const body = (await readBody(req)) as { text?: unknown; stillTrue?: unknown; restore?: unknown } | null;
      const ok = body && (typeof body.text === 'string' || body.stillTrue === true || body.restore === true);
      if (!ok) throw new HttpError(400, 'Expected {"text"}, {"stillTrue": true} or {"restore": true}.');
      let updated;
      try {
        updated =
          typeof body.text === 'string'
            ? updateDecision(cfg.home, id, body.text)
            : body.stillTrue === true
              ? confirmDecision(cfg.home, id)
              : restoreDecision(cfg.home, id);
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
      meaning.kick();
      return send(res, 200, sum);
    }

    if (method === 'GET' && path === '/api/semantic') return send(res, 200, meaning.status());

    // Turn search by meaning on (after checking the model answers) or off
    if (method === 'PUT' && path === '/api/semantic') {
      const body = (await readBody(req)) as { enabled?: unknown; api?: unknown; url?: unknown; model?: unknown; dims?: unknown; drop?: unknown } | null;
      if (!body || typeof body.enabled !== 'boolean') throw new HttpError(400, 'Expected {"enabled": true|false}.');
      if (!body.enabled) return send(res, 200, meaning.disable({ drop: body.drop === true }));
      const input: Partial<SemanticSettings> = {};
      if (body.api === 'ollama' || body.api === 'openai') input.api = body.api;
      if (typeof body.url === 'string' && body.url.trim()) input.url = body.url.trim().replace(/\/+$/, '');
      if (typeof body.model === 'string' && /^[\w.:/@+-]{1,200}$/.test(body.model.trim())) input.model = body.model.trim();
      else if (body.model !== undefined) throw new HttpError(400, 'That model name has characters a model name can’t have.');
      if (typeof body.dims === 'number' && Number.isInteger(body.dims) && body.dims >= 0 && body.dims <= 8192) input.dims = body.dims;
      // Sending session text to another computer is only allowed from the command line, deliberately
      if (input.url && !isLocalUrl(input.url)) {
        throw new HttpError(400, 'That address isn’t on this computer. To send session text to another machine, use `contextdeck semantic enable --url … --allow-remote`.');
      }
      try {
        return send(res, 200, await meaning.enable(input));
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
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

    // ── Pairing, from the phone ──
    if (method === 'POST' && path === '/api/pair') {
      if (!ctx.remote) throw new HttpError(400, 'Pairing happens on the phone: scan the code shown on this computer.');
      const login = ctx.login!;
      const body = (await readBody(req)) as { code?: unknown; name?: unknown } | null;
      const check = codes.consume(body?.code, login);
      if (check !== 'ok') {
        appendAudit(cfg.home, { action: 'pair-refused', login, reason: check });
        if (check === 'too-many') throw new HttpError(429, 'Too many tries. Wait a minute, then scan a new code.');
        throw new HttpError(403, check === 'wrong' ? 'That pairing code isn’t right. Scan the code on your computer again.' : 'That pairing code has expired or was already used. Make a new one on your computer.');
      }
      const file = loadDevices(cfg.home);
      pruneDevices(file);
      const max = loadSettings(cfg.home).phone.maxDevices;
      if (file.devices.length + file.pending.length >= max) {
        appendAudit(cfg.home, { action: 'pair-refused', login, reason: 'too-many-devices' });
        throw new HttpError(409, `This computer already has ${max} phones paired or waiting. Remove one on the computer first.`);
      }
      const claim = newSecret();
      const now = Date.now();
      const pending = {
        id: newPendingId(),
        name: cleanDeviceName(body?.name),
        tailscaleLogin: login,
        claimHash: hashSecret(claim),
        state: 'waiting' as const,
        requestedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + PENDING_MS).toISOString(),
      };
      file.pending.push(pending);
      saveDevices(cfg.home, file);
      appendAudit(cfg.home, { action: 'pair-requested', pendingId: pending.id, login });
      broadcast('devices', devicesView(), { localOnly: true });
      opts.onPairRequest?.({ id: pending.id, name: pending.name, tailscaleLogin: pending.tailscaleLogin });
      res.setHeader('Set-Cookie', cookie(PENDING_COOKIE, claim, '/api/pair', PENDING_MS / 1000));
      return send(res, 202, publicPending(pending));
    }

    if (method === 'GET' && path === '/api/pair/status') {
      if (!ctx.remote) throw new HttpError(400, 'Pairing happens on the phone.');
      const claim = readCookie(req, PENDING_COOKIE);
      const file = loadDevices(cfg.home);
      const pruned = pruneDevices(file);
      const p = claim ? findByHash(file.pending, claim, (x) => x.claimHash) : null;
      if (!p || p.tailscaleLogin !== ctx.login) {
        if (pruned) saveDevices(cfg.home, file);
        return send(res, 200, { state: 'expired' });
      }
      if (p.state === 'waiting') {
        if (pruned) saveDevices(cfg.home, file);
        return send(res, 200, { state: 'waiting', name: p.name, tailscaleLogin: p.tailscaleLogin });
      }
      file.pending = file.pending.filter((x) => x !== p);
      const clearPending = cookie(PENDING_COOKIE, '', '/api/pair', 0);
      if (p.state === 'denied') {
        saveDevices(cfg.home, file);
        res.setHeader('Set-Cookie', clearPending);
        return send(res, 200, { state: 'denied' });
      }
      const secret = newSecret();
      const now = Date.now();
      const device: Device = {
        id: newDeviceId(),
        name: p.name,
        tailscaleLogin: p.tailscaleLogin,
        secretHash: hashSecret(secret),
        scopes: [...DEFAULT_SCOPES],
        createdAt: new Date(now).toISOString(),
        lastSeenAt: new Date(now).toISOString(),
        expiresAt: idleExpiry(now, loadSettings(cfg.home).phone.deviceIdleDays),
      };
      file.devices.push(device);
      saveDevices(cfg.home, file);
      appendAudit(cfg.home, { action: 'pair-claimed', deviceId: device.id, pendingId: p.id, login: device.tailscaleLogin });
      broadcast('devices', devicesView(), { localOnly: true });
      res.setHeader('Set-Cookie', [cookie(DEVICE_COOKIE, secret, '/', DEVICE_COOKIE_MAX_AGE), clearPending]);
      return send(res, 200, { state: 'approved', device: publicDevice(device) });
    }

    // ── Devices, on this computer ──
    if (method === 'POST' && path === '/api/pair/code') {
      if (!phoneHost) throw new HttpError(409, 'Phone mode is off. Start ContextDeck with `contextdeck ui --phone`.');
      const made = newPairingCode()!;
      return send(res, 200, { ...made, svg: qrSvg(made.url) });
    }

    if (method === 'GET' && path === '/api/devices') return send(res, 200, devicesView());

    if (method === 'POST' && path.startsWith('/api/devices/pending/')) {
      const id = decodeURIComponent(path.slice('/api/devices/pending/'.length));
      const body = (await readBody(req)) as { allow?: unknown } | null;
      if (!body || typeof body.allow !== 'boolean') throw new HttpError(400, 'Expected {"allow": true|false}.');
      const file = loadDevices(cfg.home);
      pruneDevices(file);
      const p = isPendingId(id) ? file.pending.find((x) => x.id === id && x.state === 'waiting') : undefined;
      if (!p) throw new HttpError(404, 'That pairing request has expired or was already answered.');
      p.state = body.allow ? 'approved' : 'denied';
      saveDevices(cfg.home, file);
      appendAudit(cfg.home, { action: body.allow ? 'pair-approved' : 'pair-denied', pendingId: p.id, login: p.tailscaleLogin });
      broadcast('devices', devicesView(), { localOnly: true });
      return send(res, 200, publicPending(p));
    }

    if (method === 'PUT' && path.startsWith('/api/devices/')) {
      const id = decodeURIComponent(path.slice('/api/devices/'.length));
      const body = (await readBody(req)) as { scopes?: unknown } | null;
      const scopes = body?.scopes;
      if (!Array.isArray(scopes) || !scopes.every(isScope) || !scopes.includes('view')) {
        throw new HttpError(400, 'Expected {"scopes": [...]} with known scopes, including "view".');
      }
      const file = loadDevices(cfg.home);
      const d = isDeviceId(id) ? file.devices.find((x) => x.id === id) : undefined;
      if (!d) throw new HttpError(404, 'No such device.');
      d.scopes = [...new Set(scopes)];
      saveDevices(cfg.home, file);
      appendAudit(cfg.home, { action: 'device-scopes', deviceId: d.id, scopes: d.scopes });
      broadcast('devices', devicesView(), { localOnly: true });
      return send(res, 200, publicDevice(loadDevices(cfg.home).devices.find((x) => x.id === id)!));
    }

    if (method === 'DELETE' && path.startsWith('/api/devices/')) {
      const id = decodeURIComponent(path.slice('/api/devices/'.length));
      if (id !== 'all' && !isDeviceId(id)) throw new HttpError(404, 'No such device.');
      const revoked = revokeDevices(cfg.home, id);
      if (id !== 'all' && !revoked.length) throw new HttpError(404, 'No such device.');
      for (const r of revoked) appendAudit(cfg.home, { action: 'device-revoked', deviceId: r });
      closeStaleStreams(revoked);
      broadcast('devices', devicesView(), { localOnly: true });
      return send(res, 200, { revoked });
    }

    // ── Runs ──
    if (method === 'GET' && path === '/api/runs') return send(res, 200, { runs: runs.list() });

    if (method === 'GET' && path.startsWith('/api/runs/')) {
      const id = decodeURIComponent(path.slice('/api/runs/'.length));
      const found = isRunId(id) ? runs.get(id) : null;
      if (!found) throw new HttpError(404, 'No such run.');
      return send(res, 200, found);
    }

    if (method === 'POST' && path === '/api/runs') {
      const body = (await readBody(req)) as Record<string, unknown> | null;
      if (!body || typeof body !== 'object') throw new HttpError(400, 'Expected {"kind", "mode", …}.');
      if (ctx.remote) {
        const missing = runScopes(String(body.kind), String(body.mode)).filter((x) => !ctx.device!.scopes.includes(x));
        if (missing.length) {
          throw new HttpError(
            403,
            missing.includes('edit') ? 'This device may only start runs in Plan only. You can change that on your computer.' : 'This device isn’t allowed to start that. You can change what it may do on your computer.',
          );
        }
      }
      try {
        const run = runs.start(body as unknown as RunRequest, ctx.device ? { deviceId: ctx.device.id, name: ctx.device.name } : { deviceId: null, name: 'This computer' });
        return send(res, 202, run);
      } catch (err) {
        if (err instanceof RunError) throw new HttpError(err.status, err.message);
        throw err;
      }
    }

    if (method === 'DELETE' && path.startsWith('/api/runs/')) {
      const id = decodeURIComponent(path.slice('/api/runs/'.length));
      if (!isRunId(id)) throw new HttpError(404, 'No such run.');
      try {
        return send(res, 200, runs.cancel(id, ctx.device ? `Stopped from ${ctx.device.name}.` : 'Stopped.'));
      } catch (err) {
        if (err instanceof RunError) throw new HttpError(err.status, err.message);
        throw err;
      }
    }

    if (method === 'GET' && path === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Content-Type-Options': 'nosniff',
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ version })}\n\n`);
      clients.set(res, ctx.device?.id ?? null);
      req.on('close', () => clients.delete(res));
      return;
    }

    throw new HttpError(404, 'Not found.');
  };

  const server: Server = createServer((req, res) => {
    let ctx: RequestContext | null = null;
    // Every write a paired device makes goes in the audit log: route and outcome only
    res.on('finish', () => {
      if (ctx?.device && req.method !== 'GET' && req.method !== 'HEAD') {
        const route = new URL(req.url ?? '/', 'http://x').pathname;
        appendAudit(cfg.home, { action: 'write', deviceId: ctx.device.id, method: req.method, route, status: res.statusCode });
      }
    });
    Promise.resolve()
      .then(() => {
        ctx = requestContext(req);
        return handle(req, res, ctx);
      })
      .catch((err: unknown) => {
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
      if (summary.indexed || summary.removed) meaning.kick();
    });
  }
  const stopMeaningEvents = meaning.onChange((status) => broadcast('semantic', status));
  meaning.kick();
  const heartbeat = setInterval(() => {
    for (const res of clients.keys()) res.write(': keep-alive\n\n');
  }, 25_000);
  // Revoking from the CLI, or a device expiring, closes its streams within a second
  const sweep = phoneHost ? setInterval(() => closeStaleStreams(), 1000) : null;

  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    token,
    pairingCode: newPairingCode,
    close: async () => {
      clearInterval(heartbeat);
      if (sweep) clearInterval(sweep);
      watcher?.close();
      stopMeaningEvents();
      meaning.stop();
      // Agents get asked to stop first, so they can record the turn
      await runs.stopAll();
      for (const res of clients.keys()) res.end();
      clients.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
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
