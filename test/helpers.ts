import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
