import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { appendAudit, auditPath } from '../src/audit.js';
import { loadConfig } from '../src/config.js';
import { cleanDeviceName, devicesPath, loadDevices, revokeDevices, sanitizeDevices, saveDevices } from '../src/devices.js';
import { indexSources } from '../src/indexer.js';
import { PairingCodes } from '../src/pairing.js';
import { ROUTES, routeAccess } from '../src/scopes.js';
import { startUiServer, type UiServer } from '../src/server.js';
import { saveSettings, defaultSettings } from '../src/settings.js';
import { Store } from '../src/store.js';
import { rawRequest as call, REPO, scratch, type RawResponse } from './helpers.js';

const TAILNET = 'laptop.tail1234.ts.net';
const ORIGIN = `https://${TAILNET}`;
const ME = 'you@example.com';
const isWindows = process.platform === 'win32';

/** What Tailscale Serve sends for a signed-in tailnet user. */
const remote = (login = ME, extra: Record<string, string> = {}) => ({
  Host: TAILNET,
  'Tailscale-User-Login': login,
  'X-Forwarded-For': '100.64.0.7',
  ...extra,
});

function setCookies(r: RawResponse): string[] {
  const h = r.headers['set-cookie'];
  return Array.isArray(h) ? h : h ? [h] : [];
}

function cookieValue(r: RawResponse, name: string): string | null {
  for (const c of setCookies(r)) {
    const m = new RegExp(`^${name}=([^;]*)`).exec(c);
    if (m) return m[1]!;
  }
  return null;
}

/** An open event stream, so tests can see when the server ends it. */
function openEvents(port: number, headers: Record<string, string>): Promise<{ status: number; ended: Promise<void>; text: () => string; close: () => void }> {
  return new Promise((resolve, reject) => {
    let text = '';
    const req = request({ host: '127.0.0.1', port, path: '/api/events', headers }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      const ended = new Promise<void>((done) => res.on('end', () => done()));
      resolve({ status: res.statusCode ?? 0, ended, text: () => text, close: () => req.destroy() });
    });
    req.on('error', reject);
    req.end();
  });
}

const within = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms))]);

function setup(opts: { perMinute?: number; maxDevices?: number } = {}) {
  const s = scratch();
  const cfg = loadConfig({ home: s.home, claudeDir: s.claude, codexDir: s.codex, qwenDir: s.qwen }, {});
  const ctx = {
    s,
    cfg,
    store: null as unknown as Store,
    server: null as unknown as UiServer,
    local: () => ({ 'X-ContextDeck-Token': ctx.server.token, Origin: `http://127.0.0.1:${ctx.server.port}` }),
    async start() {
      if (opts.maxDevices) saveSettings(s.home, { ...defaultSettings(), phone: { ...defaultSettings().phone, maxDevices: opts.maxDevices } });
      ctx.store = new Store(cfg.dbPath);
      await indexSources(ctx.store, cfg.sources);
      ctx.server = await startUiServer(ctx.store, cfg, {
        port: 0,
        watch: false,
        terminal: { name: 'Terminal' },
        launchTerminal: async () => {},
        phone: { tailnetHost: TAILNET },
        pairing: new PairingCodes(Date.now, opts.perMinute ?? 1000),
      });
    },
    async stop() {
      await ctx.server.close();
      ctx.store.close();
      s.cleanup();
    },
    /** Make a code on this computer, as "Pair a phone" does. */
    async code(): Promise<string> {
      const r = await call(ctx.server.port, '/api/pair/code', { method: 'POST', headers: ctx.local() });
      assert.equal(r.status, 200, r.body);
      return r.json().code;
    },
    /** The phone's side of asking to pair. Returns the pending id and the claim cookie. */
    async ask(code: string, name = 'Pixel 9', login = ME) {
      const r = await call(ctx.server.port, '/api/pair', { method: 'POST', headers: remote(login, { Origin: ORIGIN }), body: { code, name } });
      return { r, id: r.status === 202 ? (r.json().id as string) : '', claim: cookieValue(r, 'cd_pending') };
    },
    async answer(id: string, allow: boolean) {
      return call(ctx.server.port, `/api/devices/pending/${id}`, { method: 'POST', headers: ctx.local(), body: { allow } });
    },
    async status(claim: string | null, login = ME) {
      return call(ctx.server.port, '/api/pair/status', { headers: remote(login, claim ? { Cookie: `cd_pending=${claim}` } : {}) });
    },
    /** Pair a device end to end and return its cookie secret and id. */
    async pair(name = 'Pixel 9', login = ME) {
      const { id, claim } = await ctx.ask(await ctx.code(), name, login);
      assert.equal((await ctx.answer(id, true)).status, 200);
      const r = await ctx.status(claim, login);
      assert.equal(r.json().state, 'approved');
      return { secret: cookieValue(r, 'cd_device')!, deviceId: r.json().device.id as string, res: r };
    },
    /** Headers for a paired device. */
    as(secret: string, login = ME, extra: Record<string, string> = {}) {
      return remote(login, { Cookie: `cd_device=${secret}`, ...extra });
    },
  };
  return ctx;
}

describe('phone pairing', () => {
  const t = setup();
  before(() => t.start());
  after(() => t.stop());

  it('pairs a phone: code, request, approval on the computer, then a cookie', async () => {
    const { id, claim, r } = await t.ask(await t.code());
    assert.equal(r.status, 202);
    assert.equal(r.json().state, 'waiting');
    assert.ok(claim);

    // Waiting: no device yet, nothing readable
    const waiting = await t.status(claim);
    assert.equal(waiting.json().state, 'waiting');
    assert.equal(cookieValue(waiting, 'cd_device'), null);

    // The computer sees the request
    const list = (await call(t.server.port, '/api/devices', { headers: t.local() })).json();
    assert.deepEqual(list.pending.map((p: { id: string; name: string; tailscaleLogin: string }) => [p.id, p.name, p.tailscaleLogin]), [[id, 'Pixel 9', ME]]);

    assert.equal((await t.answer(id, true)).status, 200);
    const done = await t.status(claim);
    assert.equal(done.json().state, 'approved');
    const device = setCookies(done).find((c) => c.startsWith('cd_device='))!;
    assert.match(device, /; HttpOnly/);
    assert.match(device, /; Secure/);
    assert.match(device, /; SameSite=Strict/);
    assert.match(device, /; Path=\/;/);
    assert.match(device, /; Max-Age=2592000/);
    assert.ok(setCookies(done).some((c) => /^cd_pending=;.*Max-Age=0/.test(c)), 'clears the claim cookie');

    const secret = cookieValue(done, 'cd_device')!;
    const page = await call(t.server.port, '/', { headers: t.as(secret) });
    assert.equal(page.status, 200);
    assert.ok(page.body.includes(t.server.token), 'a paired device gets the canvas');
    assert.equal((await call(t.server.port, '/api/board', { headers: t.as(secret) })).status, 200);

    // Only the hash is stored, owner-only
    const raw = readFileSync(devicesPath(t.s.home), 'utf8');
    assert.ok(!raw.includes(secret));
    assert.ok(!raw.includes(claim!));
    assert.equal(loadDevices(t.s.home).devices.length, 1);
    if (!isWindows) assert.equal(statSync(devicesPath(t.s.home)).mode & 0o777, 0o600);

    // A claim works once
    assert.equal((await t.status(claim)).json().state, 'expired');
  });

  it('uses a code once, and only the newest code', async () => {
    const first = await t.code();
    const second = await t.code();
    assert.equal((await t.ask(first)).r.status, 403, 'an older code stops working');
    assert.equal((await t.ask(second)).r.status, 202);
    const again = await t.ask(second);
    assert.equal(again.r.status, 403);
    assert.match(again.r.json().error, /expired or was already used/);
    assert.equal((await t.ask('A'.repeat(22))).r.status, 403);
    assert.equal((await t.ask(undefined as unknown as string)).r.status, 403);
  });

  it('lets the computer deny a request', async () => {
    const { id, claim } = await t.ask(await t.code(), 'Not mine');
    assert.equal((await t.answer(id, false)).status, 200);
    const r = await t.status(claim);
    assert.equal(r.json().state, 'denied');
    assert.equal(cookieValue(r, 'cd_device'), null);
    assert.equal((await t.answer(id, true)).status, 404, 'an answered request can’t be answered again');
  });

  it('ties a claim to the Tailscale login that asked', async () => {
    const { id, claim } = await t.ask(await t.code());
    await t.answer(id, true);
    const r = await t.status(claim, 'someone-else@example.com');
    assert.equal(r.json().state, 'expired');
    assert.equal(cookieValue(r, 'cd_device'), null);
    assert.equal((await t.status(claim)).json().state, 'approved');
  });

  it('pairs only from a phone, and makes codes and approves only on the computer', async () => {
    const local = await call(t.server.port, '/api/pair', { method: 'POST', headers: t.local(), body: { code: 'x', name: 'x' } });
    assert.equal(local.status, 400);
    const { secret } = await t.pair('Has every scope');
    const all = ['view', 'decide', 'handoff', 'run', 'edit', 'approve'];
    const id = loadDevices(t.s.home).devices.at(-1)!.id;
    assert.equal((await call(t.server.port, `/api/devices/${id}`, { method: 'PUT', headers: t.local(), body: { scopes: all } })).status, 200);
    const h = t.as(secret, ME, { Origin: ORIGIN, 'X-ContextDeck-Token': t.server.token });
    assert.equal((await call(t.server.port, '/api/pair/code', { method: 'POST', headers: h })).status, 403);
    assert.equal((await call(t.server.port, '/api/devices', { headers: h })).status, 403);
    assert.equal((await call(t.server.port, `/api/devices/${id}`, { method: 'DELETE', headers: h })).status, 403);
    const { id: pid } = await t.ask(await t.code(), 'Waiting');
    assert.equal((await call(t.server.port, `/api/devices/pending/${pid}`, { method: 'POST', headers: h, body: { allow: true } })).status, 403);
  });

  it('refuses a device cookie from a different Tailscale login', async () => {
    const { secret } = await t.pair();
    assert.equal((await call(t.server.port, '/api/board', { headers: t.as(secret, 'thief@example.com') })).status, 401);
    const page = await call(t.server.port, '/', { headers: t.as(secret, 'thief@example.com') });
    assert.ok(!page.body.includes(t.server.token));
  });

  it('refuses an expired device, and drops it from the file', async () => {
    const { secret, deviceId } = await t.pair('Old phone');
    const file = loadDevices(t.s.home);
    file.devices.find((d) => d.id === deviceId)!.expiresAt = new Date(Date.now() - 1000).toISOString();
    saveDevices(t.s.home, file);
    assert.equal((await call(t.server.port, '/api/board', { headers: t.as(secret) })).status, 401);
    assert.ok(!loadDevices(t.s.home).devices.some((d) => d.id === deviceId));
  });

  it('keeps a seen device alive: last seen and expiry move forward', async () => {
    const { secret, deviceId } = await t.pair('Seen');
    const file = loadDevices(t.s.home);
    const d = file.devices.find((x) => x.id === deviceId)!;
    d.lastSeenAt = new Date(Date.now() - 5 * 86_400_000).toISOString();
    d.expiresAt = new Date(Date.now() + 25 * 86_400_000).toISOString();
    saveDevices(t.s.home, file);
    await call(t.server.port, '/api/board', { headers: t.as(secret) });
    const after = loadDevices(t.s.home).devices.find((x) => x.id === deviceId)!;
    assert.ok(Date.now() - Date.parse(after.lastSeenAt) < 5000);
    assert.ok(Date.parse(after.expiresAt) > Date.now() + 29 * 86_400_000);
  });
});

describe('phone scopes', () => {
  const t = setup();
  let secret = '';
  let deviceId = '';
  let sessionId = '';
  let seq = 0;

  before(async () => {
    await t.start();
    ({ secret, deviceId } = await t.pair());
    sessionId = (await call(t.server.port, '/api/board')).json().sessions[0].id;
    seq = (await call(t.server.port, `/api/session/${encodeURIComponent(sessionId)}`)).json().messages[0].seq;
  });
  after(() => t.stop());

  const write = (path: string, method: string, body?: unknown, extra: Record<string, string> = {}) =>
    call(t.server.port, path, { method, headers: t.as(secret, ME, { Origin: ORIGIN, 'X-ContextDeck-Token': t.server.token, ...extra }), body });

  it('gives new phones view and decide', () => {
    assert.deepEqual(loadDevices(t.s.home).devices[0]!.scopes, ['view', 'decide']);
  });

  it('lets a phone read and mark decisions, with the token and the tailnet origin', async () => {
    for (const path of ['/api/board', '/api/decisions', `/api/session/${encodeURIComponent(sessionId)}`, '/api/search?q=cookie', '/api/layout', '/api/semantic']) {
      assert.equal((await call(t.server.port, path, { headers: t.as(secret) })).status, 200, path);
    }
    const made = await write('/api/decisions', 'POST', { sessionId, seq, text: 'Use secret-phrase-123 here' });
    assert.equal(made.status, 201, made.body);
    assert.equal((await write(`/api/decisions/${made.json().id}`, 'PUT', { stillTrue: true })).status, 200);
    assert.equal((await write(`/api/decisions/${made.json().id}`, 'DELETE')).status, 200);
  });

  it('needs the tailnet origin and the token for a phone’s writes', async () => {
    const body = { sessionId, seq, text: 'x' };
    assert.equal((await write('/api/decisions', 'POST', body, { Origin: `http://127.0.0.1:${t.server.port}` })).status, 403);
    const noOrigin = await call(t.server.port, '/api/decisions', { method: 'POST', headers: t.as(secret, ME, { 'X-ContextDeck-Token': t.server.token }), body });
    assert.equal(noOrigin.status, 403);
    const noToken = await call(t.server.port, '/api/decisions', { method: 'POST', headers: t.as(secret, ME, { Origin: ORIGIN }), body });
    assert.equal(noToken.status, 403);
  });

  it('refuses what a view-only phone may not do', async () => {
    assert.equal((await call(t.server.port, `/api/devices/${deviceId}`, { method: 'PUT', headers: t.local(), body: { scopes: ['view'] } })).status, 200);
    const r = await write('/api/decisions', 'POST', { sessionId, seq, text: 'nope' });
    assert.equal(r.status, 403);
    assert.match(r.json().error, /isn’t allowed/);
    assert.equal((await call(t.server.port, '/api/board', { headers: t.as(secret) })).status, 200);
    assert.equal((await call(t.server.port, `/api/handoff/preview?id=${encodeURIComponent(sessionId)}&to=codex`, { headers: t.as(secret) })).status, 403);
  });

  it('refuses computer-only routes even to a phone holding every scope', async () => {
    const all = ['view', 'decide', 'handoff', 'run', 'edit', 'approve'];
    assert.equal((await call(t.server.port, `/api/devices/${deviceId}`, { method: 'PUT', headers: t.local(), body: { scopes: all } })).status, 200);
    assert.equal((await call(t.server.port, `/api/handoff/preview?id=${encodeURIComponent(sessionId)}&to=codex`, { headers: t.as(secret) })).status, 200);
    for (const [method, path, body] of [
      ['POST', '/api/open-terminal', { id: sessionId }],
      ['PUT', '/api/layout', { positions: {} }],
      ['POST', '/api/reindex', undefined],
      ['PUT', '/api/semantic', { enabled: false }],
      ['POST', '/api/handoff', { id: sessionId, to: 'codex', brief: 'x', handoffId: 'hf_0123456789' }],
    ] as const) {
      assert.equal((await write(path, method, body)).status, 403, `${method} ${path}`);
    }
    assert.equal((await call(t.server.port, '/api/not-a-route', { headers: t.as(secret) })).status, 404);
  });

  it('tells each page what it may do, so phones only see controls that work', async () => {
    const local = (await call(t.server.port, '/api/board')).json().capabilities;
    assert.equal(local.device, null);
    assert.equal(local.pairPhones, true);
    assert.equal(local.decide, true);
    assert.equal(local.openTerminal, true);
    assert.ok(local.handoffTargets.length > 0);

    assert.equal((await call(t.server.port, `/api/devices/${deviceId}`, { method: 'PUT', headers: t.local(), body: { scopes: ['view'] } })).status, 200);
    const phone = (await call(t.server.port, '/api/board', { headers: t.as(secret) })).json().capabilities;
    assert.deepEqual(phone.device, { id: deviceId, name: 'Pixel 9', scopes: ['view'] });
    assert.deepEqual(
      [phone.pairPhones, phone.decide, phone.openTerminal, phone.arrange, phone.rescan, phone.meaningSettings, phone.handoffTargets.length, phone.terminalName],
      [false, false, false, false, false, false, 0, null],
    );
    await call(t.server.port, `/api/devices/${deviceId}`, { method: 'PUT', headers: t.local(), body: { scopes: ['view', 'decide'] } });
    assert.equal((await call(t.server.port, '/api/board', { headers: t.as(secret) })).json().capabilities.decide, true);
  });

  it('serves the web app manifest to paired phones, under the CSP', async () => {
    const r = await call(t.server.port, '/manifest.webmanifest', { headers: t.as(secret) });
    assert.equal(r.status, 200);
    assert.match(String(r.headers['content-type']), /application\/manifest\+json/);
    assert.equal(JSON.parse(r.body).start_url, '/');
    const page = await call(t.server.port, '/', { headers: t.as(secret) });
    assert.match(String(page.headers['content-security-policy']), /manifest-src 'self'/);
    assert.match(page.body, /rel="manifest" href="\/manifest.webmanifest" crossorigin="use-credentials"/);
    assert.equal((await call(t.server.port, '/manifest.webmanifest', { headers: remote() })).status, 401, 'not to unpaired devices');
  });

  it('says on the computer when phone mode is off', async () => {
    const s2 = scratch();
    const cfg2 = loadConfig({ home: s2.home, claudeDir: s2.claude, codexDir: s2.codex, qwenDir: s2.qwen }, {});
    const store2 = new Store(cfg2.dbPath);
    const plain = await startUiServer(store2, cfg2, { port: 0, watch: false, terminal: null });
    try {
      assert.equal((await call(plain.port, '/api/board')).json().capabilities.pairPhones, false);
      const r = await call(plain.port, '/api/pair/code', { method: 'POST', headers: { 'X-ContextDeck-Token': plain.token } });
      assert.equal(r.status, 409);
      assert.equal(plain.pairingCode(), null);
    } finally {
      await plain.close();
      store2.close();
      s2.cleanup();
    }
  });

  it('only accepts known scopes, and always view', async () => {
    for (const scopes of [['view', 'root'], ['decide'], 'view', []]) {
      assert.equal((await call(t.server.port, `/api/devices/${deviceId}`, { method: 'PUT', headers: t.local(), body: { scopes } })).status, 400, JSON.stringify(scopes));
    }
  });
});

describe('phone devices: revoking, limits and the audit log', () => {
  const t = setup({ maxDevices: 2 });
  before(() => t.start());
  after(() => t.stop());

  it('revokes a device: the next request fails and its event stream closes at once', async () => {
    const { secret, deviceId } = await t.pair();
    const stream = await openEvents(t.server.port, t.as(secret));
    assert.equal(stream.status, 200);
    const r = await call(t.server.port, `/api/devices/${deviceId}`, { method: 'DELETE', headers: t.local() });
    assert.deepEqual(r.json().revoked, [deviceId]);
    await within(stream.ended, 1000, 'closing the stream');
    assert.equal((await call(t.server.port, '/api/board', { headers: t.as(secret) })).status, 401);
  });

  it('closes the stream within a second when revoked from the command line', async () => {
    const { secret, deviceId } = await t.pair();
    const stream = await openEvents(t.server.port, t.as(secret));
    assert.deepEqual(revokeDevices(t.s.home, deviceId), [deviceId]);
    await within(stream.ended, 1500, 'closing the stream');
  });

  it('sends device events only to this computer, never to phones', async () => {
    const { secret } = await t.pair();
    const phoneStream = await openEvents(t.server.port, t.as(secret));
    const localStream = await openEvents(t.server.port, { Host: `127.0.0.1:${t.server.port}` });
    await t.ask(await t.code(), 'Another');
    await new Promise((r) => setTimeout(r, 100));
    assert.match(localStream.text(), /event: devices/);
    assert.doesNotMatch(phoneStream.text(), /event: devices/);
    phoneStream.close();
    localStream.close();
    revokeDevices(t.s.home, 'all');
  });

  it('stops at the device limit, counting requests still waiting', async () => {
    revokeDevices(t.s.home, 'all');
    const file = loadDevices(t.s.home);
    file.pending = [];
    saveDevices(t.s.home, file);
    await t.pair('One');
    await t.ask(await t.code(), 'Two');
    const third = await t.ask(await t.code(), 'Three');
    assert.equal(third.r.status, 409);
    assert.match(third.r.json().error, /already has 2 phones/);
  });

  it('logs pairing, writes and revocations, without any content', async () => {
    revokeDevices(t.s.home, 'all');
    saveDevices(t.s.home, { version: 1, devices: [], pending: [] });
    const { secret, deviceId } = await t.pair();
    const sessionId = (await call(t.server.port, '/api/board')).json().sessions[0].id;
    const seq = (await call(t.server.port, `/api/session/${encodeURIComponent(sessionId)}`)).json().messages[0].seq;
    const made = await call(t.server.port, '/api/decisions', {
      method: 'POST',
      headers: t.as(secret, ME, { Origin: ORIGIN, 'X-ContextDeck-Token': t.server.token }),
      body: { sessionId, seq, text: 'the-private-words-xyz' },
    });
    assert.equal(made.status, 201);
    await call(t.server.port, `/api/devices/${deviceId}`, { method: 'DELETE', headers: t.local() });

    const log = readFileSync(auditPath(t.s.home), 'utf8');
    const actions = log.trim().split('\n').map((l) => JSON.parse(l).action);
    for (const a of ['pair-requested', 'pair-approved', 'pair-claimed', 'write', 'device-revoked']) assert.ok(actions.includes(a), a);
    const w = log.trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.action === 'write');
    assert.deepEqual([w.deviceId, w.method, w.route, w.status], [deviceId, 'POST', '/api/decisions', 201]);
    assert.ok(!log.includes('the-private-words-xyz'), 'no message text');
    assert.ok(!log.includes(secret), 'no secrets');
    if (!isWindows) assert.equal(statSync(auditPath(t.s.home)).mode & 0o777, 0o600);
  });
});

describe('phone pairing rate limit', () => {
  const t = setup({ perMinute: 5 });
  before(() => t.start());
  after(() => t.stop());

  it('allows 5 tries a minute, then refuses even the right code', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await t.ask('B'.repeat(22))).r.status, 403);
    const r = await t.ask(await t.code());
    assert.equal(r.r.status, 429);
    assert.equal((await t.ask(await t.code(), 'x', 'other@example.com')).r.status, 429, 'counted in total, too');
  });
});

describe('pairing codes', () => {
  it('expire after 5 minutes', () => {
    let now = 1_000_000;
    const codes = new PairingCodes(() => now);
    const { code } = codes.create();
    now += 5 * 60_000;
    assert.equal(codes.consume(code, ME), 'expired');
  });

  it('count tries per login and in total', () => {
    let now = 0;
    const codes = new PairingCodes(() => now, 2);
    assert.equal(codes.consume('x', 'a'), 'wrong');
    assert.equal(codes.consume('x', 'a'), 'wrong');
    assert.equal(codes.consume('x', 'a'), 'too-many');
    assert.equal(codes.consume('x', 'b'), 'too-many');
    now += 60_000;
    const { code } = codes.create();
    assert.equal(codes.consume(code, 'b'), 'ok');
    assert.equal(codes.consume(code, 'b'), 'used');
  });
});

describe('devices file', () => {
  it('drops anything invalid when loading', () => {
    const now = new Date().toISOString();
    const good = { id: 'dv_0123456789', name: 'Ok', tailscaleLogin: ME, secretHash: 'a'.repeat(64), scopes: ['view', 'root', 'decide'], createdAt: now, lastSeenAt: now, expiresAt: now };
    const f = sanitizeDevices({
      devices: [good, { ...good }, { ...good, id: 'dv_x' }, { ...good, id: 'dv_aaaaaaaaaa', secretHash: 'plain-secret' }, null, 'x'],
      pending: [{ id: 'pd_0123456789', name: 'P', tailscaleLogin: ME, claimHash: 'b'.repeat(64), state: 'hacked', requestedAt: now, expiresAt: now }],
    });
    assert.equal(f.devices.length, 1);
    assert.deepEqual(f.devices[0]!.scopes, ['view', 'decide']);
    assert.equal(f.pending.length, 0);
    assert.deepEqual(sanitizeDevices('garbage'), { version: 1, devices: [], pending: [] });
  });

  it('cleans device names', () => {
    assert.equal(cleanDeviceName('  My\u0000 phone‮  '), 'My phone');
    assert.equal(cleanDeviceName(''), 'Phone');
    assert.equal(cleanDeviceName(42), 'Phone');
    assert.equal([...cleanDeviceName('x'.repeat(100))].length, 40);
  });
});

describe('audit log', () => {
  it('rotates at the size limit, keeping one old file', () => {
    const s = scratch();
    for (let i = 0; i < 30; i++) appendAudit(s.home, { action: 'write', route: '/api/decisions' }, 500);
    const cur = readFileSync(auditPath(s.home), 'utf8');
    const old = readFileSync(`${auditPath(s.home)}.1`, 'utf8');
    assert.ok(cur.length <= 600 && old.length >= 500);
    s.cleanup();
  });
});

describe('route scopes', () => {
  it('has an entry for every API route the server handles', () => {
    const src = readFileSync(join(REPO, 'src/server.ts'), 'utf8');
    const found: [string, string][] = [];
    const re = /\(?method === '(\w+)'(?: \|\| method === '(\w+)'\))? && path(?: === '([^']+)'|\.startsWith\('([^']+)'\))/g;
    for (const m of src.matchAll(re)) {
      const path = m[3] ?? `${m[4]}x`;
      if (!path.startsWith('/api/')) continue;
      for (const method of [m[1], m[2]].filter(Boolean) as string[]) found.push([method, path]);
    }
    assert.ok(found.length >= 20, `found only ${found.length} routes; has the handler's style changed?`);
    for (const [method, path] of found) assert.ok(routeAccess(method, path), `${method} ${path} has no entry in src/scopes.ts`);
  });

  it('refuses routes that are not in the table, and keeps ids to one path segment', () => {
    assert.equal(routeAccess('GET', '/api/nope'), null);
    assert.equal(routeAccess('POST', '/api/board'), null);
    assert.equal(routeAccess('DELETE', '/api/decisions/'), null);
    assert.equal(routeAccess('PUT', '/api/devices/pending/pd_0123456789'), null);
    assert.equal(routeAccess('POST', '/api/devices/pending/pd_0123456789'), 'local');
  });

  it('never lets a phone change the layout, rescan, open a terminal or manage devices', () => {
    for (const r of ROUTES) {
      if (/open-terminal|reindex|devices|pair\/code/.test(r.path) || (r.method !== 'GET' && /layout|semantic/.test(r.path))) assert.equal(r.access, 'local', `${r.method} ${r.path}`);
    }
  });
});
