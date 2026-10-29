import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { sanitizeBoard } from '../src/board.js';
import { loadConfig } from '../src/config.js';
import { indexSources } from '../src/indexer.js';
import { shellLine, startUiServer, type UiServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { scratch } from './helpers.js';

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
  const cfg = loadConfig({ home: s.home, claudeDir: s.claude, codexDir: s.codex }, {});
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
      launchTerminal: async (line) => {
        launched.push(line);
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
    assert.equal(b.sessions.length, 4);
    assert.deepEqual(
      b.providers.map((p: { id: string }) => p.id),
      ['claude-code', 'codex'],
    );
    const ws = b.workstreams.find((w: { kind: string }) => w.kind === 'linked');
    assert.equal(ws.label, 'session cookies');
    assert.deepEqual(ws.providers, ['claude-code', 'codex']);
    assert.equal(b.edges.length, 1);
    assert.equal(b.subagentCounts['claude-code:7c1e2a90-4b3d-4f6a-9c21-5d8e0f3a1b11'], 1);
    assert.equal(b.capabilities.openTerminal, true);
    assert.equal(b.sources.length, 2);
  });

  it('returns one session with its resume command and related work', async () => {
    const r = await call(server.port, '/api/session/cc%3A0f3a1b11');
    assert.equal(r.status, 200);
    const d = r.json();
    assert.equal(d.resume.shell, 'cd /Users/alice/code/acme-shop && claude --resume 7c1e2a90-4b3d-4f6a-9c21-5d8e0f3a1b11');
    assert.equal(d.related[0].session.provider, 'codex');
    assert.equal(d.subagents.length, 1);
    assert.ok(d.messages.length > 0);
    assert.deepEqual(d.contextSeries, { points: [16_500, 19_500, 44_000], compactions: [2] });
    assert.equal((await call(server.port, '/api/session/nope')).status, 404);
  });

  it('searches', async () => {
    const d = (await call(server.port, '/api/search?q=cookie')).json();
    assert.equal(d.hits.length, 2);
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
      ['claude-code', 'codex'],
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
    assert.equal(d.command, `codex "$(cat ${d.path})"`);
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
    assert.match(launched[0]!, /^codex "\$\(cat .*hf_00000000bb\.md\)"$/);
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
  it('says opening a terminal is macOS-only instead of failing silently', async () => {
    const s = scratch();
    const cfg = loadConfig({ home: s.home, claudeDir: s.claude, codexDir: s.codex }, {});
    const store = new Store(cfg.dbPath);
    await indexSources(store, cfg.sources);
    const server = await startUiServer(store, cfg, { port: 0, watch: false, platform: 'linux' });
    try {
      const r = await call(server.port, '/api/open-terminal', {
        method: 'POST',
        headers: { 'X-ContextDeck-Token': server.token },
        body: { id: 'cc:0f3a1b11' },
      });
      assert.equal(r.status, 501);
      assert.equal((await call(server.port, '/api/board')).json().capabilities.openTerminal, false);
      const h = await call(server.port, '/api/handoff', {
        method: 'POST',
        headers: { 'X-ContextDeck-Token': server.token },
        body: { id: 'cc:0f3a1b11', to: 'codex', handoffId: 'hf_00000000dd', brief: 'b', launch: true },
      });
      assert.equal(h.status, 501);
    } finally {
      await server.close();
      store.close();
      s.cleanup();
    }
  });
});

describe('shellLine', () => {
  it('quotes anything that could be interpreted by the shell', () => {
    assert.equal(
      shellLine({ command: 'codex', args: ['resume', 'abc-123'], cwd: "/Users/a/it's here", display: '' }),
      `cd '/Users/a/it'\\''s here' && codex resume abc-123`,
    );
    assert.equal(
      shellLine({ command: 'claude', args: ['--resume', '$(rm -rf ~)'], cwd: null, display: '' }),
      `claude --resume '$(rm -rf ~)'`,
    );
  });
});

describe('sanitizeBoard', () => {
  it('returns an empty board for garbage', () => {
    for (const junk of [null, 42, 'x', [], { positions: null }]) {
      assert.deepEqual(sanitizeBoard(junk).positions.workstream, {});
    }
  });
});
