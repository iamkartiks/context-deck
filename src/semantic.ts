import { createHash } from 'node:crypto';
import { loadDecisions } from './decisions.js';
import type { Embedder } from './embedder.js';
import type { ChunkRow, SearchHit, Store, StoredChunk } from './store.js';

/**
 * Search by meaning.
 *
 *   1. catchUp() turns each session's conversation into pieces (prompts and
 *      replies, split if long; the title; your decisions), asks the local
 *      model for a vector per piece, and stores them in index.db. Newest
 *      sessions first; unchanged sessions are skipped; safe to stop anytime.
 *   2. search() turns the question into a vector and compares it with every
 *      stored one (an in-memory scan: ~0.1 s per 100k pieces).
 *   3. combine() merges that with word search, so exact words still win and
 *      meaning fills the gaps.
 *
 * Tool output isn't embedded: file dumps and logs would drown out what was said.
 */

/** Pieces of a long message: ~300 tokens each, overlapping so no sentence is cut off from its context. */
const PIECE = 1200;
const OVERLAP = 200;
const MAX_PIECES_PER_MESSAGE = 6;
const BATCH = 16;

export interface Piece extends Omit<ChunkRow, 'vec'> {
  text: string;
}

const hash8 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** Split one message into the pieces that get embedded. */
export function piecesOf(seq: number, text: string): Piece[] {
  const out: Piece[] = [];
  if (text.trim().length < 3) return out;
  if (text.length <= PIECE + OVERLAP) {
    out.push({ kind: 'message', ref: `m:${seq}:0:${hash8(text)}`, seq, start: 0, len: text.length, text });
    return out;
  }
  for (let start = 0; start < text.length && out.length < MAX_PIECES_PER_MESSAGE; start += PIECE - OVERLAP) {
    // Prefer to start and end at a space, so words aren't split
    let s = start;
    if (s > 0) {
      const sp = text.indexOf(' ', s);
      if (sp > 0 && sp - s < 40) s = sp + 1;
    }
    let e = Math.min(text.length, s + PIECE);
    if (e < text.length) {
      const sp = text.lastIndexOf(' ', e);
      if (sp > s + PIECE / 2) e = sp;
    }
    const piece = text.slice(s, e);
    out.push({ kind: 'message', ref: `m:${seq}:${s}:${hash8(piece)}`, seq, start: s, len: e - s, text: piece });
    if (e >= text.length) break;
  }
  return out;
}

export function toInt8(v: Float32Array): Int8Array {
  const out = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = Math.max(-127, Math.min(127, Math.round(v[i]! * 127)));
  return out;
}

export interface Progress {
  sessionsTotal: number;
  sessionsDone: number;
  pieces: number;
}

export interface CatchUpResult extends Progress {
  removed: number;
  stopped: boolean;
}

/**
 * Bring the vectors up to date. Work is saved after every session, so it can
 * be stopped (signal) and resumed later without redoing anything.
 */
export async function catchUp(
  store: Store,
  embedder: Embedder,
  home: string,
  opts: { signal?: AbortSignal; onProgress?: (p: Progress) => void } = {},
): Promise<CatchUpResult> {
  const model = embedder.key;
  const removed = store.pruneChunks(model);
  const decisions = loadDecisions(home).decisions;
  const bySession = new Map<string, typeof decisions>();
  for (const d of decisions) {
    if (!bySession.has(d.sessionId)) bySession.set(d.sessionId, []);
    bySession.get(d.sessionId)!.push(d);
  }
  const done = store.embeddedSignatures(model);
  const sigOf = (s: { title: string; updatedAt: string | null; messageCount: number; id: string }) =>
    hash8(`${s.title}|${s.updatedAt}|${s.messageCount}|${(bySession.get(s.id) ?? []).map((d) => `${d.id}:${d.text}:${d.seq}`).join(',')}`);
  const todo = store.sessionsForEmbedding().filter((s) => done.get(s.id) !== sigOf(s));
  const progress: Progress = { sessionsTotal: todo.length, sessionsDone: 0, pieces: 0 };
  opts.onProgress?.({ ...progress });

  for (const s of todo) {
    if (opts.signal?.aborted) return { ...progress, removed, stopped: true };
    const wanted: Piece[] = [];
    if (s.title.trim()) wanted.push({ kind: 'title', ref: `t:${hash8(s.title)}`, seq: null, start: null, len: null, text: s.title });
    for (const m of store.messages(s.id, { roles: ['user', 'assistant'] })) wanted.push(...piecesOf(m.seq, m.text));
    for (const d of bySession.get(s.id) ?? []) {
      wanted.push({ kind: 'decision', ref: `d:${d.id}:${hash8(d.text)}`, seq: d.seq, start: null, len: null, text: d.text });
    }
    const have = store.chunkRefs(model, s.id);
    const want = new Set(wanted.map((p) => p.ref));
    const missing = wanted.filter((p) => !have.has(p.ref));
    const stale = [...have].filter(([ref]) => !want.has(ref)).map(([, id]) => id);

    const add: ChunkRow[] = [];
    for (let i = 0; i < missing.length; i += BATCH) {
      if (opts.signal?.aborted) {
        // Keep what's finished; the session stays "not done" and resumes next time
        store.applyChunks(model, s.id, add, [], null);
        return { ...progress, removed, stopped: true };
      }
      const batch = missing.slice(i, i + BATCH);
      const vectors = await embedder.embed(
        batch.map((p) => p.text),
        'document',
      );
      batch.forEach((p, k) => add.push({ kind: p.kind, ref: p.ref, seq: p.seq, start: p.start, len: p.len, vec: toInt8(vectors[k]!) }));
      progress.pieces += batch.length;
    }
    store.applyChunks(model, s.id, add, stale, sigOf(s));
    progress.sessionsDone++;
    opts.onProgress?.({ ...progress });
  }
  return { ...progress, removed, stopped: false };
}

export interface MeaningHit {
  sessionId: string;
  score: number;
  kind: ChunkRow['kind'];
  /** user / assistant for messages; "title" or "decision" otherwise. */
  role: string;
  seq: number | null;
  /** The piece of text that matched, for display. */
  snippet: string;
}

/**
 * At most this many sessions are added by meaning alone, and only those
 * close to the best match. Models score on different scales (a small model's
 * good match can be 0.15, a large one's unrelated text 0.35), so closeness to
 * the best does most of the work; the fixed floor only drops near-noise.
 */
const MEANING_LIMIT = 12;
const MEANING_MARGIN = 0.12;
const MIN_SCORE = 0.1;

/** Vectors held in memory between searches; reloaded when the stored set changes. */
class VectorCache {
  private stamp = '';
  private chunks: StoredChunk[] = [];
  private flat = new Int8Array(0);
  private dims = 0;

  load(store: Store, model: string): { chunks: StoredChunk[]; flat: Int8Array; dims: number } {
    const stamp = store.chunkStamp(model);
    if (stamp !== this.stamp) {
      const chunks = store.loadChunks(model);
      const dims = chunks[0]?.vec.length ?? 0;
      const usable = chunks.filter((c) => c.vec.length === dims);
      const flat = new Int8Array(usable.length * dims);
      usable.forEach((c, i) => flat.set(c.vec, i * dims));
      this.chunks = usable;
      this.flat = flat;
      this.dims = dims;
      this.stamp = stamp;
    }
    return { chunks: this.chunks, flat: this.flat, dims: this.dims };
  }
}

const cache = new VectorCache();

/** Sessions whose pieces are closest in meaning to the question, best first. */
export async function searchByMeaning(
  store: Store,
  embedder: Embedder,
  query: string,
  opts: { home: string; limit?: number },
): Promise<MeaningHit[]> {
  const limit = opts.limit ?? 60;
  const q = query.trim();
  if (!q) return [];
  const { chunks, flat, dims } = cache.load(store, embedder.key);
  if (!chunks.length) return [];
  const [qv] = await embedder.embed([q], 'query');
  const qi = toInt8(qv!);
  if (qi.length !== dims) return []; // vectors from a different setup; catchUp will redo them

  const best = new Map<string, { score: number; chunk: StoredChunk }>();
  for (let n = 0; n < chunks.length; n++) {
    let dot = 0;
    const o = n * dims;
    for (let d = 0; d < dims; d++) dot += flat[o + d]! * qi[d]!;
    const score = dot / (127 * 127);
    const c = chunks[n]!;
    const prev = best.get(c.sessionId);
    if (!prev || score > prev.score) best.set(c.sessionId, { score, chunk: c });
  }
  const ranked = [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  const decisions = ranked.some((r) => r.chunk.kind === 'decision') ? loadDecisions(opts.home).decisions : [];
  return ranked.map(({ score, chunk }) => ({ sessionId: chunk.sessionId, score, kind: chunk.kind, seq: chunk.seq, ...describe(store, chunk, decisions) }));
}

/** The text of the piece that matched, and whose words they were. */
function describe(store: Store, c: StoredChunk, decisions: ReturnType<typeof loadDecisions>['decisions']): { role: string; snippet: string } {
  const clip = (t: string) => {
    const s = t.replace(/\s+/g, ' ').trim();
    return s.length > 180 ? `${s.slice(0, 179).trimEnd()}…` : s;
  };
  if (c.kind === 'title') {
    try {
      return { role: 'title', snippet: clip(store.resolve(c.sessionId).title) };
    } catch {
      return { role: 'title', snippet: '' };
    }
  }
  if (c.kind === 'decision') {
    const d = decisions.find((x) => x.sessionId === c.sessionId && x.seq === c.seq);
    return { role: 'decision', snippet: d ? clip(d.text) : '' };
  }
  const m = c.seq == null ? null : store.messageAt(c.sessionId, c.seq);
  if (!m) return { role: 'message', snippet: '' };
  const piece = c.start != null && c.len != null ? m.text.slice(c.start, c.start + c.len) : m.text;
  return { role: m.role, snippet: `${c.start ? '…' : ''}${clip(piece)}` };
}

export interface CombinedHit extends SearchHit {
  /** "words": matched words only; "meaning": matched by meaning only; "both". */
  via: 'words' | 'meaning' | 'both';
  /** Cosine similarity of the closest piece, when meaning was used. */
  meaning?: number;
}

/**
 * Merge word and meaning results with reciprocal rank fusion: each list
 * contributes 1/(60 + rank), so a session ranked high by either one comes out
 * near the top, and one ranked high by both comes out on top.
 */
export function combine(store: Store, words: SearchHit[], meaning: MeaningHit[], limit: number): CombinedHit[] {
  const K = 60;
  const top = meaning[0]?.score ?? 0;
  const relevant = meaning.filter((m) => m.score >= MIN_SCORE && m.score >= top - MEANING_MARGIN);
  const closeEnough = new Set(relevant.slice(0, MEANING_LIMIT).map((m) => m.sessionId));
  const byId = new Map(words.map((h) => [h.session.id, h]));
  const scores = new Map<string, number>();
  words.forEach((h, i) => scores.set(h.session.id, 1 / (K + i + 1)));
  // Meaning boosts sessions word search found; on its own it only adds the closest few
  const boosted = new Set<string>();
  meaning.forEach((m, i) => {
    if (!byId.has(m.sessionId) && !closeEnough.has(m.sessionId)) return;
    if (m.score < MIN_SCORE) return;
    scores.set(m.sessionId, (scores.get(m.sessionId) ?? 0) + 1 / (K + i + 1));
    boosted.add(m.sessionId);
  });
  const meaningById = new Map(meaning.map((m) => [m.sessionId, m]));
  const out: CombinedHit[] = [];
  for (const [id] of [...scores].sort((a, b) => b[1] - a[1]).slice(0, limit)) {
    const w = byId.get(id);
    const m = meaningById.get(id);
    if (w) {
      out.push({ ...w, via: boosted.has(id) ? 'both' : 'words', ...(m ? { meaning: m.score } : {}) });
      continue;
    }
    if (!m) continue;
    let session;
    try {
      session = store.resolve(id);
    } catch {
      continue;
    }
    // seq -1: nothing to jump to (the session matched through its title)
    out.push({ session, snippet: m.snippet, role: m.role, seq: m.seq ?? -1, hits: 0, via: 'meaning', meaning: m.score });
  }
  return out;
}
