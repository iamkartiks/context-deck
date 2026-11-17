import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { HeadlessCommand, RunEvent } from '../src/adapters/types.js';
import { auditPath } from '../src/audit.js';
import { loadConfig } from '../src/config.js';
import { indexSources } from '../src/indexer.js';
import { findOnPath, RunManager, type RunInfo, type RunManagerOptions } from '../src/runs.js';
import { startUiServer, type UiServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { FIXTURES, rawRequest as call, scratch, writeFakeAgent, type FakeAgent } from './helpers.js';

const isWindows = process.platform === 'win32';
const CC = 'claude-code:7c1e2a90-4b3d-4f6a-9c21-5d8e0f3a1b11';
const CC_SUB = 'claude-code:agent-4e5f6a7b';
const stream = (name: string) => join(FIXTURES, 'streams', `${name}.jsonl`);

/**
 * Scratch copies of the sample sessions, moved so their project folders exist
 * on this computer (runs only happen in real folders).
 */
function setup() {
  const s = scratch();
  const acme = join(s.dir, 'code', 'acme-shop');
  const blog = join(s.dir, 'code', 'blog');
  const empty = join(s.dir, 'code', 'empty');
  for (const d of [acme, blog, empty]) mkdirSync(d, { recursive: true });
  const swap = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const p = join(entry.parentPath, entry.name);
      const text = readFileSync(p, 'utf8')
        .split('/Users/alice/code/acme-shop')
        .join(JSON.stringify(acme).slice(1, -1))
        .split('/Users/alice/code/blog')
        .join(JSON.stringify(blog).slice(1, -1));
      writeFileSync(p, text);
    }
  };
  for (const d of [s.claude, s.codex, s.qwen]) swap(d);
  const cfg = loadConfig({ home: s.home, claudeDir: s.claude, codexDir: s.codex, qwenDir: s.qwen }, {});
  return { s, cfg, acme, blog, empty };
}

/** Run fake agents through node, so it works the same on every platform. */
const viaNode = (fake: FakeAgent) => (cmd: HeadlessCommand): HeadlessCommand => ({ command: process.execPath, args: [fake.script, ...cmd.args], cwd: cmd.cwd });

function manager(env: ReturnType<typeof setup>, store: Store, fake: FakeAgent, over: Partial<RunManagerOptions> = {}) {
  const changes: RunInfo[] = [];
  const events: RunEvent[] = [];
  let indexed = 0;
  const m = new RunManager({
    store,
    sources: env.cfg.sources,
    home: env.s.home,
    keepAwake: false,
    textBatchMs: 5,
    termMs: 150,
    killMs: 400,
    wrapCommand: viaNode(fake),
    onChange: (r) => changes.push(r),
    onEvents: (_id, e) => events.push(...e),
    onIndexed: () => indexed++,
    ...over,
  });
  const waitFor = async (id: string, states = ['done', 'failed', 'stopped'], ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const r = m.get(id)?.run;
      if (r && states.includes(r.state)) return r;
      await new Promise((res) => setTimeout(res, 20));
    }
    assert.fail(`run ${id} is still ${m.get(id)?.run.state}`);
  };
  return { m, changes, events, waitFor, indexed: () => indexed };
}

const me = { deviceId: null, name: 'This computer' };

describe('runs: one turn, start to finish', () => {
  const env = setup();
  let store: Store;
  before(async () => {
    store = new Store(env.cfg.dbPath);
    await indexSources(store, env.cfg.sources);
  });
  after(() => {
    store.close();
    env.s.cleanup();
  });

  it('resumes a session: prompt on stdin, the right command, live events, done, reindexed', async () => {
    const fake = writeFakeAgent(env.s.dir, { stream: stream('claude-code'), name: 'cc1' });
    const t = manager(env, store, fake);
    const run = t.m.start({ kind: 'resume', sessionId: CC, mode: 'plan', prompt: 'Check the limiter.\nSECRET-PROMPT-MARKER' }, me);
    assert.equal(run.state, 'running', 'starts straight away when there’s room');
    assert.equal(run.sessionId, CC);
    const done = await t.waitFor(run.id);
    assert.equal(done.state, 'done', done.reason ?? '');
    assert.equal(done.costUsd, 0.0123);
    assert.match(done.summary!, /resets every minute/);

    const [callArgs] = fake.calls();
    assert.equal(callArgs!.stdin, 'Check the limiter.\nSECRET-PROMPT-MARKER');
    assert.equal(callArgs!.cwd.replace(/^\/private/, ''), env.acme.replace(/^\/private/, ''));
    assert.deepEqual(callArgs!.args.slice(0, 3), ['-p', '--resume', '7c1e2a90-4b3d-4f6a-9c21-5d8e0f3a1b11']);
    assert.ok(callArgs!.args.includes('plan'));

    const kinds = t.events.map((e) => e.type);
    assert.deepEqual([...new Set(kinds)], ['text', 'tool', 'denied']);
    const text = t.events.filter((e) => e.type === 'text').map((e) => (e.type === 'text' ? e.delta : '')).join('');
    assert.equal(text, 'Let me look at the rate limiter.The limiter resets every minute. Running the tests needs edit mode.');
    assert.deepEqual(
      t.changes.map((c) => c.state),
      ['queued', 'running', 'done'],
    );
    for (let i = 0; i < 50 && !t.indexed(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(t.indexed(), 1, 'reindexed the session when the run ended');

    // The log: events only, never the prompt, owner-only
    const log = readFileSync(join(env.s.home, 'runs', `${run.id}.jsonl`), 'utf8');
    assert.ok(!log.includes('SECRET-PROMPT-MARKER'));
    assert.match(log, /"type":"end"/);
    if (!isWindows) assert.equal(statSync(join(env.s.home, 'runs', `${run.id}.jsonl`)).mode & 0o777, 0o600);
    const audit = readFileSync(auditPath(env.s.home), 'utf8');
    assert.match(audit, new RegExp(`"action":"run-started","runId":"${run.id}"`));
    assert.match(audit, /"action":"run-ended".*"state":"done"/);
  });

  it('starts a new session and learns its id', async () => {
    const fake = writeFakeAgent(env.s.dir, { stream: stream('codex'), name: 'cx1' });
    const t = manager(env, store, fake);
    const run = t.m.start({ kind: 'new', to: 'codex', cwd: env.acme, mode: 'edit', prompt: 'Add a test.' }, me);
    const done = await t.waitFor(run.id);
    assert.equal(done.state, 'done', done.reason ?? '');
    assert.equal(done.sessionId, 'codex:019a2f3c-5d6e-7f80-91a2-b3c4d5e6f701');
    const args = fake.calls()[0]!.args;
    assert.deepEqual(args.slice(0, 4), ['exec', '--json', '--sandbox', 'workspace-write']);
    assert.ok(args.includes('sandbox_mode="workspace-write"'));
  });

  it('hands a session off: the brief is saved and goes in on stdin, with its marker', async () => {
    const fake = writeFakeAgent(env.s.dir, { stream: stream('codex'), name: 'cx2' });
    const t = manager(env, store, fake);
    const run = t.m.start({ kind: 'handoff', sessionId: CC, to: 'codex', handoffId: 'hf_0123456789', brief: 'Carry on with the limiter.', mode: 'plan' }, me);
    assert.equal(run.fromSessionId, CC);
    assert.equal(run.handoffId, 'hf_0123456789');
    await t.waitFor(run.id);
    const stdin = fake.calls()[0]!.stdin;
    assert.match(stdin, /^Carry on with the limiter\./);
    assert.match(stdin, /\(ContextDeck handoff hf_0123456789 from claude-code:7c1e2a90/);
    assert.equal(readFileSync(join(env.s.home, 'handoffs', 'hf_0123456789.md'), 'utf8'), stdin);
  });

  it('refuses bad requests with a reason', () => {
    const fake = writeFakeAgent(env.s.dir, { stream: stream('codex'), name: 'bad' });
    const t = manager(env, store, fake);
    const cases: [Record<string, unknown>, number, RegExp][] = [
      [{ kind: 'shell', mode: 'plan' }, 400, /kind/],
      [{ kind: 'resume', mode: 'yolo', sessionId: CC, prompt: 'x' }, 400, /mode/],
      [{ kind: 'resume', mode: 'plan', sessionId: CC, prompt: '   ' }, 400, /Write a message/],
      [{ kind: 'resume', mode: 'plan', sessionId: CC, prompt: 'x'.repeat(200_001) }, 400, /too long/],
      [{ kind: 'resume', mode: 'plan', sessionId: 'cc:nope', prompt: 'x' }, 404, /./],
      [{ kind: 'resume', mode: 'plan', sessionId: CC_SUB, prompt: 'x' }, 400, /subagent/],
      [{ kind: 'new', mode: 'plan', to: 'codex', cwd: 'relative/dir', prompt: 'x' }, 400, /full folder path/],
      [{ kind: 'new', mode: 'plan', to: 'codex', cwd: join(env.s.dir, 'gone'), prompt: 'x' }, 400, /isn’t on this computer/],
      [{ kind: 'new', mode: 'plan', to: 'notepad', cwd: env.acme, prompt: 'x' }, 400, /can’t run "notepad"/],
      [{ kind: 'handoff', mode: 'plan', to: 'codex', sessionId: CC, handoffId: '../x', brief: 'x' }, 400, /handoffId/],
    ];
    for (const [req, status, msg] of cases) {
      assert.throws(
        () => t.m.start(req as never, me),
        (err: { status: number; message: string }) => err.status === status && msg.test(err.message),
        JSON.stringify(req).slice(0, 80),
      );
    }
    assert.equal(fake.calls().length, 0, 'nothing ran');
  });

  it('runs only in folders where that tool was used (Codex checks folder trust itself)', () => {
    const fake = writeFakeAgent(env.s.dir, { stream: stream('codex'), name: 'trust' });
    const t = manager(env, store, fake);
    // Nobody has worked in the empty folder
    for (const to of ['claude-code', 'codex', 'qwen-code']) {
      assert.throws(() => t.m.start({ kind: 'new', to, cwd: env.empty, mode: 'plan', prompt: 'x' }, me), /No agent has been used/, to);
    }
    // blog has Claude Code and Qwen Code sessions, but not Codex: Codex may run (it checks trust), Claude Code may too
    assert.ok(store.providersInFolder(env.blog).includes('claude-code'));
    assert.ok(!store.providersInFolder(env.blog).includes('codex'));
    t.m.cancel(t.m.start({ kind: 'new', to: 'codex', cwd: env.blog, mode: 'plan', prompt: 'x' }, me).id);
    t.m.cancel(t.m.start({ kind: 'new', to: 'claude-code', cwd: env.blog, mode: 'plan', prompt: 'x' }, me).id);
    // A stub index where only Codex has been used in a folder: Claude Code is refused there
    const stub = Object.create(store) as Store;
    stub.providersInFolder = () => ['codex'];
    const t2 = manager(env, stub, fake);
    assert.throws(() => t2.m.start({ kind: 'new', to: 'claude-code', cwd: env.blog, mode: 'plan', prompt: 'x' }, me), /Claude Code hasn’t been used in/);
    assert.throws(() => t2.m.start({ kind: 'new', to: 'qwen-code', cwd: env.blog, mode: 'plan', prompt: 'x' }, me), /Qwen Code hasn’t been used in/);
  });
});

describe('runs: limits, stopping and failures', () => {
  const env = setup();
  let store: Store;
  before(async () => {
    store = new Store(env.cfg.dbPath);
    await indexSources(store, env.cfg.sources);
  });
  after(() => {
    store.close();
    env.s.cleanup();
  });

  it('runs one turn per session at a time, with at most 3 waiting behind it', async () => {
    const fake = writeFakeAgent(env.s.dir, { stream: stream('claude-code'), name: 'q', holdMs: 300 });
    const t = manager(env, store, fake);
    const req = { kind: 'resume', sessionId: CC, mode: 'plan', prompt: 'next' };
    const ids = [0, 1, 2, 3].map(() => t.m.start(req, me).id);
    assert.equal(t.m.get(ids[0]!)!.run.state, 'running');
    assert.deepEqual(ids.slice(1).map((id) => t.m.get(id)!.run.state), ['queued', 'queued', 'queued']);
    assert.throws(() => t.m.start(req, me), (e: { status: number }) => e.status === 429);
    await t.waitFor(ids[0]!);
    assert.equal(t.m.get(ids[1]!)!.run.state, 'running', 'the next one starts when the first ends');
    for (const id of ids.slice(1)) t.m.cancel(id);
    for (const id of ids.slice(1)) await t.waitFor(id);
    const listed = t.m.list();
    assert.equal(listed.length, 4);
  });

  it('runs at most N at once overall', async () => {
    const fake = writeFakeAgent(env.s.dir, { stream: stream('codex'), name: 'n', holdMs: 300 });
    const t = manager(env, store, fake, { maxConcurrent: 1 });
    const a = t.m.start({ kind: 'new', to: 'codex', cwd: env.acme, mode: 'plan', prompt: 'a' }, me);
    const b = t.m.start({ kind: 'new', to: 'codex', cwd: env.acme, mode: 'plan', prompt: 'b' }, me);
    assert.deepEqual([t.m.get(a.id)!.run.state, t.m.get(b.id)!.run.state], ['running', 'queued']);
    assert.equal(t.m.list()[0]!.state, 'running', 'active runs are listed first');
    await t.waitFor(b.id);
  });

  it('stops a run: SIGINT first, then SIGTERM if it doesn’t listen', { skip: isWindows }, async () => {
    const fake = writeFakeAgent(env.s.dir, { stream: stream('claude-code'), name: 'stubborn', delayMs: 5000, ignoreSigint: true });
    const t = manager(env, store, fake);
    const run = t.m.start({ kind: 'resume', sessionId: CC, mode: 'plan', prompt: 'x' }, me);
    await new Promise((r) => setTimeout(r, 300));
    t.m.cancel(run.id, 'Stopped from Pixel 9.');
    const done = await t.waitFor(run.id);
    assert.equal(done.state, 'stopped');
    assert.equal(done.reason, 'Stopped from Pixel 9.');
    assert.deepEqual(fake.signals(), ['SIGINT', 'SIGTERM']);
  });

  it('stops a waiting run without starting it', () => {
    const fake = writeFakeAgent(env.s.dir, { stream: stream('codex'), name: 'w', holdMs: 300 });
    const t = manager(env, store, fake, { maxConcurrent: 1 });
    t.m.start({ kind: 'new', to: 'codex', cwd: env.acme, mode: 'plan', prompt: 'a' }, me);
    const b = t.m.start({ kind: 'new', to: 'codex', cwd: env.acme, mode: 'plan', prompt: 'b' }, me);
    assert.equal(t.m.cancel(b.id).state, 'stopped');
    assert.throws(() => t.m.cancel('run_0000000000'), /No such run/);
  });

  it('stops a run that takes too long', async () => {
    const fake = writeFakeAgent(env.s.dir, { stream: stream('codex'), name: 'slow', delayMs: 5000 });
    const t = manager(env, store, fake, { timeoutMs: 300 });
    const run = t.m.start({ kind: 'new', to: 'codex', cwd: env.acme, mode: 'plan', prompt: 'x' }, me);
    const done = await t.waitFor(run.id);
    assert.equal(done.state, 'stopped');
    assert.match(done.reason!, /ran longer than/);
  });

  it('reports a crash, a failed turn, a missing tool and a huge line as failed runs', async () => {
    const crashStream = join(env.s.dir, 'crash.jsonl');
    writeFileSync(crashStream, '{"type":"thread.started","thread_id":"019a2f3c-5d6e-7f80-91a2-b3c4d5e6f701"}\nnot json\n{"broken\n');
    const crash = manager(env, store, writeFakeAgent(env.s.dir, { stream: crashStream, name: 'crash', exitCode: 3 }));
    const r1 = await crash.waitFor(crash.m.start({ kind: 'new', to: 'codex', cwd: env.acme, mode: 'plan', prompt: 'x' }, me).id);
    assert.equal(r1.state, 'failed');
    assert.match(r1.reason!, /exit code 3/);

    const failed = manager(env, store, writeFakeAgent(env.s.dir, { stream: stream('qwen-code'), name: 'qfail' }));
    const r2 = await failed.waitFor(failed.m.start({ kind: 'new', to: 'qwen-code', cwd: env.acme, mode: 'plan', prompt: 'x' }, me).id);
    assert.equal(r2.state, 'failed');
    assert.match(r2.reason!, /reported a problem/);
    assert.equal(r2.summary, 'error during execution');

    const missing = manager(env, store, writeFakeAgent(env.s.dir, { stream: crashStream, name: 'missing' }), {
      wrapCommand: (cmd) => ({ ...cmd, command: join(env.s.dir, 'no-such-agent') }),
    });
    const r3 = await missing.waitFor(missing.m.start({ kind: 'new', to: 'codex', cwd: env.acme, mode: 'plan', prompt: 'x' }, me).id);
    assert.equal(r3.state, 'failed');
    assert.match(r3.reason!, /isn’t installed/);

    const hugeStream = join(env.s.dir, 'huge.jsonl');
    writeFileSync(hugeStream, `{"type":"thread.started","thread_id":"x"}\n${'x'.repeat(1_200_000)}`);
    const huge = manager(env, store, writeFakeAgent(env.s.dir, { stream: hugeStream, name: 'huge', holdMs: 2000 }));
    const r4 = await huge.waitFor(huge.m.start({ kind: 'new', to: 'codex', cwd: env.acme, mode: 'plan', prompt: 'x' }, me).id);
    assert.equal(r4.state, 'failed');
    assert.match(r4.reason!, /longer than 1 MB/);
  });

  it('redacts secrets in what it shows and logs', async () => {
    const secret = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
    const leaky = join(env.s.dir, 'leaky.jsonl');
    writeFileSync(
      leaky,
      [
        '{"type":"thread.started","thread_id":"019a2f3c-5d6e-7f80-91a2-b3c4d5e6f701"}',
        JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: `export KEY=${secret}` } }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `Your key is ${secret}.` } }),
        '{"type":"turn.completed"}',
      ].join('\n'),
    );
    const t = manager(env, store, writeFakeAgent(env.s.dir, { stream: leaky, name: 'leaky' }));
    const run = t.m.start({ kind: 'new', to: 'codex', cwd: env.acme, mode: 'plan', prompt: 'x' }, me);
    await t.waitFor(run.id);
    assert.ok(!JSON.stringify(t.events).includes(secret));
    assert.ok(!JSON.stringify(t.m.get(run.id)).includes(secret));
    assert.ok(!readFileSync(join(env.s.home, 'runs', `${run.id}.jsonl`), 'utf8').includes(secret));
    assert.match(JSON.stringify(t.events), /\[REDACTED\]/);
  });

  it('keeps the newest 50 run logs, none older than 7 days', () => {
    const dir = join(env.s.home, 'runs');
    mkdirSync(dir, { recursive: true });
    const old = Date.now() / 1000 - 8 * 86_400;
    for (let i = 0; i < 60; i++) {
      const p = join(dir, `run_${i.toString(16).padStart(10, '0')}.jsonl`);
      writeFileSync(p, '{}\n');
      if (i < 5) utimesSync(p, old, old);
    }
    writeFileSync(join(dir, 'notes.txt'), 'not a run log');
    manager(env, store, writeFakeAgent(env.s.dir, { stream: stream('codex'), name: 'prune' }));
    const left = readdirSync(dir).filter((f) => f.startsWith('run_'));
    assert.ok(left.length <= 50);
    assert.ok(!left.includes('run_0000000000.jsonl'), 'old logs go');
    assert.ok(existsSync(join(dir, 'notes.txt')), 'other files stay');
  });

  it('on Windows, refuses tools installed as .cmd scripts instead of going through cmd.exe', () => {
    const cmd = join(env.s.dir, 'codex.cmd');
    writeFileSync(cmd, '@echo off');
    process.env.CONTEXTDECK_CODEX_BIN = cmd;
    try {
      const m = new RunManager({ store, sources: env.cfg.sources, home: env.s.home, keepAwake: false, platform: 'win32' });
      assert.throws(() => m.start({ kind: 'new', to: 'codex', cwd: env.acme, mode: 'plan', prompt: 'x' }, me), /can’t be started safely without a shell/);
    } finally {
      delete process.env.CONTEXTDECK_CODEX_BIN;
    }
    assert.equal(findOnPath(cmd, {}), cmd);
    // The fixtures' codex folder sits next to it: folders don't count
    assert.match(findOnPath('codex', { PATH: env.s.dir, PATHEXT: '.EXE;.CMD' }) ?? '', /codex\.cmd$/i);
    assert.equal(findOnPath('nothing-here', { PATH: env.s.dir }), null);
  });
});

describe('runs over HTTP, with phone scopes', () => {
  const env = setup();
  let store: Store;
  let server: UiServer;
  let fake: FakeAgent;
  const TAILNET = 'laptop.tail1234.ts.net';

  before(async () => {
    store = new Store(env.cfg.dbPath);
    await indexSources(store, env.cfg.sources);
    fake = writeFakeAgent(env.s.dir, { stream: stream('claude-code'), name: 'http', holdMs: 200 });
    server = await startUiServer(store, env.cfg, {
      port: 0,
      watch: false,
      terminal: null,
      phone: { tailnetHost: TAILNET },
      runs: { keepAwake: false, textBatchMs: 5, termMs: 100, killMs: 300, wrapCommand: viaNode(fake) },
    });
  });
  after(async () => {
    await server.close();
    store.close();
    env.s.cleanup();
  });

  const local = () => ({ 'X-ContextDeck-Token': server.token, Origin: `http://127.0.0.1:${server.port}` });

  /** Pair a phone with these scopes; returns headers for it. */
  async function phone(scopes: string[]) {
    const remote = (extra: Record<string, string> = {}) => ({ Host: TAILNET, 'Tailscale-User-Login': 'you@example.com', 'X-Forwarded-For': '100.64.0.7', ...extra });
    const { code } = (await call(server.port, '/api/pair/code', { method: 'POST', headers: local() })).json();
    const asked = await call(server.port, '/api/pair', { method: 'POST', headers: remote({ Origin: `https://${TAILNET}` }), body: { code, name: 'Pixel 9' } });
    const claim = /cd_pending=([^;]+)/.exec(String(asked.headers['set-cookie']))![1];
    await call(server.port, `/api/devices/pending/${asked.json().id}`, { method: 'POST', headers: local(), body: { allow: true } });
    const done = await call(server.port, '/api/pair/status', { headers: remote({ Cookie: `cd_pending=${claim}` }) });
    const secret = /cd_device=([^;]+)/.exec(([] as string[]).concat(done.headers['set-cookie'] ?? []).join(';'))![1];
    const id = done.json().device.id;
    await call(server.port, `/api/devices/${id}`, { method: 'PUT', headers: local(), body: { scopes } });
    return remote({ Cookie: `cd_device=${secret}`, Origin: `https://${TAILNET}`, 'X-ContextDeck-Token': server.token });
  }

  const start = (headers: Record<string, string>, body: Record<string, unknown>) => call(server.port, '/api/runs', { method: 'POST', headers, body });
  const resume = (mode: string) => ({ kind: 'resume', sessionId: CC, mode, prompt: 'Next step.' });

  it('starts, lists, shows and stops runs from this computer', async () => {
    const r = await start(local(), resume('plan'));
    assert.equal(r.status, 202, r.body);
    const id = r.json().id;
    assert.equal(r.json().startedBy.name, 'This computer');
    assert.ok((await call(server.port, '/api/runs')).json().runs.some((x: RunInfo) => x.id === id));
    for (let i = 0; i < 100; i++) {
      const got = (await call(server.port, `/api/runs/${id}`)).json();
      if (got.run.state === 'done') {
        assert.ok(got.events.some((e: RunEvent) => e.type === 'tool'));
        break;
      }
      await new Promise((res) => setTimeout(res, 30));
    }
    assert.equal((await call(server.port, `/api/runs/${id}`)).json().run.state, 'done');
    assert.equal((await call(server.port, '/api/runs/run_0000000000')).status, 404);
    assert.equal((await call(server.port, '/api/runs/nope')).status, 404);
    const bad = await start(local(), { kind: 'resume', sessionId: CC, mode: 'plan', prompt: '' });
    assert.equal(bad.status, 400);
  });

  it('needs the token and a matching origin, like every write', async () => {
    assert.equal((await start({}, resume('plan'))).status, 403);
    assert.equal((await start({ ...local(), Origin: 'https://evil.example' }, resume('plan'))).status, 403);
  });

  it('lets a phone start only what its scopes allow', async () => {
    const viewOnly = await phone(['view', 'decide']);
    assert.equal((await start(viewOnly, resume('plan'))).status, 403);
    assert.equal((await call(server.port, '/api/runs', { headers: viewOnly })).status, 200, 'but it can watch runs');

    const runner = await phone(['view', 'run']);
    const ok = await start(runner, resume('plan'));
    assert.equal(ok.status, 202, ok.body);
    assert.equal(ok.json().startedBy.name, 'Pixel 9');
    const edit = await start(runner, resume('edit'));
    assert.equal(edit.status, 403);
    assert.match(edit.json().error, /Plan only/);
    const handoff = await start(runner, { kind: 'handoff', sessionId: CC, to: 'codex', handoffId: 'hf_0123456789', brief: 'x', mode: 'plan' });
    assert.equal(handoff.status, 403);
    const stop = await call(server.port, `/api/runs/${ok.json().id}`, { method: 'DELETE', headers: runner });
    assert.equal(stop.status, 200);
    assert.match(stop.json().state === 'stopped' ? stop.json().reason : 'Stopped from Pixel 9.', /Stopped from Pixel 9/);

    const handoffOnly = await phone(['view', 'handoff']);
    assert.equal((await start(handoffOnly, resume('plan'))).status, 403);
    assert.equal((await call(server.port, `/api/runs/${ok.json().id}`, { method: 'DELETE', headers: handoffOnly })).status, 403, 'stopping needs "run"');
    const h = await start(handoffOnly, { kind: 'handoff', sessionId: CC, to: 'codex', handoffId: 'hf_0123456780', brief: 'Carry on.', mode: 'plan' });
    assert.equal(h.status, 202, h.body);

    const all = await phone(['view', 'run', 'edit']);
    assert.equal((await start(all, resume('edit'))).status, 202);
  });

  it('starts nothing in plain `contextdeck ui` (phone mode off)', async () => {
    const plain = await startUiServer(store, env.cfg, { port: 0, watch: false, terminal: null, runs: { keepAwake: false, wrapCommand: viaNode(fake) } });
    try {
      const r = await call(plain.port, '/api/runs', { method: 'POST', headers: { 'X-ContextDeck-Token': plain.token }, body: resume('plan') });
      assert.equal(r.status, 409);
      assert.match(r.json().error, /phone mode/);
      const caps = (await call(plain.port, '/api/board')).json().capabilities.runs;
      assert.deepEqual(caps, { handoff: false, run: false, edit: false, tools: [] });
    } finally {
      await plain.close();
    }
  });

  it('tells the page what it may start', async () => {
    const caps = (await call(server.port, '/api/board')).json().capabilities.runs;
    assert.deepEqual([caps.handoff, caps.run, caps.edit], [true, true, true]);
    assert.deepEqual(caps.tools.map((t: { id: string }) => t.id), ['claude-code', 'codex', 'qwen-code']);
    const p = (await call(server.port, '/api/board', { headers: await phone(['view', 'run']) })).json().capabilities.runs;
    assert.deepEqual([p.handoff, p.run, p.edit], [false, true, false]);
  });
});
