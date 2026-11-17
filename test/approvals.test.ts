import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ApprovalHub, describeRequest, type Approval } from '../src/approvals.js';
import { auditPath } from '../src/audit.js';
import { loadConfig } from '../src/config.js';
import { indexSources } from '../src/indexer.js';
import { RunManager, type RunInfo } from '../src/runs.js';
import { startUiServer, type UiServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { rawRequest as call, REPO, scratch } from './helpers.js';

const BIN = join(REPO, 'bin/contextdeck.js');
const RUN = 'run_0123456789';

/** `contextdeck approver`, spoken to over stdio like Claude Code does. */
function approver(env: Record<string, string>) {
  const child = spawn(process.execPath, [BIN, 'approver'], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
  let out = '';
  const waiting = new Map<number, (msg: any) => void>();
  child.stdout.setEncoding('utf8').on('data', (c: string) => {
    out += c;
    let nl: number;
    while ((nl = out.indexOf('\n')) >= 0) {
      const msg = JSON.parse(out.slice(0, nl));
      out = out.slice(nl + 1);
      waiting.get(msg.id)?.(msg);
    }
  });
  let next = 1;
  return {
    child,
    request(method: string, params: unknown = {}): Promise<any> {
      const id = next++;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    notify(method: string) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
    },
    end: () => new Promise<void>((done) => {
      child.on('close', () => done());
      child.stdin.end();
    }),
  };
}

const until = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail('timed out waiting');
    await new Promise((r) => setTimeout(r, 15));
  }
};

describe('the approver (MCP server) and the approval hub', () => {
  const s = scratch();
  const asked: Approval[] = [];
  let hub: ApprovalHub;

  before(async () => {
    hub = new ApprovalHub({ home: s.home, timeoutMs: 60_000, onChange: (a, change) => change === 'asked' && asked.push(a) });
    await hub.start();
  });
  after(async () => {
    await hub.close();
    s.cleanup();
  });

  it('speaks MCP: initialize, tools/list, notifications, unknown methods', async () => {
    const a = approver(hub.register(RUN, s.dir));
    const init = await a.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.326' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.deepEqual(init.result.serverInfo.name, 'contextdeck');
    assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
    a.notify('notifications/initialized');
    const list = await a.request('tools/list');
    assert.equal(list.result.tools.length, 1);
    assert.equal(list.result.tools[0].name, 'approve');
    assert.deepEqual(list.result.tools[0].inputSchema.required, ['tool_name', 'input']);
    assert.equal((await a.request('resources/list')).error.code, -32601);
    assert.equal((await a.request('tools/call', { name: 'other', arguments: {} })).error.code, -32602);
    assert.deepEqual((await a.request('ping')).result, {});
    await a.end();
  });

  it('allows once: the answer is one text block holding {"behavior":"allow"} with the input unchanged', async () => {
    const a = approver(hub.register(RUN, s.dir));
    const pending = a.request('tools/call', { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'npm test', description: 'Run tests' }, tool_use_id: 'toolu_01' } });
    await until(() => hub.list().length === 1);
    const card = hub.list()[0]!;
    assert.equal(card.tool, 'Bash');
    assert.deepEqual(card.detail, { kind: 'command', command: 'npm test', description: 'Run tests' });
    assert.equal(card.cwd, s.dir);
    hub.answer(card.id, true, { deviceId: 'dv_0123456789', name: 'Pixel 9' });
    const res = await pending;
    assert.deepEqual(res.result.content, [{ type: 'text', text: JSON.stringify({ behavior: 'allow', updatedInput: { command: 'npm test', description: 'Run tests' } }) }]);
    assert.equal(res.result.structuredContent, undefined);
    assert.equal(hub.list().length, 0);
    await a.end();
  });

  it('denies with a message, and accepts camelCase field names too', async () => {
    const a = approver(hub.register(RUN, s.dir));
    const pending = a.request('tools/call', { name: 'approve', arguments: { toolName: 'Write', input: { file_path: '/x/a.txt', content: 'hi' } } });
    await until(() => hub.list().length === 1);
    assert.equal(hub.list()[0]!.tool, 'Write');
    hub.answer(hub.list()[0]!.id, false, { deviceId: null, name: 'This computer' });
    const decision = JSON.parse((await pending).result.content[0].text);
    assert.equal(decision.behavior, 'deny');
    assert.match(decision.message, /said no/);
    assert.throws(() => hub.answer('ap_0000000000', true, { deviceId: null, name: 'x' }), /already answered/);
    await a.end();
  });

  it('refuses requests without the run’s secret', async () => {
    hub.register(RUN, s.dir);
    const env = hub.register('run_aaaaaaaaaa', s.dir);
    const a = approver({ ...env, CONTEXTDECK_APPROVER_SECRET: 'x'.repeat(43) });
    const res = await a.request('tools/call', { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'rm -rf /' } } });
    const decision = JSON.parse(res.result.content[0].text);
    assert.deepEqual(decision.behavior, 'deny');
    assert.match(decision.message, /isn’t from a run ContextDeck started/);
    assert.equal(hub.list().length, 0);
    await a.end();
  });

  it('denies when the hub can’t be reached or isn’t set up', async () => {
    for (const env of [{ CONTEXTDECK_APPROVER_SOCKET: join(s.dir, 'nothing.sock'), CONTEXTDECK_APPROVER_SECRET: 'x', CONTEXTDECK_RUN_ID: RUN }, {}]) {
      const a = approver(env as Record<string, string>);
      const res = await a.request('tools/call', { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'ls' } } });
      assert.equal(JSON.parse(res.result.content[0].text).behavior, 'deny');
      await a.end();
    }
  });

  it('denies when the run ends, and forgets a request whose approver went away', async () => {
    const a = approver(hub.register(RUN, s.dir));
    const pending = a.request('tools/call', { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'ls' } } });
    await until(() => hub.list().length === 1);
    hub.unregister(RUN);
    assert.match(JSON.parse((await pending).result.content[0].text).message, /run ended/);
    await a.end();

    const b = approver(hub.register(RUN, s.dir));
    void b.request('tools/call', { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'ls' } } });
    await until(() => hub.list().length === 1);
    b.child.kill();
    await until(() => hub.list().length === 0);
  });

  it('denies after the time limit', async () => {
    const quick = new ApprovalHub({ home: s.home, timeoutMs: 200 });
    await quick.start();
    try {
      const a = approver(quick.register(RUN, s.dir));
      const res = await a.request('tools/call', { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'ls' } } });
      assert.match(JSON.parse(res.result.content[0].text).message, /Nobody answered within 0 minutes|Nobody answered/);
      await a.end();
    } finally {
      await quick.close();
    }
    const log = readFileSync(auditPath(s.home), 'utf8');
    for (const outcome of ['allowed', 'denied', 'run-ended', 'timed-out', 'cancelled']) assert.match(log, new RegExp(`"reason":"${outcome}"`), outcome);
    assert.doesNotMatch(log, /npm test/, 'no commands in the audit log');
  });

  it('shows commands, edits and new files on the card, redacted', () => {
    const key = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    assert.deepEqual(describeRequest('Bash', { command: `curl -H "Authorization: token ${key}" x` }), {
      kind: 'command',
      command: 'curl -H "Authorization: token [REDACTED]" x',
      description: null,
    });
    assert.deepEqual(describeRequest('Edit', { file_path: '/p/a.ts', old_string: 'a', new_string: 'b' }), { kind: 'edit', path: '/p/a.ts', changes: [{ before: 'a', after: 'b' }] });
    assert.equal((describeRequest('MultiEdit', { file_path: '/p/a.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] }) as { changes: unknown[] }).changes.length, 2);
    assert.deepEqual(describeRequest('Write', { file_path: '/p/new.ts', content: 'x' }), { kind: 'write', path: '/p/new.ts', text: 'x' });
    assert.equal(describeRequest('WebFetch', { url: 'https://example.com' }).kind, 'other');
    assert.ok((describeRequest('Write', { file_path: '/p/big', content: 'x'.repeat(10_000) }) as { text: string }).text.length < 4100);
  });
});

/**
 * A fake Claude Code for "ask me first" runs: like the real one, it reads the
 * MCP config it was given, starts the approver from it, asks about one tool
 * call, and then streams a result that depends on the answer.
 */
function writeFakeAskingClaude(dir: string): string {
  const script = join(dir, 'fake-asking-claude.mjs');
  writeFileSync(
    script,
    `import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
for await (const _ of process.stdin) {}
const cfgPath = args[args.indexOf('--mcp-config') + 1];
writeFileSync('config-path.txt', cfgPath);
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const tool = args[args.indexOf('--permission-prompt-tool') + 1];
const server = cfg.mcpServers.contextdeck;
const mcp = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const answers = new Map();
mcp.stdout.setEncoding('utf8').on('data', (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1); answers.get(m.id)?.(m); }
});
const ask = (id, method, params) => new Promise((r) => { answers.set(id, r); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n'); });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
await ask(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude' } });
out({ type: 'system', subtype: 'init', session_id: '7c1e2a90-4b3d-4f6a-9c21-5d8e0f3a1b11', permissionMode: args[args.indexOf('--permission-mode') + 1] });
out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Write', input: { file_path: 'made.txt', content: 'hi' } }] } });
const res = await ask(2, 'tools/call', { name: tool.split('__')[2], arguments: { tool_name: 'Write', input: { file_path: 'made.txt', content: 'hi' }, tool_use_id: 'toolu_1' } });
const decision = JSON.parse(res.result.content[0].text);
if (decision.behavior === 'allow') writeFileSync('made.txt', decision.updatedInput.content);
mcp.stdin.end();
out({ type: 'result', subtype: 'success', is_error: false, result: decision.behavior === 'allow' ? 'Wrote made.txt.' : 'You said no, so I left it.', permission_denials: decision.behavior === 'allow' ? [] : [{ tool_name: 'Write', tool_input: { file_path: 'made.txt' } }] });
`,
  );
  return script;
}

describe('“ask me first” runs', () => {
  const s = scratch();
  const cfg = loadConfig({ home: s.home, claudeDir: s.claude, codexDir: s.codex, qwenDir: s.qwen }, {});
  const folder = join(s.dir, 'project');
  let store: Store;
  let hub: ApprovalHub;
  let m: RunManager;
  const runs: RunInfo[] = [];

  before(async () => {
    mkdirSync(folder);
    store = new Store(cfg.dbPath);
    await indexSources(store, cfg.sources);
    // A Claude Code session that worked in this folder
    const stub = Object.create(store) as Store;
    stub.providersInFolder = () => ['claude-code'];
    hub = new ApprovalHub({ home: s.home, timeoutMs: 60_000 });
    await hub.start();
    const fake = writeFakeAskingClaude(s.dir);
    m = new RunManager({
      store: stub,
      sources: cfg.sources,
      home: s.home,
      keepAwake: false,
      approvals: hub,
      textBatchMs: 5,
      wrapCommand: (cmd) => ({ command: process.execPath, args: [fake, ...cmd.args], cwd: cmd.cwd }),
      onChange: (r) => runs.push(r),
    });
  });
  after(async () => {
    await hub.close();
    store.close();
    s.cleanup();
  });

  const finished = (id: string) => until(() => ['done', 'failed', 'stopped'].includes(m.get(id)!.run.state), 10_000);

  for (const allow of [true, false]) {
    it(`${allow ? 'allows' : 'denies'} a request from the agent, and the agent acts on it`, async () => {
      const run = m.start({ kind: 'new', to: 'claude-code', cwd: folder, mode: 'ask', prompt: 'Write made.txt.' }, { deviceId: null, name: 'This computer' });
      await until(() => hub.list().length === 1, 10_000);
      const card = hub.list()[0]!;
      assert.equal(card.runId, run.id);
      assert.deepEqual(card.detail, { kind: 'write', path: 'made.txt', text: 'hi' });
      hub.answer(card.id, allow, { deviceId: null, name: 'This computer' });
      await finished(run.id);
      const done = m.get(run.id)!;
      assert.equal(done.run.state, 'done', done.run.reason ?? '');
      assert.equal(existsSync(join(folder, 'made.txt')), allow);
      assert.equal(done.events.some((e) => e.type === 'denied'), !allow);
      if (allow) rmSync(join(folder, 'made.txt'));
    });
  }

  it('starts Claude Code in manual mode with a private approver config, and deletes it afterwards', async () => {
    const run = m.start({ kind: 'new', to: 'claude-code', cwd: folder, mode: 'ask', prompt: 'x' }, { deviceId: null, name: 'This computer' });
    await until(() => hub.list().length === 1, 10_000);
    hub.answer(hub.list()[0]!.id, false, { deviceId: null, name: 'This computer' });
    await finished(run.id);
    const log = readFileSync(join(s.home, 'runs', `${run.id}.jsonl`), 'utf8');
    assert.doesNotMatch(log, /CONTEXTDECK_APPROVER_SECRET/, 'the secret is never logged');
    const cfgPath = readFileSync(join(folder, 'config-path.txt'), 'utf8');
    assert.match(cfgPath, /cd-run-[^/\\]+[/\\]mcp\.json$/);
    assert.equal(existsSync(cfgPath), false, 'the approver config is deleted when the run ends');
    assert.deepEqual(
      m.get(run.id)!.events.filter((e) => e.type === 'denied').length,
      1,
    );
  });

  it('refuses “ask me first” for tools that can’t ask', () => {
    for (const to of ['codex', 'qwen-code']) {
      const stub = Object.create(store) as Store;
      stub.providersInFolder = () => [to];
      const mm = new RunManager({ store: stub, sources: cfg.sources, home: s.home, keepAwake: false, approvals: hub });
      assert.throws(() => mm.start({ kind: 'new', to, cwd: folder, mode: 'ask', prompt: 'x' }, { deviceId: null, name: 'x' }), /can’t ask for approval here\. Choose Plan only or Edit this folder\./, to);
    }
    const stub = Object.create(store) as Store;
    stub.providersInFolder = () => ['claude-code'];
    const noHub = new RunManager({ store: stub, sources: cfg.sources, home: s.home, keepAwake: false });
    assert.throws(() => noHub.start({ kind: 'new', to: 'claude-code', cwd: folder, mode: 'ask', prompt: 'x' }, { deviceId: null, name: 'x' }), /aren’t available/);
  });
});

describe('approvals over HTTP, with phone scopes', () => {
  const s = scratch();
  const cfg = loadConfig({ home: s.home, claudeDir: s.claude, codexDir: s.codex, qwenDir: s.qwen }, {});
  const TAILNET = 'laptop.tail1234.ts.net';
  let store: Store;
  let server: UiServer;
  const hub = new ApprovalHub({ home: s.home, timeoutMs: 60_000 });

  before(async () => {
    store = new Store(cfg.dbPath);
    await indexSources(store, cfg.sources);
    server = await startUiServer(store, cfg, { port: 0, watch: false, terminal: null, phone: { tailnetHost: TAILNET }, approvals: hub, runs: { keepAwake: false } });
  });
  after(async () => {
    await server.close();
    store.close();
    s.cleanup();
  });

  const local = () => ({ 'X-ContextDeck-Token': server.token, Origin: `http://127.0.0.1:${server.port}` });
  async function phone(scopes: string[]) {
    const remote = (extra: Record<string, string> = {}) => ({ Host: TAILNET, 'Tailscale-User-Login': 'you@example.com', 'X-Forwarded-For': '100.64.0.7', ...extra });
    const { code } = (await call(server.port, '/api/pair/code', { method: 'POST', headers: local() })).json();
    const asked = await call(server.port, '/api/pair', { method: 'POST', headers: remote({ Origin: `https://${TAILNET}` }), body: { code, name: 'Pixel 9' } });
    const claim = /cd_pending=([^;]+)/.exec(String(asked.headers['set-cookie']))![1];
    await call(server.port, `/api/devices/pending/${asked.json().id}`, { method: 'POST', headers: local(), body: { allow: true } });
    const done = await call(server.port, '/api/pair/status', { headers: remote({ Cookie: `cd_pending=${claim}` }) });
    const secret = /cd_device=([^;]+)/.exec(([] as string[]).concat(done.headers['set-cookie'] ?? []).join(';'))![1];
    await call(server.port, `/api/devices/${done.json().device.id}`, { method: 'PUT', headers: local(), body: { scopes } });
    return remote({ Cookie: `cd_device=${secret}`, Origin: `https://${TAILNET}`, 'X-ContextDeck-Token': server.token });
  }
  function events(headers: Record<string, string>) {
    let text = '';
    const req = request({ host: '127.0.0.1', port: server.port, path: '/api/events', headers: { Host: `127.0.0.1:${server.port}`, ...headers } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
    });
    req.end();
    return { text: () => text, close: () => req.destroy() };
  }

  it('lists and answers requests only on the computer or with the approve scope', async () => {
    assert.deepEqual((await call(server.port, '/api/approvals')).json(), { approvals: [] });
    const viewer = await phone(['view', 'run']);
    assert.equal((await call(server.port, '/api/approvals', { headers: viewer })).status, 403);
    assert.equal((await call(server.port, '/api/approvals/ap_0123456789', { method: 'POST', headers: viewer, body: { allow: true } })).status, 403);
    const approverPhone = await phone(['view', 'approve']);
    assert.equal((await call(server.port, '/api/approvals', { headers: approverPhone })).status, 200);
    assert.equal((await call(server.port, '/api/approvals/ap_0123456789', { method: 'POST', headers: approverPhone, body: { allow: true } })).status, 404);
    assert.equal((await call(server.port, '/api/approvals/ap_0123456789', { method: 'POST', headers: local(), body: { allow: 'yes' } })).status, 400);
  });

  it('needs approve to start an “ask me first” run from a phone', async () => {
    const runner = await phone(['view', 'run', 'edit']);
    const r = await call(server.port, '/api/runs', {
      method: 'POST',
      headers: runner,
      body: { kind: 'resume', sessionId: 'claude-code:7c1e2a90-4b3d-4f6a-9c21-5d8e0f3a1b11', mode: 'ask', prompt: 'x' },
    });
    assert.equal(r.status, 403);
    assert.match(r.json().error, /Ask me first/);
    const caps = (await call(server.port, '/api/board', { headers: runner })).json().capabilities;
    assert.equal(caps.approve, false);
    assert.equal(caps.runs.ask, false);
    assert.deepEqual(
      caps.runs.tools.map((t: { id: string; ask: boolean }) => [t.id, t.ask]),
      [
        ['claude-code', true],
        ['codex', false],
        ['qwen-code', false],
      ],
    );
  });

  it('sends requests to the computer and approve-scoped phones only, and takes answers from them', async () => {
    const approverHeaders = await phone(['view', 'approve']);
    const withApprove = events(approverHeaders);
    const without = events(await phone(['view', 'run']));
    const here = events({});
    await new Promise((r) => setTimeout(r, 150));
    const a = approver(hub.register(RUN, s.dir));
    try {
      const pending = a.request('tools/call', { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'npm test' } } });
      await until(() => /event: approval/.test(here.text()));
      await until(() => /event: approval/.test(withApprove.text()));
      const listed = (await call(server.port, '/api/approvals', { headers: approverHeaders })).json().approvals;
      assert.equal(listed.length, 1);
      assert.deepEqual(listed[0].detail, { kind: 'command', command: 'npm test', description: null });
      const answered = await call(server.port, `/api/approvals/${listed[0].id}`, { method: 'POST', headers: approverHeaders, body: { allow: true } });
      assert.equal(answered.status, 200, answered.body);
      assert.equal(JSON.parse((await pending).result.content[0].text).behavior, 'allow');
      assert.equal((await call(server.port, `/api/approvals/${listed[0].id}`, { method: 'POST', headers: approverHeaders, body: { allow: true } })).status, 404);
      assert.doesNotMatch(without.text(), /event: approval/, 'a phone without approve never sees requests');
    } finally {
      a.child.kill();
      withApprove.close();
      without.close();
      here.close();
    }
  });
});
