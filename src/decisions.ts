import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionRow } from './schema.js';
import type { Store } from './store.js';

/**
 * Decisions: messages you pinned because they settled something ("use
 * Postgres", "keep the old header for one release").
 *
 * Like your canvas layout, these are things you made, so they live in their
 * own file (~/.contextdeck/decisions.json), never in index.db: rebuilding the
 * index can't lose them, and nothing is written to the agents' folders.
 *
 * Each decision points at a message by session id and position (seq), and
 * also remembers a fingerprint of that message's text. If a re-index shifts
 * positions, the message is found again by its fingerprint; if it's gone, the
 * decision is kept and shown with the words you saved.
 *
 * Decisions can go stale. ContextDeck can't tell whether one still holds, but
 * it can tell two things that matter: a newer decision you said replaces it,
 * and later edits to the files its session worked on, made by sessions that
 * never saw the decision. The second is a prompt to check, not a verdict, and
 * "Still true" clears it until the files change again.
 */

export interface Decision {
  id: string;
  sessionId: string;
  seq: number;
  /** The decision in your words (or the part of the message you selected). */
  text: string;
  /** sha256 of the pinned message's text, to find it again if positions shift. */
  messageHash: string;
  createdAt: string;
  updatedAt: string;
  /** The newer decision that replaces this one. Replaced decisions stay, but leave briefs. */
  replacedBy?: string;
  /** When you last said it still holds after its files changed. */
  checkedAt?: string;
}

export interface DecisionFile {
  version: 1;
  decisions: Decision[];
}

/** A file a decision covers that changed after it was made (or last checked). */
export interface DecisionChange {
  /** Absolute path. */
  path: string;
  /** Sessions that edited it since, newest first. */
  sessions: { id: string; editedAt: string }[];
}

/** A decision with where it lives now, for the UI, CLI and briefs. */
export interface ResolvedDecision extends Decision {
  /** False when the message can't be found any more (the decision is still shown). */
  anchored: boolean;
  session: SessionRow | null;
  /** When it was decided: the message's time if known, else when you marked it. */
  decidedAt: string;
  /** Files it covers that changed since, in sessions that didn't have it. Empty when replaced. */
  changes: DecisionChange[];
}

export const MAX_DECISION_CHARS = 2_000;
const MAX_DECISIONS = 5_000;
const ID_RE = /^d_[0-9a-f]{10}$/;

export const decisionsPath = (home: string) => join(home, 'decisions.json');

export function hashMessage(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

export function newDecisionId(): string {
  return `d_${randomBytes(5).toString('hex')}`;
}

export function isDecisionId(id: string): boolean {
  return ID_RE.test(id);
}

/** Tidy the text a person wrote: trim, collapse runs of blank lines, cap the length. */
export function cleanDecisionText(text: string): string {
  const t = text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > MAX_DECISION_CHARS ? `${t.slice(0, MAX_DECISION_CHARS - 1).trimEnd()}…` : t;
}

/** Validate untrusted file contents. Bad entries are dropped, never thrown. */
export function sanitizeDecisions(input: unknown): DecisionFile {
  const out: DecisionFile = { version: 1, decisions: [] };
  const list = (input as { decisions?: unknown } | null)?.decisions;
  if (!Array.isArray(list)) return out;
  const seen = new Set<string>();
  for (const d of list) {
    if (out.decisions.length >= MAX_DECISIONS) break;
    if (!d || typeof d !== 'object') continue;
    const { id, sessionId, seq, text, messageHash, createdAt, updatedAt, replacedBy, checkedAt } = d as Record<string, unknown>;
    if (typeof id !== 'string' || !ID_RE.test(id) || seen.has(id)) continue;
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 512) continue;
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) continue;
    if (typeof text !== 'string' || !text.trim()) continue;
    if (typeof messageHash !== 'string' || !/^[0-9a-f]{32}$/.test(messageHash)) continue;
    const created = typeof createdAt === 'string' && !Number.isNaN(Date.parse(createdAt)) ? createdAt : new Date(0).toISOString();
    seen.add(id);
    out.decisions.push({
      id,
      sessionId,
      seq,
      text: cleanDecisionText(text),
      messageHash,
      createdAt: created,
      updatedAt: typeof updatedAt === 'string' && !Number.isNaN(Date.parse(updatedAt)) ? updatedAt : created,
      ...(typeof replacedBy === 'string' && ID_RE.test(replacedBy) && replacedBy !== id ? { replacedBy } : {}),
      ...(typeof checkedAt === 'string' && !Number.isNaN(Date.parse(checkedAt)) ? { checkedAt } : {}),
    });
  }
  // A replacement must exist; otherwise the old decision is current again
  const ids = new Set(out.decisions.map((d) => d.id));
  for (const d of out.decisions) if (d.replacedBy && !ids.has(d.replacedBy)) delete d.replacedBy;
  return out;
}

export function loadDecisions(home: string): DecisionFile {
  try {
    return sanitizeDecisions(JSON.parse(readFileSync(decisionsPath(home), 'utf8')));
  } catch {
    return { version: 1, decisions: [] };
  }
}

/** Write atomically, readable only by you (decisions quote your sessions). */
export function saveDecisions(home: string, file: DecisionFile): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = decisionsPath(home);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 1), { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* not supported everywhere (Windows) */
  }
}

/**
 * Add a decision on one message. With `replaces`, the new decision takes the
 * place of an earlier one. Throws with a readable message on bad input.
 */
export function addDecision(home: string, store: Store, input: { sessionId: string; seq: number; text: string; replaces?: string | null }): Decision {
  const session = store.resolve(input.sessionId);
  if (!Number.isInteger(input.seq) || input.seq < 0) throw new Error('Invalid message position.');
  const message = store.messageAt(session.id, input.seq);
  if (!message) throw new Error('That message is not in this session.');
  const text = cleanDecisionText(input.text);
  if (!text) throw new Error('Write the decision first.');
  const file = loadDecisions(home);
  if (file.decisions.length >= MAX_DECISIONS) throw new Error(`You already have ${MAX_DECISIONS} decisions.`);
  const old = input.replaces ? file.decisions.find((x) => x.id === input.replaces) : null;
  if (input.replaces && !old) throw new Error('The decision it replaces no longer exists.');
  if (old?.replacedBy) throw new Error('That decision was already replaced.');
  const now = new Date().toISOString();
  const decision: Decision = {
    id: newDecisionId(),
    sessionId: session.id,
    seq: message.seq,
    text,
    messageHash: hashMessage(message.text),
    createdAt: now,
    updatedAt: now,
  };
  file.decisions.push(decision);
  if (old) {
    old.replacedBy = decision.id;
    old.updatedAt = now;
  }
  saveDecisions(home, file);
  return decision;
}

/** Say a decision still holds: its "files changed" prompt clears until they change again. */
export function confirmDecision(home: string, id: string): Decision {
  const file = loadDecisions(home);
  const d = file.decisions.find((x) => x.id === id);
  if (!d) throw new Error('No such decision.');
  d.checkedAt = new Date().toISOString();
  saveDecisions(home, file);
  return d;
}

/** Undo a replacement: the decision is current again. */
export function restoreDecision(home: string, id: string): Decision {
  const file = loadDecisions(home);
  const d = file.decisions.find((x) => x.id === id);
  if (!d) throw new Error('No such decision.');
  delete d.replacedBy;
  d.updatedAt = new Date().toISOString();
  saveDecisions(home, file);
  return d;
}

export function updateDecision(home: string, id: string, text: string): Decision {
  const file = loadDecisions(home);
  const d = file.decisions.find((x) => x.id === id);
  if (!d) throw new Error('No such decision.');
  const clean = cleanDecisionText(text);
  if (!clean) throw new Error('Write the decision first.');
  d.text = clean;
  d.updatedAt = new Date().toISOString();
  saveDecisions(home, file);
  return d;
}

export function deleteDecision(home: string, id: string): boolean {
  const file = loadDecisions(home);
  const before = file.decisions.length;
  file.decisions = file.decisions.filter((x) => x.id !== id);
  if (file.decisions.length === before) return false;
  // What it replaced is current again
  for (const d of file.decisions) if (d.replacedBy === id) delete d.replacedBy;
  saveDecisions(home, file);
  return true;
}

/**
 * Attach each decision to its session and message as they are now. A message
 * that moved is found again by its fingerprint. Newest first.
 */
export function resolveDecisions(store: Store, decisions: Decision[]): ResolvedDecision[] {
  const sessions = new Map<string, SessionRow | null>();
  const hashes = new Map<string, Map<string, number>>(); // sessionId → message hash → seq
  const sessionOf = (id: string) => {
    if (!sessions.has(id)) {
      let s: SessionRow | null = null;
      try {
        s = store.resolve(id);
      } catch {
        s = null;
      }
      sessions.set(id, s);
    }
    return sessions.get(id)!;
  };
  const changesFor = changeFinder(store);
  const out = decisions.map((d): ResolvedDecision => {
    const session = sessionOf(d.sessionId);
    if (!session) return { ...d, anchored: false, session: null, decidedAt: d.createdAt, changes: [] };
    const at = store.messageAt(session.id, d.seq);
    let anchored: { seq: number; ts: string | null } | null = null;
    if (at && hashMessage(at.text) === d.messageHash) anchored = { seq: at.seq, ts: at.ts };
    else {
      let index = hashes.get(session.id);
      if (!index) {
        index = new Map();
        for (const m of store.messages(session.id)) if (!index.has(hashMessage(m.text))) index.set(hashMessage(m.text), m.seq);
        hashes.set(session.id, index);
      }
      const moved = index.get(d.messageHash);
      if (moved != null) anchored = { seq: moved, ts: store.messageAt(session.id, moved)?.ts ?? null };
    }
    const decidedAt = anchored?.ts && !Number.isNaN(Date.parse(anchored.ts)) ? anchored.ts : d.createdAt;
    const base = { ...d, seq: anchored?.seq ?? d.seq, anchored: !!anchored, session, decidedAt };
    return { ...base, changes: d.replacedBy ? [] : changesFor(session.id, laterOf(decidedAt, d.checkedAt)) };
  });
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const laterOf = (a: string, b: string | undefined) => (b && Date.parse(b) > Date.parse(a) ? b : a);

/** Most files and sessions to report per decision: enough to act on, not a log. */
const MAX_CHANGED_FILES = 5;
const MAX_CHANGED_SESSIONS = 3;

/**
 * Finds the files a decision covers (what its session edited) that were
 * edited after `since` by sessions outside its handoff family. Caches per
 * session, since one session often carries several decisions.
 */
function changeFinder(store: Store): (sessionId: string, since: string) => DecisionChange[] {
  const cache = new Map<string, { family: Set<string>; edits: ReturnType<Store['editsTo']> }>();
  return (sessionId, since) => {
    let c = cache.get(sessionId);
    if (!c) {
      const files = store.editedFiles(sessionId);
      c = { family: store.handoffFamily(sessionId), edits: store.editsTo(files) };
      cache.set(sessionId, c);
    }
    const after = Date.parse(since);
    const byPath = new Map<string, { id: string; editedAt: string }[]>();
    for (const e of c.edits) {
      if (c.family.has(e.sessionId) || !(Date.parse(e.editedAt) > after)) continue;
      if (!byPath.has(e.absPath)) byPath.set(e.absPath, []);
      byPath.get(e.absPath)!.push({ id: e.sessionId, editedAt: e.editedAt });
    }
    return [...byPath]
      .map(([path, sessions]) => ({ path, sessions: sessions.sort((a, b) => Date.parse(b.editedAt) - Date.parse(a.editedAt)).slice(0, MAX_CHANGED_SESSIONS) }))
      .sort((a, b) => Date.parse(b.sessions[0]!.editedAt) - Date.parse(a.sessions[0]!.editedAt))
      .slice(0, MAX_CHANGED_FILES);
  };
}

/** Simple, forgiving match for decision text: every word must appear (any case). */
export function decisionMatches(d: ResolvedDecision, query: string): boolean {
  const words = query
    .toLowerCase()
    .replace(/["*]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !['and', 'or', 'not'].includes(w));
  if (!words.length) return false;
  const hay = `${d.text} ${d.session?.title ?? ''}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/**
 * Decisions for a session and the sessions it continued from (oldest first),
 * for handoff briefs. Replaced ones are swapped for their replacements.
 */
export function decisionsForChain(store: Store, home: string, sessionId: string, maxDepth = 10): ResolvedDecision[] {
  const chain: string[] = [];
  let id: string | null = sessionId;
  while (id && chain.length <= maxDepth && !chain.includes(id)) {
    chain.push(id);
    try {
      id = store.resolve(id).handoffFrom;
    } catch {
      id = null;
    }
  }
  const file = loadDecisions(home).decisions;
  const byId = new Map(file.map((d) => [d.id, d]));
  // A replaced decision gives way to whatever replaced it last, wherever that was decided
  const current = new Map<string, Decision>();
  for (const d of file) {
    if (!chain.includes(d.sessionId)) continue;
    let latest = d;
    for (let hops = 0; latest.replacedBy && byId.has(latest.replacedBy) && hops < 50; hops++) latest = byId.get(latest.replacedBy)!;
    current.set(latest.id, latest);
  }
  return resolveDecisions(store, [...current.values()]).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
