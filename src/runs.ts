import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPROVER_SERVER, APPROVER_TOOL_NAME, type ApprovalHub } from './approvals.js';
import { getAdapter } from './adapters/index.js';
import { RUN_MODES, type Approver, type HeadlessCommand, type RunEvent, type RunMode } from './adapters/types.js';
import { appendAudit } from './audit.js';
import { finalizeBrief, saveBrief } from './handoff.js';
import { HANDOFF_ID_RE } from './handoff-marker.js';
import { reindexSession, type IndexSummary, type Source } from './indexer.js';
import type { SessionRow } from './schema.js';
import type { Store } from './store.js';
import { redact } from './util/redact.js';

/**
 * Runs: one headless turn of an agent on this computer, started from the
 * canvas or a phone, watched live and stoppable.
 *
 * - Each run is one turn: continue a session ("resume"), start one in a
 *   folder ("new"), or hand a session off to a tool ("handoff", the brief
 *   is the prompt).
 * - Only two modes, from the adapter's fixed table: Plan only, or Edit this
 *   folder. Nothing a request sends becomes an argument; the prompt goes on
 *   stdin.
 * - Folder trust: a run happens only in a folder where that tool already has
 *   sessions (you've used it there yourself), unless the tool applies its own
 *   folder trust in headless mode. Claude Code's `-p` loads a folder's hooks
 *   and `.mcp.json` without asking, so this matters.
 * - One run at a time per session, a few waiting behind it, and a cap on runs
 *   at once overall. Runs stop after a time limit.
 * - Logs: ~/.contextdeck/runs/<id>.jsonl, owner-only, events only (never the
 *   prompt or raw output), redacted. The last 50 runs or 7 days are kept.
 */

export type RunKind = 'resume' | 'new' | 'handoff';
export const RUN_KINDS: readonly RunKind[] = ['resume', 'new', 'handoff'];
export type RunState = 'queued' | 'running' | 'done' | 'failed' | 'stopped';

export interface RunInfo {
  id: string;
  kind: RunKind;
  /** The tool that runs. */
  provider: string;
  providerLabel: string;
  mode: RunMode;
  cwd: string;
  /** The session the run continues, or (for new and handoff runs) the one it started, once known. */
  sessionId: string | null;
  /** The session a handoff came from. */
  fromSessionId: string | null;
  handoffId: string | null;
  state: RunState;
  /** Why it stopped or failed, in words. */
  reason: string | null;
  /** The tool's final reply or error, when it gave one. */
  summary: string | null;
  costUsd: number | null;
  startedBy: { deviceId: string | null; name: string };
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface RunRequest {
  kind: unknown;
  mode: unknown;
  prompt?: unknown;
  /** resume: the session to continue. handoff: the session to hand off. */
  sessionId?: unknown;
  /** new and handoff: the tool to run. */
  to?: unknown;
  /** new: the folder. */
  cwd?: unknown;
  /** handoff: the brief, and its id from the preview. */
  brief?: unknown;
  handoffId?: unknown;
}

export class RunError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RunManagerOptions {
  store: Store;
  sources: Source[];
  home: string;
  maxConcurrent?: number;
  /** Waiting runs per session. */
  maxQueuedPerSession?: number;
  /** Waiting runs overall. */
  maxQueued?: number;
  timeoutMs?: number;
  /** Batch reply text for this long before passing it on. */
  textBatchMs?: number;
  /** After asking a run to stop: SIGTERM after this long, SIGKILL after `killMs`. */
  termMs?: number;
  killMs?: number;
  /** Keep the computer awake while runs are active (macOS, Linux). */
  keepAwake?: boolean;
  platform?: NodeJS.Platform;
  /** Change the command before it is spawned (tests run fake agents with node). */
  wrapCommand?: (cmd: HeadlessCommand) => HeadlessCommand;
  onChange?: (run: RunInfo) => void;
  onEvents?: (runId: string, events: RunEvent[]) => void;
  onIndexed?: (summary: IndexSummary) => void;
  /** Where "ask me first" runs send permission requests. Without it, `ask` is refused. */
  approvals?: ApprovalHub;
  /** Environment for tools' own folder checks (Codex reads CODEX_HOME). Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** How Claude Code starts the approver (tests). Default: this Node running `contextdeck approver`. */
  approverCommand?: { command: string; args: string[] };
}

const CLI = fileURLToPath(new URL('../../bin/contextdeck.js', import.meta.url));

const MAX_PROMPT = 200_000;
const MAX_LINE = 1024 * 1024;
const MAX_EVENTS = 2000;
const KEEP_RUNS = 50;
const KEEP_DAYS = 7;
const RUN_ID_RE = /^run_[0-9a-f]{10}$/;
const RUN_MODE_ERR = 'Expected "mode" to be "plan", "edit" or "ask".';

export const isRunId = (id: string) => RUN_ID_RE.test(id);

interface Live {
  info: RunInfo;
  command: HeadlessCommand;
  prompt: string;
  events: RunEvent[];
  child: ChildProcess | null;
  awake: ChildProcess | null;
  timers: NodeJS.Timeout[];
  text: { delta: string; start: boolean } | null;
  textTimer: NodeJS.Timeout | null;
  done: Extract<RunEvent, { type: 'done' }> | null;
  stopReason: string | null;
  failReason: string | null;
  stderr: string;
  finished: boolean;
  /** For ask runs: the private folder holding the approver's MCP config. */
  approverDir: string | null;
}

export class RunManager {
  private readonly runs = new Map<string, Live>();
  private readonly order: string[] = [];
  private readonly o: Required<Omit<RunManagerOptions, 'wrapCommand' | 'onChange' | 'onEvents' | 'onIndexed' | 'approvals' | 'approverCommand' | 'env'>> & RunManagerOptions;

  constructor(opts: RunManagerOptions) {
    this.o = {
      maxConcurrent: 3,
      maxQueuedPerSession: 3,
      maxQueued: 10,
      timeoutMs: 30 * 60_000,
      textBatchMs: 100,
      termMs: 5000,
      killMs: 10_000,
      keepAwake: true,
      platform: process.platform,
      ...opts,
    };
    this.pruneLogs();
  }

  // ── Starting ────────────────────────────────────────────────────────────

  /** Check a request and queue the run. Throws RunError with a readable message. */
  start(req: RunRequest, startedBy: { deviceId: string | null; name: string }): RunInfo {
    const kind = req.kind as RunKind;
    if (!RUN_KINDS.includes(kind)) throw new RunError(400, 'Expected "kind" to be "resume", "new" or "handoff".');
    const mode = req.mode as RunMode;
    if (!RUN_MODES.includes(mode)) throw new RunError(400, RUN_MODE_ERR);

    let provider: string;
    let cwd: string;
    let build: (approver?: Approver) => HeadlessCommand;
    let prompt: string;
    let sessionId: string | null = null;
    let fromSessionId: string | null = null;
    let handoffId: string | null = null;

    if (kind === 'resume') {
      const s = this.session(req.sessionId);
      if (s.isSubagent) throw new RunError(400, 'A subagent can’t be continued on its own. Open the conversation that started it.');
      provider = s.provider;
      cwd = this.folder(s.cwd);
      this.checkTrust(provider, cwd);
      build = (a) => this.driver(provider).continueArgs(s, mode, a);
      prompt = this.prompt(req.prompt);
      sessionId = s.id;
    } else if (kind === 'new') {
      provider = this.tool(req.to);
      if (typeof req.cwd !== 'string' || !isAbsolute(req.cwd)) throw new RunError(400, 'Expected "cwd" to be a full folder path.');
      cwd = this.folder(resolve(req.cwd));
      this.checkTrust(provider, cwd);
      build = (a) => this.driver(provider).startArgs(cwd, mode, a);
      prompt = this.prompt(req.prompt);
    } else {
      const from = this.session(req.sessionId);
      provider = this.tool(req.to);
      if (typeof req.handoffId !== 'string' || !HANDOFF_ID_RE.test(req.handoffId)) throw new RunError(400, 'Expected the "handoffId" from the preview.');
      if (typeof req.brief !== 'string') throw new RunError(400, 'Expected "brief".');
      cwd = this.folder(from.cwd);
      this.checkTrust(provider, cwd);
      build = (a) => this.driver(provider).startArgs(cwd, mode, a);
      try {
        prompt = finalizeBrief(req.brief, req.handoffId, from.id);
      } catch (err) {
        throw new RunError(400, (err as Error).message);
      }
      fromSessionId = from.id;
      handoffId = req.handoffId;
    }
    if (mode === 'ask') {
      const label = getAdapter(provider)?.label ?? provider;
      if (!this.driver(provider).supportsAsk) throw new RunError(400, `${label} can’t ask for approval here. Choose Plan only or Edit this folder.`);
      if (!this.o.approvals) throw new RunError(501, 'Approvals aren’t available here.');
    }
    // Check the command can be built before anything is set up for it
    const draft = build(mode === 'ask' ? { mcpConfig: '-', tool: APPROVER_TOOL_NAME } : undefined);
    this.checkSpawnable(draft, provider);

    const waiting = [...this.runs.values()].filter((r) => r.info.state === 'queued');
    if (waiting.length >= this.o.maxQueued) throw new RunError(429, 'Too many runs are waiting. Wait for some to finish, or stop one.');
    if (sessionId && waiting.filter((r) => r.info.sessionId === sessionId).length >= this.o.maxQueuedPerSession) {
      throw new RunError(429, `${this.o.maxQueuedPerSession} messages are already waiting for this session. Wait for them, or stop one.`);
    }
    if (kind === 'handoff') saveBrief(this.o.home, req.handoffId as string, prompt);

    const id = `run_${randomBytes(5).toString('hex')}`;
    // Ask me first: a private MCP config that starts the approver for this run only
    let approverDir: string | null = null;
    let command = draft;
    if (mode === 'ask') {
      approverDir = mkdtempSync(join(tmpdir(), 'cd-run-'));
      const mcpConfig = join(approverDir, 'mcp.json');
      const launcher = this.o.approverCommand ?? { command: process.execPath, args: [CLI, 'approver'] };
      const env = this.o.approvals!.register(id, cwd);
      writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { [APPROVER_SERVER]: { type: 'stdio', command: launcher.command, args: launcher.args, env } } }), { mode: 0o600 });
      command = build({ mcpConfig, tool: APPROVER_TOOL_NAME });
    }

    const info: RunInfo = {
      id,
      kind,
      provider,
      providerLabel: getAdapter(provider)?.label ?? provider,
      mode,
      cwd,
      sessionId,
      fromSessionId,
      handoffId,
      state: 'queued',
      reason: null,
      summary: null,
      costUsd: null,
      startedBy,
      queuedAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
    };
    const live: Live = {
      info,
      command,
      prompt,
      events: [],
      child: null,
      awake: null,
      timers: [],
      text: null,
      textTimer: null,
      done: null,
      stopReason: null,
      failReason: null,
      stderr: '',
      finished: false,
      approverDir,
    };
    this.runs.set(info.id, live);
    this.order.push(info.id);
    this.trimHistory();
    this.log(live, { type: 'run', run: info });
    appendAudit(this.o.home, { action: 'run-started', runId: info.id, deviceId: startedBy.deviceId ?? undefined, kind, provider, mode });
    this.changed(live);
    this.pump();
    return { ...live.info };
  }

  private session(ref: unknown): SessionRow {
    if (typeof ref !== 'string' || !ref) throw new RunError(400, 'Expected "sessionId".');
    try {
      return this.o.store.resolve(ref);
    } catch (err) {
      throw new RunError(404, (err as Error).message);
    }
  }

  private tool(id: unknown): string {
    const a = typeof id === 'string' ? getAdapter(id) : undefined;
    if (!a?.headless) throw new RunError(400, `ContextDeck can’t run "${String(id)}" from here.`);
    return a.id;
  }

  private driver(provider: string) {
    const d = getAdapter(provider)?.headless;
    if (!d) throw new RunError(400, `ContextDeck can’t run ${getAdapter(provider)?.label ?? provider} from here.`);
    return d;
  }

  private folder(cwd: string | null): string {
    if (!cwd) throw new RunError(400, 'This session didn’t record its project folder, so nothing can run there.');
    if (!existsSync(cwd)) throw new RunError(400, `The folder ${cwd} isn’t on this computer any more.`);
    return cwd;
  }

  private prompt(p: unknown): string {
    if (typeof p !== 'string' || !p.trim()) throw new RunError(400, 'Write a message first.');
    if (p.length > MAX_PROMPT) throw new RunError(400, `That message is too long (${p.length} characters; the limit is ${MAX_PROMPT}).`);
    return p;
  }

  /**
   * Only run where you've already used this tool yourself, so a folder's
   * hooks and settings are ones you've seen. A tool that applies its own
   * folder trust in headless mode can run in any folder you've worked in.
   */
  private checkTrust(provider: string, cwd: string): void {
    const here = this.o.store.providersInFolder(cwd);
    const label = getAdapter(provider)?.label ?? provider;
    if (here.includes(provider) || (this.driver(provider).checksFolderTrust && here.length)) {
      // The tool's own rules: say so now, rather than have it fail once started
      const problem = this.driver(provider).folderProblem?.(cwd, this.o.env ?? process.env);
      if (problem) throw new RunError(409, problem);
      return;
    }
    throw new RunError(
      403,
      here.length
        ? `${label} hasn’t been used in ${cwd} yet. Start it there yourself once, on this computer, then it can run there from here.`
        : `No agent has been used in ${cwd} yet, so nothing can run there from here.`,
    );
  }

  /**
   * On Windows a tool installed as a .cmd or .bat script can only start
   * through cmd.exe, which would interpret the arguments. Refuse instead.
   */
  private checkSpawnable(cmd: HeadlessCommand, provider: string): void {
    if (this.o.platform !== 'win32' || this.o.wrapCommand) return;
    const found = findOnPath(cmd.command, process.env);
    if (found && /^\.(cmd|bat)$/i.test(extname(found))) {
      throw new RunError(501, `${getAdapter(provider)?.label ?? provider} is installed as a script (${found}) that can’t be started safely without a shell on Windows.`);
    }
  }

  // ── Running ─────────────────────────────────────────────────────────────

  private active(): Live[] {
    return [...this.runs.values()].filter((r) => r.info.state === 'running');
  }

  /** Start waiting runs while there's room: one per session, a few at once. */
  private pump(): void {
    for (const id of this.order) {
      const r = this.runs.get(id)!;
      if (r.info.state !== 'queued') continue;
      const running = this.active();
      if (running.length >= this.o.maxConcurrent) return;
      if (r.info.sessionId && running.some((x) => x.info.sessionId === r.info.sessionId)) continue;
      this.launch(r);
    }
  }

  private launch(r: Live): void {
    const cmd = this.o.wrapCommand ? this.o.wrapCommand(r.command) : r.command;
    r.info.state = 'running';
    r.info.startedAt = new Date().toISOString();
    this.changed(r);
    let child: ChildProcess;
    try {
      child = spawn(cmd.command, cmd.args, { cwd: cmd.cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      r.failReason = `Couldn’t start ${r.info.providerLabel}: ${(err as Error).message}`;
      this.finish(r, null);
      return;
    }
    r.child = child;
    child.on('error', (err: NodeJS.ErrnoException) => {
      r.failReason =
        err.code === 'ENOENT' ? `Couldn’t start ${r.info.providerLabel}: it isn’t installed, or isn’t on the PATH ContextDeck was started with.` : `Couldn’t start ${r.info.providerLabel}: ${err.message}`;
      this.finish(r, null);
    });
    child.stdin!.on('error', () => {});
    child.stdin!.end(r.prompt);

    let buf = '';
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      if (r.finished) return;
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        this.line(r, buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
      if (buf.length > MAX_LINE) {
        buf = '';
        if (!r.failReason) r.failReason = `${r.info.providerLabel} printed a line longer than 1 MB, which ContextDeck doesn’t read.`;
        this.stop(r);
      }
    });
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
      r.stderr = (r.stderr + chunk).slice(-4000);
    });
    child.on('close', (code) => {
      if (buf) this.line(r, buf);
      this.finish(r, code);
    });

    r.timers.push(
      setTimeout(() => {
        if (!r.finished) this.stopWith(r, `Stopped: it ran longer than ${Math.round(this.o.timeoutMs / 60_000)} minutes.`);
      }, this.o.timeoutMs),
    );
    if (this.o.keepAwake) r.awake = keepAwake(child.pid, this.o.platform, Math.ceil(this.o.timeoutMs / 1000));
  }

  private line(r: Live, line: string): void {
    let events: RunEvent[];
    try {
      events = this.driver(r.info.provider).parseLine(line);
    } catch {
      events = [];
    }
    for (const e of events) {
      if (e.type === 'text') {
        if (e.start && r.text) this.flushText(r);
        r.text ??= { delta: '', start: !!e.start };
        r.text.delta += e.delta;
        r.textTimer ??= setTimeout(() => this.flushText(r), this.o.textBatchMs);
        continue;
      }
      this.flushText(r);
      if (e.type === 'session') {
        if (!r.info.sessionId) {
          r.info.sessionId = `${r.info.provider}:${e.nativeId}`;
          this.changed(r);
        }
        continue;
      }
      if (e.type === 'done') {
        r.done = e;
        continue;
      }
      this.emit(r, [cleanEvent(e)]);
    }
  }

  private flushText(r: Live): void {
    if (r.textTimer) clearTimeout(r.textTimer);
    r.textTimer = null;
    const t = r.text;
    r.text = null;
    if (!t || (!t.delta && !t.start)) return;
    this.emit(r, [{ type: 'text', delta: redact(t.delta), ...(t.start ? { start: true } : {}) }]);
  }

  private emit(r: Live, events: RunEvent[]): void {
    for (const e of events) {
      const last = r.events.at(-1);
      // Keep memory bounded: join text into the previous text event when it continues it
      if (e.type === 'text' && !e.start && last?.type === 'text') last.delta += e.delta;
      else r.events.push(e);
      this.log(r, { type: 'event', event: e });
    }
    if (r.events.length > MAX_EVENTS) r.events.splice(0, r.events.length - MAX_EVENTS);
    this.o.onEvents?.(r.info.id, events);
  }

  private finish(r: Live, code: number | null): void {
    if (r.finished) return;
    r.finished = true;
    this.flushText(r);
    for (const t of r.timers) clearTimeout(t);
    r.timers = [];
    r.awake?.kill();
    r.awake = null;
    this.forgetApprover(r);
    const info = r.info;
    if (r.done?.summary) info.summary = redact(r.done.summary);
    if (r.done?.costUsd != null) info.costUsd = r.done.costUsd;
    if (r.stopReason) {
      info.state = 'stopped';
      info.reason = r.stopReason;
    } else if (r.failReason) {
      info.state = 'failed';
      info.reason = r.failReason;
    } else if (r.done?.ok && code === 0) {
      info.state = 'done';
    } else {
      info.state = 'failed';
      const err = r.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 500);
      info.reason = r.done
        ? `${info.providerLabel} reported a problem.`
        : `${info.providerLabel} stopped without finishing${code != null ? ` (exit code ${code})` : ''}.${err ? ` ${redact(err)}` : ''}`;
    }
    info.endedAt = new Date().toISOString();
    r.prompt = '';
    this.log(r, { type: 'end', run: info });
    appendAudit(this.o.home, { action: 'run-ended', runId: info.id, state: info.state });
    this.changed(r);
    this.pruneLogs();
    // Show the new turn in the reader straight away
    if (info.startedAt) {
      reindexSession(this.o.store, this.o.sources, info.provider, info.sessionId)
        .then((sum) => this.o.onIndexed?.(sum))
        .catch(() => {});
    }
    this.pump();
  }

  /** The run is over: deny what it still waits for, and delete its approver config. */
  private forgetApprover(r: Live): void {
    if (r.info.mode !== 'ask') return;
    this.o.approvals?.unregister(r.info.id);
    if (r.approverDir) rmSync(r.approverDir, { recursive: true, force: true });
    r.approverDir = null;
  }

  // ── Stopping ────────────────────────────────────────────────────────────

  /** Stop a run: a waiting one at once, a running one gently, then firmly. */
  cancel(id: string, reason = 'Stopped.'): RunInfo {
    const r = this.runs.get(id);
    if (!r) throw new RunError(404, 'No such run.');
    if (r.info.state === 'queued') {
      r.stopReason = reason;
      r.finished = true;
      r.info.state = 'stopped';
      r.info.reason = reason;
      r.info.endedAt = new Date().toISOString();
      r.prompt = '';
      this.forgetApprover(r);
      this.log(r, { type: 'end', run: r.info });
      appendAudit(this.o.home, { action: 'run-ended', runId: r.info.id, state: 'stopped' });
      this.changed(r);
      this.pump();
    } else if (r.info.state === 'running') {
      this.stopWith(r, reason);
    }
    return { ...r.info };
  }

  private stopWith(r: Live, reason: string): void {
    if (r.stopReason || r.finished) return;
    r.stopReason = reason;
    this.stop(r);
  }

  /** SIGINT so the agent can record the turn, SIGTERM after a while, then SIGKILL. */
  private stop(r: Live): void {
    const child = r.child;
    if (!child || r.finished) return;
    const win = this.o.platform === 'win32';
    try {
      child.kill(win ? undefined : 'SIGINT');
    } catch {
      /* already gone */
    }
    r.timers.push(
      setTimeout(() => {
        if (r.finished) return;
        if (win && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
        } else child.kill('SIGTERM');
      }, this.o.termMs),
      setTimeout(() => {
        if (!r.finished) child.kill('SIGKILL');
      }, this.o.killMs),
    );
  }

  /** Stop everything (the server is shutting down). Resolves when all have ended. */
  async stopAll(): Promise<void> {
    const live = [...this.runs.values()].filter((r) => !r.finished);
    const ended = live.filter((r) => r.child).map((r) => new Promise<void>((done) => r.child!.once('close', () => done())));
    for (const r of live) this.cancel(r.info.id, 'Stopped: ContextDeck was closed.');
    await Promise.race([Promise.all(ended), new Promise((done) => setTimeout(done, this.o.killMs + 1000))]);
  }

  // ── Reading ─────────────────────────────────────────────────────────────

  /** Active and waiting runs first, then the most recent. */
  list(): RunInfo[] {
    const rank = (s: RunState) => (s === 'running' ? 0 : s === 'queued' ? 1 : 2);
    return [...this.order]
      .reverse()
      .map((id) => this.runs.get(id)!.info)
      .sort((a, b) => rank(a.state) - rank(b.state))
      .map((i) => ({ ...i }));
  }

  get(id: string): { run: RunInfo; events: RunEvent[] } | null {
    const r = this.runs.get(id);
    return r ? { run: { ...r.info }, events: r.events.map((e) => ({ ...e })) } : null;
  }

  private changed(r: Live): void {
    this.o.onChange?.({ ...r.info });
  }

  /** Keep the last 50 runs in memory; active and waiting ones always stay. */
  private trimHistory(): void {
    while (this.order.length > KEEP_RUNS) {
      const idx = this.order.findIndex((id) => this.runs.get(id)!.finished);
      if (idx < 0) return;
      this.runs.delete(this.order[idx]!);
      this.order.splice(idx, 1);
    }
  }

  // ── Logs ────────────────────────────────────────────────────────────────

  private logDir(): string {
    return join(this.o.home, 'runs');
  }

  private log(r: Live, entry: Record<string, unknown>): void {
    try {
      const dir = this.logDir();
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, `${r.info.id}.jsonl`);
      appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
      try {
        chmodSync(path, 0o600);
      } catch {
        /* not supported everywhere (Windows) */
      }
    } catch {
      /* a log that can't be written must not stop the run */
    }
  }

  /** Keep the newest 50 run logs, and none older than 7 days. */
  private pruneLogs(): void {
    try {
      const dir = this.logDir();
      if (!existsSync(dir)) return;
      const files = readdirSync(dir)
        .filter((f) => /^run_[0-9a-f]{10}\.jsonl$/.test(f))
        .map((f) => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
      files.forEach((f, i) => {
        if (i >= KEEP_RUNS || f.mtime < cutoff) unlinkSync(f.path);
      });
    } catch {
      /* best effort */
    }
  }
}

/** Events as shown to people: secrets redacted, like everything indexed. */
function cleanEvent(e: RunEvent): RunEvent {
  switch (e.type) {
    case 'tool':
      return { type: 'tool', name: e.name, summary: redact(e.summary) };
    case 'denied':
      return { type: 'denied', tool: e.tool, reason: redact(e.reason) };
    case 'error':
      return { type: 'error', message: redact(e.message) };
    default:
      return e;
  }
}

/** Keep the computer from going to sleep while a run is going. Best effort. */
function keepAwake(pid: number | undefined, platform: NodeJS.Platform, seconds: number): ChildProcess | null {
  if (!pid) return null;
  let child: ChildProcess | null = null;
  try {
    if (platform === 'darwin') child = spawn('caffeinate', ['-i', '-w', String(pid)], { stdio: 'ignore' });
    else if (platform === 'linux') child = spawn('systemd-inhibit', ['--what=idle', '--why=ContextDeck run', 'sleep', String(seconds)], { stdio: 'ignore' });
  } catch {
    return null;
  }
  child?.on('error', () => {});
  return child;
}

/** Where a command would be found on PATH (Windows, with PATHEXT). */
export function findOnPath(command: string, env: NodeJS.ProcessEnv): string | null {
  const isFile = (p: string) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (isAbsolute(command)) return isFile(command) ? command : null;
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of ['', ...exts]) {
      const p = join(dir, command + ext);
      if (isFile(p)) return p;
    }
  }
  return null;
}
