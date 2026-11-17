import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';

/** Repo root, resolved from dist/test/ at runtime. */
export const REPO = fileURLToPath(new URL('../../', import.meta.url));
export const FIXTURES = join(REPO, 'fixtures');
export const CLAUDE_FIXTURES = join(FIXTURES, 'claude');
export const CODEX_FIXTURES = join(FIXTURES, 'codex');
export const QWEN_FIXTURES = join(FIXTURES, 'qwen');

export const CC_MAIN = join(
  CLAUDE_FIXTURES,
  'projects/-Users-alice-code-acme-shop/7c1e2a90-4b3d-4f6a-9c21-5d8e0f3a1b11.jsonl',
);
export const CC_SUBAGENT = join(
  CLAUDE_FIXTURES,
  'projects/-Users-alice-code-acme-shop/7c1e2a90-4b3d-4f6a-9c21-5d8e0f3a1b11/subagents/agent-4e5f6a7b.jsonl',
);
export const CC_SNAPSHOT_ONLY = join(
  CLAUDE_FIXTURES,
  'projects/-Users-alice-code-blog/9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c33.jsonl',
);
export const CX_MODERN = join(
  CODEX_FIXTURES,
  'sessions/2026/10/27/rollout-2026-10-27T08-30-00-019a2f3c-5d6e-7f80-91a2-b3c4d5e6f701.jsonl',
);
export const CX_LEGACY = join(
  CODEX_FIXTURES,
  'sessions/2025/08/14/rollout-2025-08-14T16-05-11-3a4b5c6d-7e8f-4a1b-9c2d-0e1f2a3b4c5d.jsonl',
);

/** A scratch dir with a private copy of the fixtures, so tests can modify them. */
export const QW_MAIN = join(QWEN_FIXTURES, 'projects/-Users-alice-code-acme-shop/chats/5d2c8e41-7a3b-4c6d-9e0f-1a2b3c4d5e61.jsonl');
export const QW_SUBAGENT = join(
  QWEN_FIXTURES,
  'projects/-Users-alice-code-acme-shop/subagents/5d2c8e41-7a3b-4c6d-9e0f-1a2b3c4d5e61/agent-explore-7f3c.jsonl',
);
export const QW_DEEPSEEK = join(QWEN_FIXTURES, 'projects/-Users-alice-code-blog/chats/8f7e6d5c-4b3a-4291-8e7f-6d5c4b3a2f72.jsonl');

export function scratch(): { dir: string; claude: string; codex: string; qwen: string; home: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'contextdeck-test-'));
  const claude = join(dir, 'claude');
  const codex = join(dir, 'codex');
  cpSync(CLAUDE_FIXTURES, claude, { recursive: true });
  const qwen = join(dir, 'qwen');
  cpSync(CODEX_FIXTURES, codex, { recursive: true });
  cpSync(QWEN_FIXTURES, qwen, { recursive: true });
  return { dir, claude, codex, qwen, home: join(dir, 'home'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * A stand-in for a local embedding server (Ollama's /api/embed and the OpenAI
 * /v1/embeddings API). Each "concept" gets its own dimension, so text about
 * databases (database, Postgres, SQLite…) lands close together, as it would
 * with a real model, while unrelated text doesn't.
 */
export const CONCEPTS: Record<string, string[]> = {
  database: ['database', 'databases', 'postgres', 'postgresql', 'sqlite', 'mysql', 'db', 'डेटाबेस'],
  auth: ['auth', 'login', 'cookie', 'cookies', 'session', 'jwt', 'token', 'httponly'],
  limits: ['rate', 'limit', 'limiting', 'throttle', '429', 'retry-after'],
  feed: ['rss', 'feed', 'atom'],
  decide: ['decided', 'decide', 'decision', 'chose', 'choose', "let's", 'go', 'pick', 'picked', 'tay', 'kiya'],
};

export function fakeVector(text: string, dims = 16): number[] {
  const v = new Array(dims).fill(0);
  const words = text.toLowerCase().match(/[\p{L}\p{N}'-]+/gu) ?? [];
  const names = Object.keys(CONCEPTS);
  for (const w of words) {
    const c = names.findIndex((n) => CONCEPTS[n]!.includes(w));
    if (c >= 0) v[c] += 1;
    else v[names.length + ([...w].reduce((a, ch) => a + ch.charCodeAt(0), 0) % (dims - names.length))] += 0.15;
  }
  if (v.every((x) => x === 0)) v[dims - 1] = 1;
  return v;
}

export interface FakeModelServer {
  url: string;
  calls: { path: string; model: string; inputs: string[] }[];
  close(): Promise<void>;
}

export async function startFakeModelServer(opts: { models?: string[]; dims?: number } = {}): Promise<FakeModelServer> {
  const { createServer } = await import('node:http');
  const models = opts.models ?? ['qwen3-embedding:0.6b', 'nomic-embed-text'];
  const calls: FakeModelServer['calls'] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      let j: { model?: string; input?: string | string[] } = {};
      try {
        j = JSON.parse(body);
      } catch {
        return send(400, { error: 'bad json' });
      }
      const inputs = Array.isArray(j.input) ? j.input : [String(j.input ?? '')];
      // Strip the query wording the client adds, as a real model would just read it
      const plain = inputs.map((t) => t.replace(/^Instruct: .*\nQuery:/s, ''));
      if (!models.includes(String(j.model))) {
        return req.url === '/api/embed'
          ? send(404, { error: `model "${j.model}" not found, try pulling it first` })
          : send(404, { error: { message: `model ${j.model} not loaded` } });
      }
      calls.push({ path: req.url ?? '', model: String(j.model), inputs: plain });
      const vecs = plain.map((t) => fakeVector(t, opts.dims));
      if (req.url === '/api/embed') return send(200, { model: j.model, embeddings: vecs });
      if (req.url === '/v1/embeddings') return send(200, { data: vecs.map((embedding, index) => ({ object: 'embedding', index, embedding })).reverse() });
      return send(404, { error: 'not found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise((r) => server.close(() => r())) };
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: () => any;
}

/**
 * A raw HTTP request to 127.0.0.1, so tests can send any Host, Origin or
 * proxy header (fetch won't let us set Host). Defaults Host to 127.0.0.1:<port>.
 */
export function rawRequest(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = httpRequest(
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

/**
 * A fake `tailscale` CLI: a Node script that answers `status --json`,
 * `serve status --json`, `serve --bg --https=443 <target>` and
 * `serve --https=443 off` from a JSON state file, and logs every call's
 * arguments (one JSON array per line). Set `state.funnelAfterServe` to have
 * Serve turn Funnel on, or `state.failServe` to make `serve` fail.
 */
export interface FakeTailscale {
  script: string;
  statePath: string;
  logPath: string;
  state: () => any;
  setState: (s: any) => void;
  calls: () => string[][];
}

export const FAKE_TAILNET = 'laptop.tail1234.ts.net';

export function fakeTailscaleState(over: Record<string, unknown> = {}) {
  return {
    status: { BackendState: 'Running', Self: { DNSName: `${FAKE_TAILNET}.` }, CertDomains: [FAKE_TAILNET] },
    serve: {},
    ...over,
  };
}

export function writeFakeTailscale(dir: string, state: Record<string, unknown> = fakeTailscaleState()): FakeTailscale {
  const script = join(dir, 'fake-tailscale.mjs');
  const statePath = join(dir, 'fake-tailscale.json');
  const logPath = join(dir, 'fake-tailscale.log');
  writeFileSync(
    script,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const statePath = ${JSON.stringify(statePath)};
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');
const st = JSON.parse(readFileSync(statePath, 'utf8'));
const save = () => writeFileSync(statePath, JSON.stringify(st));
const key = st.status.Self.DNSName.replace(/\\.$/, '') + ':443';
const is = (...want) => want.length === args.length && want.every((w, i) => w === args[i]);
if (is('status', '--json')) {
  process.stdout.write(JSON.stringify(st.status));
  process.exit(st.statusExit ?? 0);
} else if (is('serve', 'status', '--json')) {
  process.stdout.write(JSON.stringify(st.serve));
} else if (args[0] === 'serve' && args[1] === '--bg' && args[2] === '--https=443' && args.length === 4) {
  if (st.failServe) { process.stderr.write('serve: HTTPS is not enabled\\n'); process.exit(1); }
  st.serve.TCP = { ...(st.serve.TCP ?? {}), 443: { HTTPS: true } };
  st.serve.Web = { ...(st.serve.Web ?? {}), [key]: { Handlers: { '/': { Proxy: args[3] } } } };
  if (st.funnelAfterServe) st.serve.AllowFunnel = { [key]: true };
  save();
} else if (is('serve', '--https=443', 'off')) {
  if (st.serve.Web) delete st.serve.Web[key];
  if (st.serve.TCP) delete st.serve.TCP[443];
  save();
} else {
  process.stderr.write('fake tailscale: unexpected arguments ' + JSON.stringify(args) + '\\n');
  process.exit(2);
}
`,
    { mode: 0o755 },
  );
  writeFileSync(statePath, JSON.stringify(state));
  writeFileSync(logPath, '');
  return {
    script,
    statePath,
    logPath,
    state: () => JSON.parse(readFileSync(statePath, 'utf8')),
    setState: (s) => writeFileSync(statePath, JSON.stringify(s)),
    calls: () =>
      readFileSync(logPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
  };
}

/**
 * A fake agent CLI (stands in for claude, codex or qwen in headless mode): a
 * Node script that reads all of stdin, records {args, cwd, stdin} to
 * `logPath`, prints the lines of a stream recording, and exits with
 * `exitCode`. Set FAKE_AGENT_STREAM, FAKE_AGENT_LOG and FAKE_AGENT_EXIT in
 * its environment, or pass them to writeFakeAgent().
 */
export interface FakeAgent {
  script: string;
  logPath: string;
  calls: () => { args: string[]; cwd: string; stdin: string }[];
}

export function writeFakeAgent(dir: string, opts: { stream: string; exitCode?: number; name?: string }): FakeAgent {
  const script = join(dir, `fake-${opts.name ?? 'agent'}.mjs`);
  const logPath = join(dir, `fake-${opts.name ?? 'agent'}.log`);
  writeFileSync(
    script,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const stdin = Buffer.concat(chunks).toString('utf8');
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), stdin }) + '\\n');
process.stdout.write(readFileSync(${JSON.stringify(opts.stream)}, 'utf8'));
process.exit(${opts.exitCode ?? 0});
`,
    { mode: 0o755 },
  );
  writeFileSync(logPath, '');
  return {
    script,
    logPath,
    calls: () =>
      readFileSync(logPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
  };
}
