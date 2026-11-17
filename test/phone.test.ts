import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { indexSources } from '../src/indexer.js';
import { normalizeTailnetHost, startUiServer, type UiServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { rawRequest as call, scratch } from './helpers.js';

const TAILNET = 'laptop.tail1234.ts.net';
const LOGIN = 'you@example.com';

/** Headers Tailscale Serve adds to a request from a signed-in tailnet user. */
const viaServe = (extra: Record<string, string> = {}) => ({
  Host: TAILNET,
  'Tailscale-User-Login': LOGIN,
  'Tailscale-User-Name': 'You',
  'X-Forwarded-For': '100.64.0.7',
  'X-Forwarded-Proto': 'https',
  ...extra,
});

describe('phone mode: local and remote requests', () => {
  const s = scratch();
  const cfg = loadConfig({ home: s.home, claudeDir: s.claude, codexDir: s.codex, qwenDir: s.qwen }, {});
  let store: Store;
  let plain: UiServer;
  let phone: UiServer;

  before(async () => {
    store = new Store(cfg.dbPath);
    await indexSources(store, cfg.sources);
    plain = await startUiServer(store, cfg, { port: 0, watch: false, terminal: null });
    phone = await startUiServer(store, cfg, { port: 0, watch: false, terminal: null, phone: { tailnetHost: `${TAILNET.toUpperCase()}.` } });
  });

  after(async () => {
    await plain.close();
    await phone.close();
    store.close();
    s.cleanup();
  });

  it('refuses the tailnet name when phone mode is off', async () => {
    assert.equal((await call(plain.port, '/', { headers: viaServe() })).status, 403);
    assert.equal((await call(plain.port, '/api/board', { headers: viaServe() })).status, 403);
  });

  it('keeps local requests exactly as before in phone mode', async () => {
    const page = await call(phone.port, '/');
    assert.equal(page.status, 200);
    assert.ok(page.body.includes(phone.token));
    assert.equal((await call(phone.port, '/api/board')).status, 200);
    assert.equal((await call(phone.port, '/', { headers: { Host: `localhost:${phone.port}` } })).status, 200);
    const write = await call(phone.port, '/api/layout', {
      method: 'PUT',
      headers: { 'X-ContextDeck-Token': phone.token, Origin: `http://127.0.0.1:${phone.port}` },
      body: { positions: {} },
    });
    assert.equal(write.status, 200);
  });

  it('accepts only the exact tailnet name, not other *.ts.net names', async () => {
    for (const host of ['other.tail1234.ts.net', 'laptop.tail9999.ts.net', 'ts.net', `${TAILNET}.evil.example`, `${TAILNET}:8443`]) {
      const r = await call(phone.port, '/api/board', { headers: viaServe({ Host: host }) });
      assert.equal(r.status, 403, host);
      assert.match(r.json().error, /Host/);
    }
  });

  it('refuses a remote request without a Tailscale login (tagged device)', async () => {
    const r = await call(phone.port, '/api/board', { headers: { Host: TAILNET, 'X-Forwarded-For': '100.64.0.9' } });
    assert.equal(r.status, 403);
    assert.match(r.json().error, /signed-in user/);
    assert.equal((await call(phone.port, '/api/board', { headers: viaServe({ 'Tailscale-User-Login': ' ' }) })).status, 403);
  });

  it('gives an unpaired remote device nothing: no page, no token, no data', async () => {
    const page = await call(phone.port, '/', { headers: viaServe() });
    assert.equal(page.status, 401);
    assert.ok(!page.body.includes(phone.token));
    assert.ok(!page.body.includes('__CONTEXTDECK_TOKEN__'));
    for (const path of ['/api/board', '/api/decisions', '/api/events', '/app.js']) {
      assert.equal((await call(phone.port, path, { headers: viaServe() })).status, 401, path);
    }
    const write = await call(phone.port, '/api/reindex', {
      method: 'POST',
      headers: viaServe({ 'X-ContextDeck-Token': phone.token, Origin: `https://${TAILNET}` }),
    });
    assert.equal(write.status, 401, 'even a leaked token does not let a remote request through');
  });

  it('treats a proxied request as remote even if its Host looks local', async () => {
    for (const header of ['Tailscale-User-Login', 'X-Forwarded-For', 'X-Forwarded-Host', 'Forwarded']) {
      const headers = { [header]: header === 'Tailscale-User-Login' ? LOGIN : 'x' };
      if (header !== 'Tailscale-User-Login') headers['Tailscale-User-Login'] = LOGIN;
      const r = await call(phone.port, '/', { headers });
      assert.equal(r.status, 401, header);
      assert.ok(!r.body.includes(phone.token), header);
    }
    // Without a login it is refused outright
    assert.equal((await call(phone.port, '/', { headers: { 'X-Forwarded-For': '100.64.0.7' } })).status, 403);
  });

  it('does not accept the tailnet origin for local writes', async () => {
    const r = await call(phone.port, '/api/layout', {
      method: 'PUT',
      headers: { 'X-ContextDeck-Token': phone.token, Origin: `https://${TAILNET}` },
      body: { positions: {} },
    });
    assert.equal(r.status, 403);
  });
});

describe('normalizeTailnetHost', () => {
  it('lowercases and drops the trailing dot from tailscale status output', () => {
    assert.equal(normalizeTailnetHost('Laptop.Tail1234.ts.net.'), TAILNET);
    assert.equal(normalizeTailnetHost(` ${TAILNET} `), TAILNET);
  });

  it('refuses anything that is not a plain multi-label name', () => {
    for (const bad of ['', 'laptop', '*.ts.net', `${TAILNET}:443`, 'https://laptop.ts.net', 'a..ts.net', '-x.ts.net', 'lap top.ts.net']) {
      assert.throws(() => normalizeTailnetHost(bad), /tailnet name/, bad);
    }
  });

  it('refuses to start with a bad tailnet name', async () => {
    const s = scratch();
    const cfg = loadConfig({ home: s.home, claudeDir: s.claude, codexDir: s.codex, qwenDir: s.qwen }, {});
    const store = new Store(cfg.dbPath);
    try {
      await assert.rejects(startUiServer(store, cfg, { port: 0, watch: false, terminal: null, phone: { tailnetHost: '*.ts.net' } }), /tailnet name/);
    } finally {
      store.close();
      s.cleanup();
    }
  });
});
