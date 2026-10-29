import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { sanitizeBoard } from '../src/board.js';
import { loadConfig } from '../src/config.js';
import { indexSources } from '../src/indexer.js';
import { commandText } from '../src/platform.js';
import { startUiServer, type UiServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { scratch, startFakeModelServer, type FakeModelServer } from './helpers.js';

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: () => any;
}

/** Raw HTTP so tests can send any Host / Origin header (fetch won't let us set Host). */
function call(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: opts.method ?? 'GET',
        headers: {
          Host: `127.0.0.1:${port}`,
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(data)) } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) }));
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('ui server', () => {
  const s = scratch();
  const cfg = loadConfig({ home: s.home, claudeDir: s.claude, codexDir: s.codex, qwenDir: s.qwen }, {});
  let store: Store;
  let server: UiServer;
  const launched: string[] = [];

  before(async () => {
    store = new Store(cfg.dbPath);
    await indexSources(store, cfg.sources);
    server = await startUiServer(store, cfg, {
      port: 0,
      watch: false,
      platform: 'darwin',
      terminal: { name: 'Terminal' },
      launchTerminal: async (l) => {
        launched.push(commandText(l, 'darwin'));
      },
    });
  });

  after(async () => {
    await server.close();
    store.close();
    s.cleanup();
  });

  const auth = () => ({ 'X-ContextDeck-Token': server.token });

  it('binds to loopback only', () => {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  });

  it('serves the page with the token and a strict CSP', async () => {
    const r = await call(server.port, '/');
    assert.equal(r.status, 200);
    assert.ok(r.body.includes(server.token));
    assert.ok(!r.body.includes('__CONTEXTDECK_TOKEN__'));
    const csp = String(r.headers['content-security-policy']);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src 'self'/);
    assert.equal(r.headers['access-control-allow-origin'], undefined, 'never sends CORS headers');
  });

  it('serves only the known static files', async () => {
    assert.equal((await call(server.port, '/app.js')).status, 200);
    assert.equal((await call(server.port, '/fonts/geist-latin-wght-normal.woff2')).status, 200);
    assert.equal((await call(server.port, '/../package.json')).status, 404);
    assert.equal((await call(server.port, '/%2e%2e/package.json')).status, 404);
    assert.equal((await call(server.port, '/index.html')).status, 404);
  });

  it('refuses requests with a foreign Host header (DNS rebinding)', async () => {
    const r = await call(server.port, '/api/board', { headers: { Host: 'evil.example:80' } });
    assert.equal(r.status, 403);
    assert.equal((await call(server.port, '/', { headers: { Host: `localhost:${server.port}` } })).status, 200);
  });

  it('returns the board: sessions, workstreams and cross-tool links', async () => {
    const b = (await call(server.port, '/api/board')).json();
    assert.equal(b.sessions.length, 6);
    assert.deepEqual(
      b.providers.map((p: { id: string; label: string }) => [p.id, p.label]),
      [
        ['claude-code', 'Claude Code'],
        ['codex', 'Codex CLI'],
        ['qwen-code', 'Qwen Code'],
      ],
    );
    const ws = b.workstreams.find((w: { kind: string }) => w.kind === 'linked');
    assert.equal(ws.label, 'session.ts');
    assert.deepEqual(ws.providers, ['claude-code', 'codex', 'qwen-code']);
    assert.equal(b.edges.length, 3);
    assert.equal(b.subagentCounts['claude-code:7c1e2a90-4b3d-4f6a-9c21-5d8e0f3a1b11'], 1);
    assert.equal(b.subagentCounts['qwen-code:5d2c8e41-7a3b-4c6d-9e0f-1a2b3c4d5e61'], 1);
    assert.equal(b.capabilities.openTerminal, true);
    assert.equal(b.sources.length, 3);
  });

  it('returns one session with its resume command and related work', async () => {
    const r = await call(server.port, '/api/session/cc%3A0f3a1b11');
    assert.equal(r.status, 200);
    const d = r.json();
    assert.equal(d.resume.shell, 'cd /Users/alice/code/acme-shop && claude --resume 7c1e2a90-4b3d-4f6a-9c21-5d8e0f3a1b11');
    assert.deepEqual(d.related.map((r: { session: { provider: string } }) => r.session.provider), ['qwen-code', 'codex']);
    assert.equal(d.subagents.length, 1);
    assert.ok(d.messages.length > 0);
    assert.deepEqual(d.contextSeries, { points: [16_500, 19_500, 44_000], compactions: [2] });
    assert.equal((await call(server.port, '/api/session/nope')).status, 404);
  });

  it('searches', async () => {
    const d = (await call(server.port, '/api/search?q=cookie')).json();
    assert.equal(d.hits.length, 3);
    assert.deepEqual((await call(server.port, '/api/search?q=')).json().hits, []);
  });

  it('needs the token to change anything', async () => {
    const body = { positions: { workstream: { a: { x: 1, y: 2 } } } };
    assert.equal((await call(server.port, '/api/layout', { method: 'PUT', body })).status, 403);
    assert.equal((await call(server.port, '/api/layout', { method: 'PUT', body, headers: { 'X-ContextDeck-Token': 'wrong' } })).status, 403);
    assert.equal((await call(server.port, '/api/reindex', { method: 'POST' })).status, 403);
    assert.equal((await call(server.port, '/api/open-terminal', { method: 'POST', body: { id: 'cc:0f3a1b11' } })).status, 403);
  });

  it('refuses writes from another origin even with the token', async () => {
    const r = await call(server.port, '/api/layout', {
      method: 'PUT',
      body: { positions: {} },
      headers: { ...auth(), Origin: 'https://evil.example' },
    });
    assert.equal(r.status, 403);
  });

  it('saves the layout to board.json, dropping anything invalid', async () => {
    const r = await call(server.port, '/api/layout', {
      method: 'PUT',
      headers: { ...auth(), Origin: `http://127.0.0.1:${server.port}` },
      body: {
        positions: {
          workstream: { 'codex:x': { x: 10.6, y: -20 }, bad: { x: 'no', y: 1 }, huge: { x: 1e12, y: 0 } },
          project: 'nonsense',
          sneaky: { a: { x: 1, y: 1 } },
        },
      },
    });
    assert.equal(r.status, 200);
    const saved = JSON.parse(readFileSync(join(s.home, 'board.json'), 'utf8'));
    assert.deepEqual(saved.positions.workstream, { 'codex:x': { x: 11, y: -20 } });
    assert.deepEqual(saved.positions.project, {});
    assert.equal(saved.positions.sneaky, undefined);
    assert.deepEqual((await call(server.port, '/api/layout')).json().positions.workstream, { 'codex:x': { x: 11, y: -20 } });
  });

  it('rejects bodies that are not JSON or too large', async () => {
    const bad = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: server.port,
          path: '/api/layout',
          method: 'PUT',
          headers: { Host: `127.0.0.1:${server.port}`, ...auth() },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end('{not json');
    });
    assert.equal(bad, 400);
  });

  it('lists the tools a session can be handed to', async () => {
    const caps = (await call(server.port, '/api/board')).json().capabilities;
    assert.deepEqual(
      caps.handoffTargets.map((t: { id: string }) => t.id),
      ['claude-code', 'codex', 'qwen-code'],
    );
  });

  it('previews a handoff brief', async () => {
    const r = await call(server.port, '/api/handoff/preview?id=cc%3A0f3a1b11&to=codex');
    assert.equal(r.status, 200, r.body);
    const d = r.json();
    assert.match(d.handoffId, /^hf_[0-9a-f]{10}$/);
    assert.match(d.brief, /^# Continue: /);
    assert.ok(d.brief.includes(d.handoffId));
    assert.equal(d.toLabel, 'Codex CLI');
    assert.equal(d.fromLabel, 'Claude Code');
    assert.equal(d.crossProvider, true);
    assert.equal(d.targetWindow, 272_000);
    assert.equal(d.cwdExists, false, 'the fixture folder is not on this machine');
    assert.ok(d.tokens > 100);
    const off = (await call(server.port, `/api/handoff/preview?id=cc%3A0f3a1b11&to=codex&checkIn=0&handoffId=${d.handoffId}`)).json();
    assert.equal(off.handoffId, d.handoffId, 'same id when rebuilding');
    assert.match(off.brief, /carry on with the next step/);
    assert.equal((await call(server.port, '/api/handoff/preview?id=cc%3A0f3a1b11&to=gemini')).status, 400);
    assert.equal((await call(server.port, '/api/handoff/preview?id=nope&to=codex')).status, 404);
  });

  it('saves an edited brief and returns the start command', async () => {
    const body = { id: 'cc:0f3a1b11', to: 'codex', handoffId: 'hf_00000000aa', brief: '# Continue: edited by me\nDo the thing.' };
    assert.equal((await call(server.port, '/api/handoff', { method: 'POST', body })).status, 403, 'needs the token');
    const r = await call(server.port, '/api/handoff', { method: 'POST', headers: auth(), body });
    assert.equal(r.status, 200, r.body);
    const d = r.json();
    assert.equal(d.launched, false);
    assert.equal(d.path, join(s.home, 'handoffs', 'hf_00000000aa.md'));
    const saved = readFileSync(d.path, 'utf8');
    assert.match(saved, /^# Continue: edited by me\n/);
    assert.match(saved, /ContextDeck handoff hf_00000000aa from claude-code:7c1e2a90/, 'marker added back');
    // The path is quoted when it needs to be (spaces, Windows backslashes)
    assert.ok(d.command === `codex "$(cat ${d.path})"` || d.command === `codex "$(cat '${d.path}')"`, d.command);
  });

  it('opens Terminal with the handoff command on macOS', async () => {
    launched.length = 0;
    const r = await call(server.port, '/api/handoff', {
      method: 'POST',
      headers: auth(),
      body: { id: 'cc:0f3a1b11', to: 'codex', handoffId: 'hf_00000000bb', brief: 'brief', launch: true },
    });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json().launched, true);
    assert.equal(launched.length, 1);
    assert.match(launched[0]!, /^codex "\$\(cat '?.*hf_00000000bb\.md'?\)"$/);
    launched.length = 0;
  });

  it('rejects bad handoff requests', async () => {
    const post = (body: unknown) => call(server.port, '/api/handoff', { method: 'POST', headers: auth(), body });
    assert.equal((await post({ id: 'cc:0f3a1b11', to: 'codex', handoffId: '../../x', brief: 'b' })).status, 400);
    assert.equal((await post({ id: 'cc:0f3a1b11', to: 'gemini', handoffId: 'hf_00000000cc', brief: 'b' })).status, 400);
    assert.equal((await post({ id: 'cc:0f3a1b11', to: 'codex', handoffId: 'hf_00000000cc', brief: '  ' })).status, 400);
    assert.equal((await post({ id: 'nope', to: 'codex', handoffId: 'hf_00000000cc', brief: 'b' })).status, 404);
    assert.equal((await post({ to: 'codex' })).status, 400);
  });

  it('opens Terminal with the exact resume command (macOS)', async () => {
    launched.length = 0;
    const r = await call(server.port, '/api/open-terminal', { method: 'POST', headers: auth(), body: { id: 'cx:d5e6f701' } });
    assert.equal(r.status, 200);
    assert.deepEqual(launched, ['cd /Users/alice/code/acme-shop && codex resume 019a2f3c-5d6e-7f80-91a2-b3c4d5e6f701']);
  });

  it('streams index events to open pages', async () => {
    const events = await new Promise<string>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: server.port, path: '/api/events', headers: { Host: `127.0.0.1:${server.port}` } },
        (res) => {
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            buf += chunk;
            if (buf.includes('event: hello') && !buf.includes('event: index')) {
              call(server.port, '/api/reindex', { method: 'POST', headers: auth() }).catch(reject);
            }
            if (buf.includes('event: index')) {
              req.destroy();
              resolve(buf);
            }
          });
        },
      );
      req.on('error', (e) => (String(e).includes('socket hang up') ? undefined : reject(e)));
      req.end();
    });
    assert.match(events, /event: index\ndata: \{"version":1/);
  });
});

describe('ui server on other platforms', () => {
  it('says when no terminal can be opened (Linux without a terminal app or display)', async () => {
    const s = scratch();
    const cfg = loadConfig({ home: s.home, claudeDir: s.claude, codexDir: s.codex, qwenDir: s.qwen }, {});
    const store = new Store(cfg.dbPath);
    await indexSources(store, cfg.sources);
    const launches: unknown[] = [];
    const server = await startUiServer(store, cfg, {
      port: 0,
      watch: false,
      platform: 'linux',
      terminal: null,
      launchTerminal: async (l) => {
        launches.push(l);
      },
    });
    const auth = { 'X-ContextDeck-Token': server.token };
    try {
      const r = await call(server.port, '/api/open-terminal', { method: 'POST', headers: auth, body: { id: 'cc:0f3a1b11' } });
      assert.equal(r.status, 501);
      assert.match(r.json().error, /No terminal app/);
      assert.equal((await call(server.port, '/api/board')).json().capabilities.openTerminal, false);
      const h = await call(server.port, '/api/handoff', {
        method: 'POST',
        headers: auth,
        body: { id: 'cc:0f3a1b11', to: 'codex', handoffId: 'hf_00000000dd', brief: 'b', launch: true },
      });
      assert.equal(h.status, 501);
      assert.equal(launches.length, 0);
    } finally {
      await server.close();
      store.close();
      s.cleanup();
    }
  });

  it('gives PowerShell commands and a pointer prompt on Windows', async () => {
    const s = scratch();
    const cfg = loadConfig({ home: s.home, claudeDir: s.claude, codexDir: s.codex, qwenDir: s.qwen }, {});
    const store = new Store(cfg.dbPath);
    await indexSources(store, cfg.sources);
    const launches: unknown[] = [];
    const server = await startUiServer(store, cfg, {
      port: 0,
      watch: false,
      platform: 'win32',
      terminal: { name: 'Windows Terminal' },
      launchTerminal: async (l) => {
        launches.push(l);
      },
    });
    const auth = { 'X-ContextDeck-Token': server.token };
    try {
      const board = (await call(server.port, '/api/board')).json();
      assert.deepEqual([board.capabilities.openTerminal, board.capabilities.terminalName], [true, 'Windows Terminal']);
      const d = (await call(server.port, '/api/session/cx%3Ad5e6f701')).json();
      assert.equal(d.resume.shell, 'Set-Location /Users/alice/code/acme-shop; codex resume 019a2f3c-5d6e-7f80-91a2-b3c4d5e6f701');
      const h = await call(server.port, '/api/handoff', {
        method: 'POST',
        headers: auth,
        body: { id: 'cc:0f3a1b11', to: 'codex', handoffId: 'hf_00000000ee', brief: 'brief', launch: true },
      });
      assert.equal(h.status, 200, h.body);
      assert.match(
        h.json().command,
        /^codex 'Continue: .*Read the handoff brief in .*hf_00000000ee\.md and follow it\. \(ContextDeck handoff hf_00000000ee from claude-code:7c1e2a90-4b3d-4f6a-9c21-5d8e0f3a1b11\)'$/,
      );
      assert.equal(launches.length, 1);
    } finally {
      await server.close();
      store.close();
      s.cleanup();
    }
  });

  it('reports a launcher failure instead of failing silently', async () => {
    const s = scratch();
    const cfg = loadConfig({ home: s.home, claudeDir: s.claude, codexDir: s.codex, qwenDir: s.qwen }, {});
    const store = new Store(cfg.dbPath);
    await indexSources(store, cfg.sources);
    const launches: unknown[] = [];
    const server = await startUiServer(store, cfg, {
      port: 0,
      watch: false,
      platform: 'linux',
      terminal: { name: 'xterm' },
      launchTerminal: async () => {
        throw new Error('spawn xterm ENOENT');
      },
    });
    const auth = { 'X-ContextDeck-Token': server.token };
    try {
      const r = await call(server.port, '/api/open-terminal', { method: 'POST', headers: auth, body: { id: 'cc:0f3a1b11' } });
      assert.equal(r.status, 500);
      assert.match(r.json().error, /Couldn't open a terminal: spawn xterm ENOENT/);
    } finally {
      await server.close();
      store.close();
      s.cleanup();
    }
  });
});

describe('ui server: finding things and decisions', () => {
  const s = scratch();
  const cfg = loadConfig({ home: s.home, claudeDir: s.claude, codexDir: s.codex, qwenDir: s.qwen }, {});
  let store: Store;
  let server: UiServer;
  const auth = () => ({ 'X-ContextDeck-Token': server.token });

  before(async () => {
    store = new Store(cfg.dbPath);
    await indexSources(store, cfg.sources);
    server = await startUiServer(store, cfg, { port: 0, watch: false, terminal: null });
  });
  after(async () => {
    await server.close();
    store.close();
    s.cleanup();
  });

  it('says which message matched, so the panel can open there', async () => {
    const d = (await call(server.port, '/api/search?q=%22refresh%20path%22')).json();
    const cx = d.hits.find((x: { session: { provider: string } }) => x.session.provider === 'codex');
    assert.ok(Number.isInteger(cx.seq));
    const msg = store.messageAt(cx.session.id, cx.seq);
    assert.match(msg!.text, /refresh path/i);
    assert.deepEqual(d.decisions, []);
  });

  it('lists every match inside one session, in order', async () => {
    const r = await call(server.port, '/api/matches?id=cc%3A0f3a1b11&q=cookie');
    assert.equal(r.status, 200);
    const seqs = r.json().matches.map((m: { seq: number }) => m.seq);
    assert.ok(seqs.length >= 2);
    assert.deepEqual(seqs, [...seqs].sort((a: number, b: number) => a - b));
    assert.match(r.json().matches[0].snippet, /«cookie/i);
    assert.equal((await call(server.port, '/api/matches?id=nope&q=x')).status, 404);
    assert.deepEqual((await call(server.port, '/api/matches?id=cc%3A0f3a1b11&q=')).json().matches, []);
  });

  it('sends the part of a long session around a message', async () => {
    // A session longer than the panel's window (600 messages)
    const dir = join(s.claude, 'projects/-w-long');
    mkdirSync(dir, { recursive: true });
    const id = 'cccccccc-0000-4000-8000-000000000001';
    const lines = [];
    for (let i = 0; i < 400; i++) {
      lines.push(JSON.stringify({ type: 'user', sessionId: id, cwd: '/w/long', timestamp: '2026-10-29T00:00:00Z', message: { role: 'user', content: `question ${i}${i === 7 ? ' needle' : ''}` } }));
      lines.push(JSON.stringify({ type: 'assistant', sessionId: id, cwd: '/w/long', timestamp: '2026-10-29T00:00:01Z', message: { id: `m${i}`, role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] } }));
    }
    writeFileSync(join(dir, `${id}.jsonl`), lines.join('\n') + '\n');
    await indexSources(store, cfg.sources);
    const latest = (await call(server.port, `/api/session/claude-code%3A${id}`)).json();
    assert.equal(latest.messages.length, 600);
    assert.equal(latest.truncatedMessages, 200);
    assert.equal(latest.truncatedAfter, 0);
    const needle = (await call(server.port, `/api/matches?id=claude-code%3A${id}&q=needle`)).json().matches[0].seq;
    const around = (await call(server.port, `/api/session/claude-code%3A${id}?around=${needle}`)).json();
    assert.ok(around.messages.some((m: { seq: number }) => m.seq === needle), 'the match is in the window');
    assert.equal(around.truncatedMessages, 0);
    assert.equal(around.truncatedAfter, 200);
    assert.equal((await call(server.port, `/api/session/claude-code%3A${id}?around=abc`)).json().truncatedMessages, 200, 'bad values are ignored');
  });

  it('adds, edits and removes decisions, with the token only', async () => {
    const seq = store.matchesIn(store.resolve('cc:0f3a1b11').id, 'httpOnly')[0]!.seq;
    const body = { sessionId: 'cc:0f3a1b11', seq, text: 'Use httpOnly cookies' };
    assert.equal((await call(server.port, '/api/decisions', { method: 'POST', body })).status, 403, 'needs the token');
    assert.equal(
      (await call(server.port, '/api/decisions', { method: 'POST', body, headers: { ...auth(), Origin: 'https://evil.example' } })).status,
      403,
      'and the right origin',
    );
    const r = await call(server.port, '/api/decisions', { method: 'POST', body, headers: auth() });
    assert.equal(r.status, 201, r.body);
    const d = r.json();
    assert.equal(d.text, 'Use httpOnly cookies');
    assert.equal(d.anchored, true);
    assert.equal(d.session.shortId, 'cc:0f3a1b11');

    const post = (b: unknown) => call(server.port, '/api/decisions', { method: 'POST', body: b, headers: auth() });
    assert.equal((await post({ sessionId: 'cc:0f3a1b11', seq: '1', text: 'x' })).status, 400);
    assert.equal((await post({ sessionId: 'cc:0f3a1b11', seq: 99999, text: 'x' })).status, 400);
    assert.equal((await post({ sessionId: 'nope', seq: 0, text: 'x' })).status, 404);
    assert.equal((await post({ sessionId: 'cc:0f3a1b11', seq, text: '  ' })).status, 400);

    // Shown on the board, in the session, in search and in the list
    assert.equal((await call(server.port, '/api/board')).json().decisionCounts['claude-code:7c1e2a90-4b3d-4f6a-9c21-5d8e0f3a1b11'], 1);
    const detail = (await call(server.port, '/api/session/cc%3A0f3a1b11')).json();
    assert.deepEqual(detail.decisions.map((x: { text: string; seq: number }) => [x.text, x.seq]), [['Use httpOnly cookies', seq]]);
    const found = (await call(server.port, '/api/search?q=httponly%20cookies')).json();
    assert.deepEqual(found.decisions.map((x: { id: string }) => x.id), [d.id]);
    assert.deepEqual((await call(server.port, '/api/search?q=httponly&provider=codex')).json().decisions, [], 'provider filter applies');
    assert.equal((await call(server.port, '/api/decisions')).json().decisions.length, 1);

    const put = await call(server.port, `/api/decisions/${d.id}`, { method: 'PUT', body: { text: 'httpOnly cookies, SameSite=Lax' }, headers: auth() });
    assert.equal(put.status, 200);
    assert.equal(put.json().text, 'httpOnly cookies, SameSite=Lax');
    assert.equal((await call(server.port, `/api/decisions/${d.id}`, { method: 'PUT', body: {}, headers: auth() })).status, 400);
    assert.equal((await call(server.port, '/api/decisions/../../etc', { method: 'DELETE', headers: auth() })).status, 404);
    assert.equal((await call(server.port, '/api/decisions/d_ffffffffff', { method: 'DELETE', headers: auth() })).status, 404);
    assert.equal((await call(server.port, `/api/decisions/${d.id}`, { method: 'DELETE' })).status, 403);
    assert.equal((await call(server.port, `/api/decisions/${d.id}`, { method: 'DELETE', headers: auth() })).status, 200);
    assert.deepEqual((await call(server.port, '/api/decisions')).json().decisions, []);
  });

  it('puts decisions in the handoff preview', async () => {
    const seq = store.matchesIn(store.resolve('cc:0f3a1b11').id, 'httpOnly')[0]!.seq;
    await call(server.port, '/api/decisions', { method: 'POST', body: { sessionId: 'cc:0f3a1b11', seq, text: 'Keep the header path for mobile' }, headers: auth() });
    const p = (await call(server.port, '/api/handoff/preview?id=cc%3A0f3a1b11&to=codex')).json();
    assert.match(p.brief, /## Decisions already made\n\n- Keep the header path for mobile\n/);
  });
});

describe('ui server: search by meaning', () => {
  const s = scratch();
  const cfg = loadConfig({ home: s.home, claudeDir: s.claude, codexDir: s.codex, qwenDir: s.qwen }, {});
  let store: Store;
  let server: UiServer;
  let model: FakeModelServer;
  const events: string[] = [];
  const auth = () => ({ 'X-ContextDeck-Token': server.token });
  const put = (body: unknown, headers: Record<string, string> = auth()) => call(server.port, '/api/semantic', { method: 'PUT', body, headers });

  before(async () => {
    model = await startFakeModelServer();
    store = new Store(cfg.dbPath);
    await indexSources(store, cfg.sources);
    server = await startUiServer(store, cfg, { port: 0, watch: false, terminal: null });
  });
  after(async () => {
    await server.close();
    store.close();
    await model.close();
    s.cleanup();
  });

  it('starts off, and the board says so', async () => {
    const b = (await call(server.port, '/api/board')).json();
    assert.equal(b.meaning.enabled, false);
    assert.equal(b.meaning.state, 'off');
    const r = (await call(server.port, '/api/search?q=cookie')).json();
    assert.deepEqual(r.meaning, { used: false, error: null });
    assert.ok(r.hits.every((h: { via: string }) => h.via === 'words'));
  });

  it('turns on only with the token, a local address and a model that answers', async () => {
    assert.equal((await put({ enabled: true, url: model.url }, {})).status, 403);
    const remote = await put({ enabled: true, url: 'https://embed.example.com' });
    assert.equal(remote.status, 400);
    assert.match(remote.json().error, /isn’t on this computer.*--allow-remote/);
    const missing = await put({ enabled: true, url: model.url, model: 'nope:1b' });
    assert.equal(missing.status, 400);
    assert.match(missing.json().error, /ollama pull nope:1b/);
    assert.equal((await put({ enabled: true, url: model.url, model: 'a b' })).status, 400);
    assert.equal((await call(server.port, '/api/semantic')).json().enabled, false, 'nothing saved after failures');

    const ok = await put({ enabled: true, url: model.url, dims: 0 });
    assert.equal(ok.status, 200, ok.body);
    assert.equal(ok.json().enabled, true);
  });

  it('catches up in the background and then searches by meaning', async () => {
    for (let i = 0; i < 100; i++) {
      const st = (await call(server.port, '/api/semantic')).json();
      if (st.state === 'ready' && st.pieces > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const st = (await call(server.port, '/api/semantic')).json();
    assert.equal(st.state, 'ready');
    assert.ok(st.sessions >= 6);
    const r = (await call(server.port, '/api/search?q=' + encodeURIComponent('which session picked the throttle for logins'))).json();
    assert.equal(r.meaning.used, true);
    const top = r.hits[0];
    assert.equal(top.session.provider, 'qwen-code', 'the rate-limiting session');
    assert.equal(top.via, 'meaning');
    assert.ok(Number.isInteger(top.seq));
  });

  it('turns off again', async () => {
    const r = await put({ enabled: false, drop: true });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json().enabled, r.json().pieces], [false, 0]);
    assert.equal((await put({})).status, 400);
  });
});

describe('sanitizeBoard', () => {
  it('returns an empty board for garbage', () => {
    for (const junk of [null, 42, 'x', [], { positions: null }]) {
      assert.deepEqual(sanitizeBoard(junk).positions.workstream, {});
    }
  });
});
