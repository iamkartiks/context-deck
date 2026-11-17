import { spawn } from 'node:child_process';

/**
 * The Tailscale CLI, for phone mode.
 *
 * ContextDeck only ever uses Tailscale Serve, which is reachable from your
 * own tailnet. It never turns on Funnel (public), and it refuses to run if
 * Funnel is on for the address that points at ContextDeck.
 *
 * Every call is `spawn` with an argument list, never a shell. The binary is
 * CONTEXTDECK_TAILSCALE_BIN, else `tailscale` on PATH, else (macOS) the one
 * inside Tailscale.app.
 *
 * Command forms used (Tailscale 1.52 and later):
 *   tailscale status --json
 *   tailscale serve status --json
 *   tailscale serve --bg --https=443 http://127.0.0.1:<port>
 *   tailscale serve --https=443 off
 * These haven't been checked against a real install yet; the phone-mode
 * manual test must confirm them before release.
 */

export class TailscaleError extends Error {}

export interface TailscaleOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  /** Run this instead of the Tailscale CLI, with these arguments first (tests). */
  exec?: { command: string; args: string[] };
}

export interface TailscaleStatus {
  running: boolean;
  /** This computer's tailnet name, without the trailing dot. */
  dnsName: string | null;
  httpsEnabled: boolean;
}

const MAC_APP_BIN = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const HTTPS_PORT = 443;

function candidates(opts: TailscaleOptions): string[] {
  const env = opts.env ?? process.env;
  if (env.CONTEXTDECK_TAILSCALE_BIN) return [env.CONTEXTDECK_TAILSCALE_BIN];
  return (opts.platform ?? process.platform) === 'darwin' ? ['tailscale', MAC_APP_BIN] : ['tailscale'];
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runOnce(bin: string, args: string[], opts: TailscaleOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: opts.env ?? process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c.length + stdout.length > 4_000_000 ? '' : c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += stderr.length > 100_000 ? '' : c));
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 15_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** Run the Tailscale CLI with an argument list. Throws TailscaleError if it isn't installed. */
export async function runTailscale(args: string[], opts: TailscaleOptions = {}): Promise<RunResult> {
  if (opts.exec) return runOnce(opts.exec.command, [...opts.exec.args, ...args], opts);
  for (const bin of candidates(opts)) {
    try {
      return await runOnce(bin, args, opts);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new TailscaleError(`Couldn't run Tailscale: ${(err as Error).message}`);
    }
  }
  throw new TailscaleError('Tailscale isn’t installed, or `tailscale` isn’t on your PATH. Install it from https://tailscale.com/download and sign in.');
}

function parseJson(text: string, what: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new TailscaleError(`Tailscale gave ${what} that ContextDeck couldn’t read.`);
  }
}

const firstLine = (s: string) => s.trim().split('\n')[0] ?? '';

/** Whether Tailscale is running, this computer's tailnet name, and whether HTTPS certificates are on. */
export async function status(opts: TailscaleOptions = {}): Promise<TailscaleStatus> {
  const r = await runTailscale(['status', '--json'], opts);
  const j = parseJson(r.stdout, 'a status') as { BackendState?: unknown; Self?: { DNSName?: unknown }; CertDomains?: unknown };
  const running = j.BackendState === 'Running';
  if (r.code !== 0 && !running) return { running: false, dnsName: null, httpsEnabled: false };
  const dns = typeof j.Self?.DNSName === 'string' ? j.Self.DNSName.replace(/\.$/, '').toLowerCase() : '';
  return {
    running,
    dnsName: dns || null,
    httpsEnabled: Array.isArray(j.CertDomains) && j.CertDomains.length > 0,
  };
}

/** Like status(), but throws a readable error unless phone mode can work. */
export async function requireReady(opts: TailscaleOptions = {}): Promise<{ dnsName: string }> {
  const st = await status(opts);
  if (!st.running) throw new TailscaleError('Tailscale isn’t running. Start it and sign in, then try again.');
  if (!st.dnsName) throw new TailscaleError('This computer has no tailnet name. Turn on MagicDNS in the Tailscale admin console, then try again.');
  if (!st.httpsEnabled) {
    throw new TailscaleError('HTTPS certificates aren’t enabled for your tailnet. Turn on HTTPS on the DNS page of the Tailscale admin console, then try again.');
  }
  return { dnsName: st.dnsName };
}

export interface ServeCheck {
  /** Serve sends https://<name>/ to ContextDeck's port. */
  ours: boolean;
  /** Something else is already served at https://<name>/ (its target), or null. */
  other: string | null;
  /** Funnel (public internet) is on for an address that reaches ContextDeck's port, or for https://<name>/. */
  funnel: boolean;
}

const pointsAt = (proxy: unknown, port: number) =>
  typeof proxy === 'string' && new RegExp(`^(?:https?://)?(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}/?$`).test(proxy);

/** Read what Serve is doing for `dnsName` and whether any of it is public. */
export function inspectServe(config: unknown, dnsName: string, port: number): ServeCheck {
  const cfg = (config ?? {}) as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown; Path?: unknown; Text?: unknown }> }>; AllowFunnel?: Record<string, unknown> };
  const web = cfg.Web && typeof cfg.Web === 'object' ? cfg.Web : {};
  const funnelOn = (key: string) => cfg.AllowFunnel?.[key] === true;
  const key = `${dnsName}:${HTTPS_PORT}`;
  const root = web[key]?.Handlers?.['/'];
  const ours = !!root && pointsAt(root.Proxy, port);
  const other = root && !ours ? String(root.Proxy ?? root.Path ?? 'a file or text') : null;
  let funnel = funnelOn(key);
  for (const [k, site] of Object.entries(web)) {
    if (Object.values(site?.Handlers ?? {}).some((h) => pointsAt(h?.Proxy, port)) && funnelOn(k)) funnel = true;
  }
  return { ours, other, funnel };
}

export async function serveStatus(opts: TailscaleOptions = {}): Promise<unknown> {
  const r = await runTailscale(['serve', 'status', '--json'], opts);
  if (r.code !== 0) throw new TailscaleError(`Couldn’t read Tailscale Serve’s settings: ${firstLine(r.stderr) || `exit ${r.code}`}`);
  return parseJson(r.stdout, 'Serve settings');
}

export const serveArgs = (port: number) => ['serve', '--bg', `--https=${HTTPS_PORT}`, `http://127.0.0.1:${port}`];
export const unserveArgs = () => ['serve', `--https=${HTTPS_PORT}`, 'off'];
export const serveCommandText = (port: number) => `tailscale ${serveArgs(port).join(' ')}`;
export const unserveCommandText = () => `tailscale ${unserveArgs().join(' ')}`;

const FUNNEL_REFUSAL =
  'Tailscale Funnel is on for this address, which would put ContextDeck on the public internet. ContextDeck won’t run like that. Turn Funnel off (`tailscale funnel reset`, or in the admin console) and try again.';

/**
 * Point https://<dnsName>/ at ContextDeck through Serve, then check it took
 * and isn't public. Returns whether ContextDeck added the entry (so it should
 * remove it when it stops). Refuses to replace anything else served there.
 */
export async function serve(port: number, dnsName: string, opts: TailscaleOptions = {}): Promise<{ added: boolean }> {
  const before = inspectServe(await serveStatus(opts), dnsName, port);
  if (before.funnel) throw new TailscaleError(FUNNEL_REFUSAL);
  if (before.other) {
    throw new TailscaleError(
      `Tailscale Serve already sends https://${dnsName}/ to ${before.other}. ContextDeck won’t replace it. Remove it, or set up Serve for port ${port} yourself and start with --no-serve.`,
    );
  }
  // An entry left behind by an earlier run that pointed at this same port is ours to reuse and remove
  if (!before.ours) {
    const r = await runTailscale(serveArgs(port), opts);
    if (r.code !== 0) {
      throw new TailscaleError(
        `Tailscale Serve couldn’t be set up: ${firstLine(r.stderr) || `exit ${r.code}`}\nTry it yourself with:\n  ${serveCommandText(port)}\nthen start ContextDeck with --phone --no-serve.`,
      );
    }
  }
  const after = inspectServe(await serveStatus(opts), dnsName, port);
  if (after.funnel || !after.ours) {
    await unserve(opts).catch(() => {});
    throw new TailscaleError(after.funnel ? FUNNEL_REFUSAL : `Tailscale Serve didn’t point https://${dnsName}/ at port ${port}. Try:\n  ${serveCommandText(port)}`);
  }
  return { added: true };
}

/** For --no-serve: Serve is set up by hand. Refuse Funnel; say if it doesn't point here. */
export async function checkServe(port: number, dnsName: string, opts: TailscaleOptions = {}): Promise<{ warning: string | null }> {
  const check = inspectServe(await serveStatus(opts), dnsName, port);
  if (check.funnel) throw new TailscaleError(FUNNEL_REFUSAL);
  return {
    warning: check.ours ? null : `Tailscale Serve doesn’t send https://${dnsName}/ to port ${port} yet. To set it up:\n  ${serveCommandText(port)}`,
  };
}

/** Remove ContextDeck's Serve entry (https on 443 only), leaving the rest of your Serve settings alone. */
export async function unserve(opts: TailscaleOptions = {}): Promise<void> {
  const r = await runTailscale(unserveArgs(), opts);
  if (r.code !== 0) throw new TailscaleError(`${firstLine(r.stderr) || `exit ${r.code}`}`);
}
