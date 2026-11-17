import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAudit } from './audit.js';
import { redact } from './util/redact.js';

/**
 * Approvals: an "ask me first" run sends each permission request to you.
 *
 * Claude Code is started with `--permission-prompt-tool mcp__contextdeck__approve`
 * and an MCP config that runs `contextdeck approver`, a tiny MCP server
 * (JSON-RPC over stdio, below). For every request it connects to this hub
 * over a local channel (a Unix socket in a private temp folder, or a named
 * pipe on Windows), authenticated with a secret made for that run, and waits
 * for your answer. You answer on the computer, or on a phone with the
 * `approve` scope. Unanswered requests are denied after a time limit.
 *
 * What the tool must return was checked against the Claude Code docs
 * (errors reference, "Permission prompt tool returned an invalid result"):
 * one text block whose text is `{"behavior":"allow"}` (optionally with
 * `updatedInput`) or `{"behavior":"deny","message":"…"}`. Before Claude Code
 * 2.1.207 an allow needed `updatedInput`, so it is always sent, unchanged.
 * The request's own fields aren't documented there; `tool_name`, `input` and
 * `tool_use_id` are expected, and the camelCase spellings are accepted too.
 */

export const APPROVER_SERVER = 'contextdeck';
export const APPROVER_TOOL = 'approve';
export const APPROVER_TOOL_NAME = `mcp__${APPROVER_SERVER}__${APPROVER_TOOL}`;

const MAX_LINE = 1024 * 1024;
const MAX_TEXT = 4000;

/** What you see on an approval card. */
export type ApprovalDetail =
  | { kind: 'command'; command: string; description: string | null }
  | { kind: 'edit'; path: string; changes: { before: string; after: string }[] }
  | { kind: 'write'; path: string; text: string }
  | { kind: 'other'; text: string };

export interface Approval {
  id: string;
  runId: string;
  tool: string;
  detail: ApprovalDetail;
  cwd: string;
  createdAt: string;
  expiresAt: string;
}

export type ApprovalDecision = { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string };

export interface ApprovalHubOptions {
  home: string;
  timeoutMs?: number;
  /** A request arrived (`asked`) or went away (`answered`). */
  onChange?: (approval: Approval, change: 'asked' | 'answered') => void;
  platform?: NodeJS.Platform;
}

interface Pending {
  approval: Approval;
  input: Record<string, unknown>;
  respond: (d: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

export const isApprovalId = (id: string) => /^ap_[0-9a-f]{10}$/.test(id);

const cut = (s: string, max = MAX_TEXT) => (s.length > max ? `${s.slice(0, max)}\n…` : s);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** A request as a card: the command, the change, or the input. Redacted, like everything shown. */
export function describeRequest(tool: string, input: Record<string, unknown>): ApprovalDetail {
  const path = str(input.file_path) || str(input.notebook_path) || str(input.path) || str(input.absolute_path);
  if (typeof input.command === 'string') return { kind: 'command', command: redact(cut(input.command)), description: str(input.description) ? redact(cut(str(input.description), 300)) : null };
  if (path && typeof input.old_string === 'string') {
    return { kind: 'edit', path, changes: [{ before: redact(cut(input.old_string)), after: redact(cut(str(input.new_string))) }] };
  }
  if (path && Array.isArray(input.edits)) {
    const changes = input.edits.slice(0, 20).map((e) => ({ before: redact(cut(str((e as Record<string, unknown>)?.old_string), 1500)), after: redact(cut(str((e as Record<string, unknown>)?.new_string), 1500)) }));
    return { kind: 'edit', path, changes };
  }
  if (path && typeof input.content === 'string') return { kind: 'write', path, text: redact(cut(input.content)) };
  let text: string;
  try {
    text = JSON.stringify(input, null, 2);
  } catch {
    text = String(input);
  }
  return { kind: 'other', text: redact(cut(text || tool)) };
}

export class ApprovalHub {
  private server: Server | null = null;
  private dir: string | null = null;
  private address = '';
  private readonly runs = new Map<string, { secret: string; cwd: string }>();
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<NonNullable<ApprovalHubOptions['onChange']>>();
  private readonly o: Required<Omit<ApprovalHubOptions, 'onChange'>> & ApprovalHubOptions;

  constructor(opts: ApprovalHubOptions) {
    this.o = { timeoutMs: 10 * 60_000, platform: process.platform, ...opts };
    if (opts.onChange) this.listeners.add(opts.onChange);
  }

  /** Hear about requests arriving and going away. Returns a function that stops it. */
  listen(fn: NonNullable<ApprovalHubOptions['onChange']>): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(approval: Approval, change: 'asked' | 'answered'): void {
    for (const fn of this.listeners) fn(approval, change);
  }

  /** Listen on a private local channel. */
  async start(): Promise<void> {
    if (this.server) return;
    if (this.o.platform === 'win32') this.address = `\\\\.\\pipe\\contextdeck-${randomBytes(12).toString('hex')}`;
    else {
      // A folder only you can open (mkdtemp makes it 0700), short enough for a socket path
      this.dir = mkdtempSync(join(tmpdir(), 'cd-'));
      this.address = join(this.dir, 'approvals.sock');
    }
    const server = createServer((socket) => this.connection(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.address, () => resolve());
    });
    this.server = server;
  }

  /** A run that may ask: its secret and where to reach the hub, as environment for the approver. */
  register(runId: string, cwd: string): Record<string, string> {
    if (!this.server) throw new Error('Approvals aren’t running.');
    const secret = randomBytes(32).toString('base64url');
    this.runs.set(runId, { secret, cwd });
    return { CONTEXTDECK_APPROVER_SOCKET: this.address, CONTEXTDECK_APPROVER_SECRET: secret, CONTEXTDECK_RUN_ID: runId };
  }

  /** The run ended: anything still waiting is denied. */
  unregister(runId: string): void {
    this.runs.delete(runId);
    for (const p of [...this.pending.values()]) if (p.approval.runId === runId) this.settle(p, { behavior: 'deny', message: 'The run ended before anyone answered.' }, 'run-ended');
  }

  list(): Approval[] {
    return [...this.pending.values()].map((p) => p.approval).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Allow once, or deny. Throws if the request is gone. */
  answer(id: string, allow: boolean, by: { deviceId: string | null; name: string }): Approval {
    const p = this.pending.get(id);
    if (!p) throw new Error('That request was already answered, or it timed out.');
    this.settle(
      p,
      allow ? { behavior: 'allow', updatedInput: p.input } : { behavior: 'deny', message: `${by.name === 'This computer' ? 'The person' : by.name} said no. Don’t try this again; ask what to do instead.` },
      allow ? 'allowed' : 'denied',
      by.deviceId,
    );
    return p.approval;
  }

  async close(): Promise<void> {
    for (const p of [...this.pending.values()]) this.settle(p, { behavior: 'deny', message: 'ContextDeck was closed.' }, 'closed');
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
    this.dir = null;
  }

  private settle(p: Pending, decision: ApprovalDecision, outcome: string, deviceId?: string | null): void {
    if (!this.pending.delete(p.approval.id)) return;
    clearTimeout(p.timer);
    p.respond(decision);
    appendAudit(this.o.home, { action: 'approval-answered', runId: p.approval.runId, deviceId: deviceId ?? undefined, reason: outcome, provider: p.approval.tool });
    this.changed(p.approval, 'answered');
  }

  private connection(socket: Socket): void {
    let buf = '';
    let done = false;
    let pending: Pending | null = null;
    const reply = (d: ApprovalDecision) => {
      if (done) return;
      done = true;
      socket.end(JSON.stringify(d) + '\n');
    };
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    // The approver went away (the run was stopped): forget its request
    socket.on('close', () => {
      done = true;
      if (pending && this.pending.has(pending.approval.id)) this.settle(pending, { behavior: 'deny', message: 'Cancelled.' }, 'cancelled');
    });
    socket.on('data', (chunk: string) => {
      if (pending || done) return;
      buf += chunk;
      if (buf.length > MAX_LINE) return reply({ behavior: 'deny', message: 'The request was too large.' });
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(buf.slice(0, nl));
      } catch {
        return reply({ behavior: 'deny', message: 'ContextDeck couldn’t read the request.' });
      }
      const run = this.runs.get(str(msg.runId));
      const given = Buffer.from(str(msg.secret));
      const want = Buffer.from(run?.secret ?? '');
      if (!run || given.length !== want.length || !timingSafeEqual(given, want)) {
        return reply({ behavior: 'deny', message: 'This request isn’t from a run ContextDeck started.' });
      }
      const tool = str(msg.tool) || 'tool';
      const input = msg.input && typeof msg.input === 'object' && !Array.isArray(msg.input) ? (msg.input as Record<string, unknown>) : {};
      const now = Date.now();
      const approval: Approval = {
        id: `ap_${randomBytes(5).toString('hex')}`,
        runId: str(msg.runId),
        tool: cut(tool, 200),
        detail: describeRequest(tool, input),
        cwd: run.cwd,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + this.o.timeoutMs).toISOString(),
      };
      const minutes = Math.round(this.o.timeoutMs / 60_000);
      pending = {
        approval,
        input,
        respond: reply,
        timer: setTimeout(() => {
          if (pending) this.settle(pending, { behavior: 'deny', message: `Nobody answered within ${minutes} minute${minutes === 1 ? '' : 's'}, so it was denied. Ask before trying again.` }, 'timed-out');
        }, this.o.timeoutMs),
      };
      this.pending.set(approval.id, pending);
      appendAudit(this.o.home, { action: 'approval-asked', runId: approval.runId, provider: tool });
      this.changed(approval, 'asked');
    });
  }
}

// ── The approver: an MCP server on stdio ──────────────────────────────────

/** Ask the hub, and wait for the answer. Any failure is a deny, never an allow. */
function askHub(env: NodeJS.ProcessEnv, tool: string, input: unknown, toolUseId: string): Promise<ApprovalDecision> {
  return new Promise((resolve) => {
    const deny = (message: string) => resolve({ behavior: 'deny', message });
    const address = env.CONTEXTDECK_APPROVER_SOCKET;
    if (!address || !env.CONTEXTDECK_APPROVER_SECRET) return deny('ContextDeck’s approver isn’t set up for this run.');
    const socket = connect(address);
    let buf = '';
    let settled = false;
    const finish = (d: ApprovalDecision) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(d);
    };
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(JSON.stringify({ runId: env.CONTEXTDECK_RUN_ID, secret: env.CONTEXTDECK_APPROVER_SECRET, tool, input, toolUseId }) + '\n');
    });
    socket.on('data', (c: string) => {
      buf += c;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try {
        const d = JSON.parse(buf.slice(0, nl)) as ApprovalDecision;
        finish(d.behavior === 'allow' ? { behavior: 'allow', updatedInput: (d.updatedInput ?? {}) as Record<string, unknown> } : { behavior: 'deny', message: str((d as { message?: unknown }).message) || 'Denied.' });
      } catch {
        finish({ behavior: 'deny', message: 'ContextDeck gave an answer that couldn’t be read.' });
      }
    });
    socket.on('error', () => finish({ behavior: 'deny', message: 'ContextDeck isn’t reachable, so this was denied.' }));
    socket.on('close', () => finish({ behavior: 'deny', message: 'ContextDeck closed the request without an answer.' }));
  });
}

/**
 * `contextdeck approver`: a minimal MCP server (JSON-RPC 2.0, one message per
 * line on stdin/stdout) with one tool, `approve`. It writes nothing else to
 * stdout. Resolves when stdin closes.
 */
export async function runApprover(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, env: NodeJS.ProcessEnv, version: string): Promise<void> {
  const send = (msg: unknown) => output.write(JSON.stringify(msg) + '\n');
  const tasks: Promise<void>[] = [];
  const handle = async (msg: Record<string, unknown>) => {
    const id = msg.id;
    const isRequest = id !== undefined && id !== null;
    const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>;
    switch (msg.method) {
      case 'initialize':
        return send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: APPROVER_SERVER, version },
          },
        });
      case 'ping':
        return isRequest ? send({ jsonrpc: '2.0', id, result: {} }) : undefined;
      case 'tools/list':
        return send({
          jsonrpc: '2.0',
          id,
          result: {
            tools: [
              {
                name: APPROVER_TOOL,
                description: 'Asks the person using ContextDeck to allow or deny a tool call. Used by Claude Code as its permission prompt tool.',
                inputSchema: {
                  type: 'object',
                  properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
                  required: ['tool_name', 'input'],
                },
              },
            ],
          },
        });
      case 'tools/call': {
        if (params.name !== APPROVER_TOOL) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${String(params.name)}` } });
        const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
        const tool = str(args.tool_name) || str(args.toolName) || 'tool';
        const toolInput = args.input ?? args.tool_input ?? {};
        const decision = await askHub(env, tool, toolInput, str(args.tool_use_id) || str(args.toolUseId));
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(decision) }] } });
      }
      default:
        // Notifications (no id) need no answer; unknown requests get "method not found"
        return isRequest ? send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${String(msg.method)}` } }) : undefined;
    }
  };

  let buf = '';
  await new Promise<void>((resolve) => {
    input.setEncoding?.('utf8');
    input.on('data', (chunk: string | Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line);
        } catch {
          send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
          continue;
        }
        tasks.push(handle(msg).then(
          () => {},
          () => {},
        ));
      }
    });
    input.on('end', () => resolve());
    input.on('close', () => resolve());
  });
  await Promise.all(tasks);
}
