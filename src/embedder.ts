import { isLocalUrl, type SemanticSettings } from './settings.js';

/**
 * Talks to a local embedding model: Ollama (POST /api/embed) or any server
 * with the OpenAI embeddings API (LM Studio, llama.cpp's server, vLLM…).
 *
 * Only ever called when search by meaning is turned on. Refuses servers that
 * aren't on this computer unless you explicitly allowed it.
 */

export type EmbedKind = 'query' | 'document';

export interface Embedder {
  /** Identifies the vectors this embedder makes; changing it means re-embedding. */
  readonly key: string;
  embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]>;
}

export class EmbedError extends Error {}

const TASK = 'Given a question about past coding-agent sessions, find the messages that answer it';

/**
 * Many embedding models expect queries (and sometimes documents) in a
 * particular wording. Matching it makes a real difference to results.
 */
export function formatFor(model: string, kind: EmbedKind, text: string): string {
  const m = model.toLowerCase();
  if (m.includes('qwen3-embedding') || m.includes('qwen3_embedding')) return kind === 'query' ? `Instruct: ${TASK}\nQuery:${text}` : text;
  if (m.includes('embeddinggemma')) return kind === 'query' ? `task: search result | query: ${text}` : `title: none | text: ${text}`;
  if (m.includes('nomic-embed')) return `${kind === 'query' ? 'search_query' : 'search_document'}: ${text}`;
  if (m.includes('e5')) return `${kind === 'query' ? 'query' : 'passage'}: ${text}`;
  if (m.includes('mxbai-embed')) return kind === 'query' ? `Represent this sentence for searching relevant passages: ${text}` : text;
  return text;
}

/** Keep the first `dims` numbers and rescale to length 1, so a dot product is cosine similarity. */
export function shapeVector(raw: ArrayLike<number>, dims: number): Float32Array {
  const n = dims > 0 ? Math.min(dims, raw.length) : raw.length;
  const v = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = Number(raw[i]);
    v[i] = Number.isFinite(x) ? x : 0;
    sum += v[i]! * v[i]!;
  }
  const len = Math.sqrt(sum) || 1;
  for (let i = 0; i < n; i++) v[i]! /= len;
  return v;
}

export function embedderKey(s: Pick<SemanticSettings, 'api' | 'model' | 'dims'>): string {
  return `${s.api}:${s.model}@${s.dims || 'full'}`;
}

export function checkAllowed(s: SemanticSettings): void {
  if (!isLocalUrl(s.url) && !s.allowRemote) {
    throw new EmbedError(
      `${s.url} isn't on this computer, so session text would leave it. Use a local server, or allow this explicitly (--allow-remote).`,
    );
  }
}

const TIMEOUT_MS = 180_000; // the first request may load the model into memory

export function createEmbedder(s: SemanticSettings, fetchImpl: typeof fetch = fetch): Embedder {
  checkAllowed(s);
  const base = s.url.replace(/\/+$/, '');

  const post = async (path: string, body: unknown): Promise<unknown> => {
    let res: Response;
    try {
      res = await fetchImpl(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      if (e.name === 'TimeoutError') throw new EmbedError(`The model at ${base} took too long to answer.`);
      const how = s.api === 'ollama' ? 'Start Ollama (open the app, or run `ollama serve`)' : 'Start your model server';
      throw new EmbedError(`Nothing is answering at ${base}. ${how}, or check the address.`);
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* reported below */
    }
    if (!res.ok) {
      // Ollama: { error: "…" }; OpenAI-style: { error: { message: "…" } }
      const field = (data as { error?: unknown } | null)?.error;
      const nested = field && typeof field === 'object' ? (field as { message?: unknown }).message : undefined;
      const msg = typeof field === 'string' ? field : typeof nested === 'string' ? nested : text.slice(0, 200);
      if (s.api === 'ollama' && (res.status === 404 || /not found/i.test(msg))) {
        throw new EmbedError(`Ollama doesn't have "${s.model}" yet. Run: ollama pull ${s.model}`);
      }
      throw new EmbedError(`The model server answered ${res.status}: ${msg || 'no details'}`);
    }
    if (data == null) throw new EmbedError(`The model server at ${base} didn't answer with JSON.`);
    return data;
  };

  return {
    key: embedderKey(s),
    async embed(texts, kind) {
      if (!texts.length) return [];
      const input = texts.map((t) => formatFor(s.model, kind, t));
      let vectors: unknown[];
      if (s.api === 'ollama') {
        const data = (await post('/api/embed', { model: s.model, input, truncate: true, keep_alive: '10m' })) as { embeddings?: unknown };
        vectors = Array.isArray(data.embeddings) ? data.embeddings : [];
      } else {
        const path = /\/v1$/.test(base) ? '/embeddings' : '/v1/embeddings';
        const data = (await post(path, { model: s.model, input })) as { data?: { embedding?: unknown; index?: number }[] };
        vectors = Array.isArray(data.data) ? [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding) : [];
      }
      if (vectors.length !== texts.length || !vectors.every((v) => Array.isArray(v) && v.length > 0)) {
        throw new EmbedError(`The model "${s.model}" didn't return embeddings. Is it an embedding model?`);
      }
      return vectors.map((v) => shapeVector(v as number[], s.dims));
    },
  };
}
