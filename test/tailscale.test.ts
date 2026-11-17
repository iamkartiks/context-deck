import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { loadDevices, saveDevices, type Scope } from '../src/devices.js';
import { qrModules, qrSvg, qrTerminal } from '../src/qr.js';
import {
  checkServe,
  inspectServe,
  requireReady,
  serve,
  serveArgs,
  status,
  unserve,
  unserveArgs,
  type TailscaleOptions,
} from '../src/tailscale.js';
import { FAKE_TAILNET, fakeTailscaleState, rawRequest, REPO, scratch, writeFakeTailscale } from './helpers.js';

const PORT = 4977;
const KEY = `${FAKE_TAILNET}:443`;

function fake(over: Record<string, unknown> = {}) {
  const s = scratch();
  const ts = writeFakeTailscale(s.dir, fakeTailscaleState(over));
  const opts: TailscaleOptions = { exec: { command: process.execPath, args: [ts.script] } };
  return { s, ts, opts };
}

describe('tailscale: status', () => {
  it('reads the tailnet name without its trailing dot', async () => {
    const { s, opts } = fake();
    assert.deepEqual(await status(opts), { running: true, dnsName: FAKE_TAILNET, httpsEnabled: true });
    assert.deepEqual(await requireReady(opts), { dnsName: FAKE_TAILNET });
    s.cleanup();
  });

  it('explains what is missing: not running, no name, no HTTPS, not installed', async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ status: { BackendState: 'Stopped', Self: { DNSName: '' } }, statusExit: 1 }, /isn’t running/],
      [{ status: { BackendState: 'NeedsLogin', Self: {} } }, /isn’t running/],
      [{ status: { BackendState: 'Running', Self: { DNSName: '' }, CertDomains: [] } }, /MagicDNS/],
      [{ status: { BackendState: 'Running', Self: { DNSName: `${FAKE_TAILNET}.` }, CertDomains: null } }, /HTTPS certificates aren’t enabled/],
    ];
    for (const [over, msg] of cases) {
      const { s, opts } = fake(over);
      await assert.rejects(requireReady(opts), msg);
      s.cleanup();
    }
    await assert.rejects(requireReady({ env: { ...process.env, CONTEXTDECK_TAILSCALE_BIN: join(REPO, 'no-such-tailscale') } }), /isn’t installed/);
  });
});

describe('tailscale: serve', () => {
  it('points https://<name>/ at our port, checks it, and removes only its own entry', async () => {
    const other = { 'other.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } };
    const { s, ts, opts } = fake({ serve: { Web: { ...other } } });
    assert.deepEqual(await serve(PORT, FAKE_TAILNET, opts), { added: true });
    assert.deepEqual(ts.calls(), [['serve', 'status', '--json'], serveArgs(PORT), ['serve', 'status', '--json']]);
    assert.deepEqual(serveArgs(PORT), ['serve', '--bg', '--https=443', 'http://127.0.0.1:4977']);
    assert.equal(ts.state().serve.Web[KEY].Handlers['/'].Proxy, 'http://127.0.0.1:4977');

    await unserve(opts);
    assert.deepEqual(ts.calls().at(-1), unserveArgs());
    assert.equal(ts.state().serve.Web[KEY], undefined);
    assert.deepEqual(ts.state().serve.Web['other.tail1234.ts.net:443'], other['other.tail1234.ts.net:443'], 'leaves other Serve settings alone');
    s.cleanup();
  });

  it('never runs anything that would turn on Funnel or reset Serve', async () => {
    const { s, ts, opts } = fake();
    await serve(PORT, FAKE_TAILNET, opts);
    await unserve(opts);
    for (const call of ts.calls()) {
      assert.ok(!call.includes('funnel'), call.join(' '));
      assert.ok(!call.includes('reset'), call.join(' '));
      assert.ok(!call.some((a) => /0\.0\.0\.0/.test(a)), call.join(' '));
    }
    s.cleanup();
  });

  it('refuses when Funnel is already on, without changing anything', async () => {
    const { s, ts, opts } = fake({
      serve: { Web: { [KEY]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:4977' } } } }, AllowFunnel: { [KEY]: true } },
    });
    await assert.rejects(serve(PORT, FAKE_TAILNET, opts), /Funnel is on/);
    assert.deepEqual(ts.calls(), [['serve', 'status', '--json']]);
    await assert.rejects(checkServe(PORT, FAKE_TAILNET, opts), /Funnel is on/);
    s.cleanup();
  });

  it('refuses, and undoes its entry, if Funnel turns out to be on afterwards', async () => {
    const { s, ts, opts } = fake({ funnelAfterServe: true });
    await assert.rejects(serve(PORT, FAKE_TAILNET, opts), /Funnel is on/);
    assert.deepEqual(ts.calls().at(-1), unserveArgs());
    s.cleanup();
  });

  it('won’t replace something else already served at that address', async () => {
    const { s, ts, opts } = fake({ serve: { Web: { [KEY]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8080' } } } } } });
    await assert.rejects(serve(PORT, FAKE_TAILNET, opts), /already sends .* to http:\/\/127\.0\.0\.1:8080.*won’t replace it/s);
    assert.equal(ts.calls().length, 1);
    s.cleanup();
  });

  it('gives the command to run by hand when serve fails', async () => {
    const { s, opts } = fake({ failServe: true });
    await assert.rejects(serve(PORT, FAKE_TAILNET, opts), /HTTPS is not enabled[\s\S]*tailscale serve --bg --https=443 http:\/\/127\.0\.0\.1:4977[\s\S]*--no-serve/);
    s.cleanup();
  });

  it('with --no-serve, only checks: warns when Serve points elsewhere', async () => {
    const { s, ts, opts } = fake();
    assert.match((await checkServe(PORT, FAKE_TAILNET, opts)).warning ?? '', /doesn’t send/);
    ts.setState(fakeTailscaleState({ serve: { Web: { [KEY]: { Handlers: { '/': { Proxy: '127.0.0.1:4977' } } } } } }));
    assert.equal((await checkServe(PORT, FAKE_TAILNET, opts)).warning, null);
    assert.ok(ts.calls().every((c) => c[1] === 'status'), 'never changes Serve');
    s.cleanup();
  });

  it('finds Funnel on any address that reaches our port', () => {
    const cfg = { Web: { 'laptop.tail1234.ts.net:8443': { Handlers: { '/x': { Proxy: 'http://localhost:4977' } } } }, AllowFunnel: { 'laptop.tail1234.ts.net:8443': true } };
    assert.equal(inspectServe(cfg, FAKE_TAILNET, PORT).funnel, true);
    assert.equal(inspectServe(cfg, FAKE_TAILNET, 5000).funnel, false);
    assert.deepEqual(inspectServe(null, FAKE_TAILNET, PORT), { ours: false, other: null, funnel: false });
  });
});

describe('qr codes', () => {
  it('draws a square code with a light border', () => {
    const m = qrModules('Hello, world!');
    assert.equal(m.length, 21 + 8, 'version 1 plus the quiet zone');
    assert.ok(m.every((row) => row.length === m.length));
    assert.ok(m[0]!.every((x) => !x) && m.at(-1)!.every((x) => !x), 'quiet zone is light');
    assert.equal(m[4]![4], true, 'finder pattern corner');
  });

  it('renders for terminals, with and without colour, and as SVG', () => {
    const url = `https://${FAKE_TAILNET}/pair#${'A'.repeat(22)}`;
    const size = qrModules(url).length;
    const plain = qrTerminal(url, { color: false }).split('\n');
    assert.equal(plain.length, Math.ceil(size / 2));
    assert.ok(plain.every((l) => [...l].length === size && /^[█▀▄ ]+$/.test(l)));
    const colored = qrTerminal(url, { color: true });
    assert.equal(colored.split('\n').length, Math.ceil(size / 2));
    // Never a glyph drawn in its own background colour: uniform cells are spaces, mixed ones black on white
    for (const cell of colored.match(/\x1b\[[\d;]*m./gu) ?? []) {
      assert.match(cell, /^\x1b\[0;(?:40m |107m |30;107m[▀▄])$/u, JSON.stringify(cell));
    }
    const svg = qrSvg(url);
    assert.match(svg, new RegExp(`^<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"`));
    assert.doesNotMatch(svg, /<script|on\w+=/);
  });
});

describe('cli: phone', () => {
  const s = scratch();
  const BIN = join(REPO, 'bin/contextdeck.js');
  const base = ['--home', s.home, '--claude-dir', s.claude, '--codex-dir', s.codex, '--qwen-dir', s.qwen];
  const run = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [BIN, ...base, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', ...env } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  after(() => s.cleanup());

  it('lists and revokes devices', () => {
    assert.match(run(['phone', 'devices']).out, /No phones are paired/);
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const dev = (id: string, name: string) => ({
      id,
      name,
      tailscaleLogin: 'you@example.com',
      secretHash: 'c'.repeat(64),
      scopes: ['view', 'decide'] as Scope[],
      createdAt: iso(now),
      lastSeenAt: iso(now),
      expiresAt: iso(now + 86_400_000),
    });
    saveDevices(s.home, { version: 1, devices: [dev('dv_aaaaaaaaaa', 'Pixel 9'), dev('dv_bbbbbbbbbb', 'iPad')], pending: [] });
    const list = run(['phone', 'devices']);
    assert.match(list.out, /dv_aaaaaaaaaa\s+Pixel 9\s+you@example\.com\s+view, decide/);
    const json = JSON.parse(run(['phone', 'devices', '--json']).out);
    assert.equal(json.length, 2);
    assert.equal(json[0].secretHash, undefined, 'never prints the hash');

    assert.equal(run(['phone', 'revoke']).code, 2);
    const missing = run(['phone', 'revoke', 'dv_cccccccccc']);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /No paired device/);
    assert.match(run(['phone', 'revoke', 'dv_aaaaaaaaaa']).out, /Removed 1 device: dv_aaaaaaaaaa/);
    assert.deepEqual(JSON.parse(run(['phone', 'revoke', 'all', '--json']).out), { revoked: ['dv_bbbbbbbbbb'] });
    assert.equal(loadDevices(s.home).devices.length, 0);
    assert.equal(run(['phone', 'what']).code, 2);
  });

  it('refuses --no-serve without --phone, and stops early when Tailscale isn’t ready', () => {
    assert.equal(run(['ui', '--no-serve']).code, 2);
    const ts = writeFakeTailscale(s.dir, fakeTailscaleState({ status: { BackendState: 'Stopped', Self: {} }, statusExit: 1 }));
    const r = run(['ui', '--phone', '--no-open', '--port', '0'], { CONTEXTDECK_TAILSCALE_BIN: ts.script });
    if (process.platform === 'win32') return; // a .mjs can't be run directly there; the module tests cover it
    assert.equal(r.code, 1);
    assert.match(r.err, /Tailscale isn’t running/);
    assert.doesNotMatch(r.out, /indexed/, 'checks Tailscale before indexing');
  });

  it('refuses to start when Funnel is on', { skip: process.platform === 'win32' }, () => {
    const ts = writeFakeTailscale(s.dir, fakeTailscaleState({ funnelAfterServe: true }));
    const r = run(['ui', '--phone', '--no-open', '--port', '0'], { CONTEXTDECK_TAILSCALE_BIN: ts.script });
    assert.equal(r.code, 1);
    assert.match(r.err, /Funnel is on/);
    assert.equal(ts.state().serve.Web[KEY], undefined, 'took its entry back out');
  });

  it('ui --phone: sets up Serve, prints a working pairing code, and cleans up on Ctrl+C', { skip: process.platform === 'win32' }, async () => {
    const ts = writeFakeTailscale(s.dir);
    const child = spawn(process.execPath, [BIN, ...base, 'ui', '--phone', '--no-open', '--port', '0'], {
      env: { ...process.env, NO_COLOR: '1', CONTEXTDECK_TAILSCALE_BIN: ts.script },
    });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (out += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (out += c));
    const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
    const deadline = Date.now() + 15_000;
    while (!/Or open https:\/\/\S+pair#\S+ on the phone/.test(out)) {
      if (Date.now() > deadline) {
        child.kill();
        assert.fail(`no pairing code printed:\n${out}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const port = Number(/open at http:\/\/127\.0\.0\.1:(\d+)\//.exec(out)![1]);
    const code = /pair#([A-Za-z0-9_-]+)/.exec(out)![1]!;
    assert.match(out, new RegExp(`On your phone: https://${FAKE_TAILNET.replace(/\./g, '\\.')}/`));
    assert.match(out, /devices on your Tailscale network that you approve/);
    assert.match(out, /[█▀▄]/, 'draws the QR code');
    assert.deepEqual(ts.calls().find((c) => c[1] === '--bg'), serveArgs(port));

    // The printed code pairs a phone, and the terminal says so
    const r = await rawRequest(port, '/api/pair', {
      method: 'POST',
      headers: { Host: FAKE_TAILNET, 'Tailscale-User-Login': 'you@example.com', Origin: `https://${FAKE_TAILNET}` },
      body: { code, name: 'Pixel 9' },
    });
    assert.equal(r.status, 202, r.body);
    for (let i = 0; i < 40 && !/wants to pair/.test(out); i++) await new Promise((res) => setTimeout(res, 50));
    assert.match(out, /Pixel 9 \(you@example\.com\) wants to pair/);

    child.kill('SIGINT');
    assert.equal(await exited, 0);
    assert.match(out, /Removed the Tailscale Serve entry/);
    assert.deepEqual(ts.calls().at(-1), unserveArgs());
    assert.equal(ts.state().serve.Web[KEY], undefined);
  });
});
