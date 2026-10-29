import { mkdirSync, statSync } from 'node:fs';
import { basename, dirname, posix, win32 } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { adapterByPrefix, getAdapter } from './adapters/index.js';
import { parseHandoffMarker } from './handoff-marker.js';
import type { ContextSeries, NormalizedSession, ProviderId, SessionRow } from './schema.js';

/**
 * The local index: one SQLite file (default ~/.contextdeck/index.db).
 *
 * It is a cache. Deleting it is always safe: `contextdeck index` rebuilds it
 * from the providers' own session files, which are never modified.
 */

const SCHEMA_VERSION = 4;
const PAGE_SIZE = 16384;

/** Longest context series kept per session; longer ones are downsampled. */
const MAX_SERIES_POINTS = 120;

/**
 * Downsample a context series to at most `max` points, keeping each bucket's
 * last value (the context size at the end of that stretch) and moving
 * compaction markers to the bucket they fall in.
 */
export function downsampleSeries(points: number[], compactions: number[], max = MAX_SERIES_POINTS): ContextSeries {
  const clamp = (i: number, n: number) => Math.max(0, Math.min(n, i));
  if (points.length <= max) {
    return { points: [...points], compactions: compactions.map((c) => clamp(c, points.length)) };
  }
  const step = points.length / max;
  const out: number[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.min(points.length - 1, Math.floor((i + 1) * step) - 1)]!);
  const marks = compactions.map((c) => clamp(Math.floor(c / step), max));
  return { points: out, compactions: [...new Set(marks)] };
}

const FTS_TABLE = `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, content = 'messages', content_rowid = 'id', tokenize = 'porter unicode61'
);`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS files (
  path        TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  size        INTEGER NOT NULL,
  mtime_ms    INTEGER NOT NULL,
  session_id  TEXT,
  bad_lines   INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  indexed_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  provider        TEXT NOT NULL,
  native_id       TEXT NOT NULL,
  short_id        TEXT NOT NULL,
  title           TEXT NOT NULL,
  cwd             TEXT,
  project         TEXT,
  git_branch      TEXT,
  model           TEXT,
  cli_version     TEXT,
  started_at      TEXT,
  updated_at      TEXT,
  message_count   INTEGER NOT NULL,
  user_turns      INTEGER NOT NULL,
  assistant_turns INTEGER NOT NULL,
  tool_calls      INTEGER NOT NULL,
  tokens_in       INTEGER NOT NULL,
  tokens_out      INTEGER NOT NULL,
  context_tokens  INTEGER,
  context_window  INTEGER,
  compactions     INTEGER NOT NULL,
  context_series  TEXT,
  handoff_id      TEXT,
  handoff_from    TEXT,
  parent_id       TEXT,
  is_subagent     INTEGER NOT NULL,
  source_path     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS sessions_cwd ON sessions(cwd);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY,
  session_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  role        TEXT NOT NULL,
  ts          TEXT,
  tool_name   TEXT,
  text        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, seq);

-- Full-text index over messages.text. "External content": the index points at
-- the messages table instead of keeping a second copy of every message.
${FTS_TABLE}

CREATE TABLE IF NOT EXISTS session_files (
  session_id  TEXT NOT NULL,
  path        TEXT NOT NULL,
  abs_path    TEXT NOT NULL,
  PRIMARY KEY (session_id, path)
);
CREATE INDEX IF NOT EXISTS session_files_abs ON session_files(abs_path);

-- Search by meaning (only filled when it's turned on). One row per piece of
-- text that was turned into a vector: a slice of a message (seq, start, len
-- point into messages.text, so the text isn't stored twice), a session title,
-- or a decision. Vectors are int8, length 1 (dot product = cosine).
CREATE TABLE IF NOT EXISTS chunks (
  id          INTEGER PRIMARY KEY,
  model       TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  ref         TEXT NOT NULL,
  seq         INTEGER,
  start       INTEGER,
  len         INTEGER,
  vec         BLOB NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS chunks_ref ON chunks(model, session_id, ref);
-- What each session looked like when it was last embedded, to skip unchanged ones
CREATE TABLE IF NOT EXISTS embedded_sessions (
  model       TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  sig         TEXT NOT NULL,
  PRIMARY KEY (model, session_id)
);
`;

export interface FileState {
  path: string;
  provider: string;
  size: number;
  mtimeMs: number;
  sessionId: string | null;
}

export interface ListFilter {
  provider?: string;
  project?: string;
  includeSubagents?: boolean;
  limit?: number;
}

/** A piece of text and its vector, for search by meaning. */
export interface ChunkRow {
  kind: 'message' | 'title' | 'decision';
  ref: string;
  seq: number | null;
  start: number | null;
  len: number | null;
  vec: Int8Array;
}

export interface StoredChunk extends Omit<ChunkRow, 'ref'> {
  id: number;
  sessionId: string;
}

export interface SearchHit {
  session: SessionRow;
  snippet: string;
  role: string;
  /** Position of the best-matching message, to open the session right there. */
  seq: number;
  hits: number;
}

/** One message in a session that matches a search. */
export interface SessionMatch {
  seq: number;
  role: string;
  snippet: string;
}

export interface ProjectRow {
  cwd: string;
  project: string;
  sessions: number;
  providers: string[];
  lastActive: string | null;
  tokens: number;
}

export interface RelatedRow {
  session: SessionRow;
  sharedFiles: string[];
  reason: 'shared-files' | 'same-branch' | 'continued-from' | 'continued-in';
}

export interface StoredMessage {
  seq: number;
  role: string;
  ts: string | null;
  toolName: string | null;
  text: string;
}

export function shortIdFor(provider: ProviderId, nativeId: string): string {
  const prefix = getAdapter(provider)?.shortPrefix ?? provider.slice(0, 2);
  const tail = nativeId.replace(/[^A-Za-z0-9]/g, '').slice(-8).toLowerCase();
  return `${prefix}:${tail}`;
}

/** Turn free text into a safe FTS5 query. Words are ANDed; "quoted phrases" and prefix* work. */
export function toFtsQuery(input: string): string {
  const tokens = input.match(/"[^"]*"|\S+/g) ?? [];
  const parts: string[] = [];
  for (const raw of tokens) {
    if (raw === 'OR' || raw === 'AND' || raw === 'NOT') {
      parts.push(raw);
      continue;
    }
    const prefix = raw.endsWith('*') && raw.length > 1;
    const body = raw.replace(/^"|"$/g, '').replace(/\*$/, '').replace(/"/g, '""').trim();
    if (!body) continue;
    parts.push(`"${body}"${prefix ? '*' : ''}`);
  }
  // A dangling operator is a syntax error in FTS5
  while (parts.length && ['OR', 'AND', 'NOT'].includes(parts[parts.length - 1]!)) parts.pop();
  while (parts.length && ['OR', 'AND', 'NOT'].includes(parts[0]!)) parts.shift();
  return parts.join(' ');
}

/**
 * Resolve a file path from a session against the session's cwd, using the
 * path style of the machine that recorded it (not the one running contextdeck),
 * so a macOS session indexed on Windows still links up.
 */
export function absoluteIn(cwd: string | null, file: string): string {
  if (!cwd) return file;
  const style = /^[A-Za-z]:[\\/]|^\\\\/.test(cwd) ? win32 : posix;
  return style.isAbsolute(file) ? style.normalize(file) : style.resolve(cwd, file);
}

type Row = Record<string, SQLInputValue>;

function toSessionRow(r: Row): SessionRow {
  return {
    id: String(r.id),
    provider: String(r.provider),
    nativeId: String(r.native_id),
    shortId: String(r.short_id),
    title: String(r.title),
    cwd: (r.cwd as string | null) ?? null,
    project: (r.project as string | null) ?? null,
    gitBranch: (r.git_branch as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    cliVersion: (r.cli_version as string | null) ?? null,
    startedAt: (r.started_at as string | null) ?? null,
    updatedAt: (r.updated_at as string | null) ?? null,
    messageCount: Number(r.message_count),
    userTurns: Number(r.user_turns),
    assistantTurns: Number(r.assistant_turns),
    toolCalls: Number(r.tool_calls),
    tokensIn: Number(r.tokens_in),
    tokensOut: Number(r.tokens_out),
    contextTokens: r.context_tokens == null ? null : Number(r.context_tokens),
    contextWindow: r.context_window == null ? null : Number(r.context_window),
    compactions: Number(r.compactions),
    parentId: (r.parent_id as string | null) ?? null,
    isSubagent: Number(r.is_subagent) === 1,
    sourcePath: String(r.source_path),
    handoffId: (r.handoff_id as string | null) ?? null,
    handoffFrom: (r.handoff_from as string | null) ?? null,
  };
}

export class Store {
  readonly path: string;
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.path = dbPath;
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // page_size and auto_vacuum only take effect on a new, empty file (or
    // after VACUUM), so they come first. 16 KB pages fit several multi-KB
    // messages each; with 4 KB pages most of each page was left empty.
    // journal_size_limit stops the write-ahead log staying at its largest size.
    this.db.exec(
      `PRAGMA page_size = ${PAGE_SIZE}; PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL; PRAGMA journal_size_limit = 4194304; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF;`,
    );
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(SCHEMA);
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as Row | undefined;
    const current = row ? Number(row.value) : 0;
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `Index at ${this.path} was created by a newer contextdeck (schema ${current}). Upgrade, or delete the file to rebuild.`,
      );
    }
    if (current > 0 && current < SCHEMA_VERSION) {
      // v2 added the context-over-time series, v3 the handoff link, v4 the
      // smaller search index and incremental vacuum. The index is a cache, so
      // the simplest correct upgrade is to fix up the tables, empty them, and
      // re-read every file.
      const cols = new Set((this.db.prepare(`PRAGMA table_info(sessions)`).all() as Row[]).map((c) => String(c.name)));
      for (const col of ['context_series', 'handoff_id', 'handoff_from']) {
        if (!cols.has(col)) this.db.exec(`ALTER TABLE sessions ADD COLUMN ${col} TEXT`);
      }
      this.db.exec(`DROP TABLE IF EXISTS messages_fts`);
      this.db.exec(FTS_TABLE);
      this.db.exec(`DELETE FROM messages; DELETE FROM session_files; DELETE FROM sessions; DELETE FROM files;`);
      // Rewrite the file with the new page size and incremental vacuum, handing
      // the old space back. The page size can't change while in WAL mode.
      this.db.exec(
        `PRAGMA journal_mode = DELETE; PRAGMA page_size = ${PAGE_SIZE}; PRAGMA auto_vacuum = INCREMENTAL; VACUUM; PRAGMA journal_mode = WAL;`,
      );
    }
    // Created after the upgrade above so the column exists on older indexes
    this.db.exec(`CREATE INDEX IF NOT EXISTS sessions_handoff ON sessions(handoff_from)`);
    this.db
      .prepare(`INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(String(SCHEMA_VERSION));
  }

  close(): void {
    this.db.close();
  }

  /**
   * Hand unused space back to the disk. Cheap to call: it only does work when
   * a meaningful share of the file is free (e.g. after sessions were removed).
   */
  reclaim(): { freedBytes: number } {
    const n = (sql: string) => Number(Object.values(this.db.prepare(sql).get() as Row)[0] ?? 0);
    // Fold the write-ahead log into the main file first, so free pages are counted
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const pageSize = n('PRAGMA page_size');
    const free = n('PRAGMA freelist_count');
    const total = n('PRAGMA page_count');
    if (free < 64 || free < total * 0.1) return { freedBytes: 0 };
    this.db.exec('PRAGMA incremental_vacuum');
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return { freedBytes: (free - n('PRAGMA freelist_count')) * pageSize };
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ── files ──────────────────────────────────────────────────────────────

  fileState(path: string): FileState | null {
    const r = this.db.prepare(`SELECT * FROM files WHERE path = ?`).get(path) as Row | undefined;
    if (!r) return null;
    return {
      path: String(r.path),
      provider: String(r.provider),
      size: Number(r.size),
      mtimeMs: Number(r.mtime_ms),
      sessionId: (r.session_id as string | null) ?? null,
    };
  }

  knownFiles(provider: string): string[] {
    return (this.db.prepare(`SELECT path FROM files WHERE provider = ?`).all(provider) as Row[]).map((r) => String(r.path));
  }

  /** Record a file that produced no session (empty, snapshots only, or failed). */
  recordFile(path: string, provider: string, size: number, mtimeMs: number, badLines: number, error: string | null): void {
    this.tx(() => {
      const prev = this.fileState(path);
      if (prev?.sessionId) this.deleteSessionIfOrphaned(prev.sessionId, path);
      this.upsertFile(path, provider, size, mtimeMs, null, badLines, error);
    });
  }

  private upsertFile(
    path: string,
    provider: string,
    size: number,
    mtimeMs: number,
    sessionId: string | null,
    badLines: number,
    error: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO files(path, provider, size, mtime_ms, session_id, bad_lines, error, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET provider = excluded.provider, size = excluded.size,
           mtime_ms = excluded.mtime_ms, session_id = excluded.session_id, bad_lines = excluded.bad_lines,
           error = excluded.error, indexed_at = excluded.indexed_at`,
      )
      .run(path, provider, size, Math.trunc(mtimeMs), sessionId, badLines, error, new Date().toISOString());
  }

  removeFile(path: string): void {
    this.tx(() => {
      const prev = this.fileState(path);
      this.db.prepare(`DELETE FROM files WHERE path = ?`).run(path);
      if (prev?.sessionId) this.deleteSessionIfOrphaned(prev.sessionId, path);
    });
  }

  private deleteSessionIfOrphaned(sessionId: string, exceptPath: string): void {
    const other = this.db
      .prepare(`SELECT 1 FROM files WHERE session_id = ? AND path != ? LIMIT 1`)
      .get(sessionId, exceptPath);
    if (!other) this.deleteSessionData(sessionId, true);
  }

  private deleteSessionData(sessionId: string, includeRow: boolean): void {
    // External-content FTS5 needs the old text to remove a row from the index,
    // so this must run before the messages themselves are deleted.
    this.db
      .prepare(`INSERT INTO messages_fts(messages_fts, rowid, text) SELECT 'delete', id, text FROM messages WHERE session_id = ?`)
      .run(sessionId);
    this.db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sessionId);
    this.db.prepare(`DELETE FROM session_files WHERE session_id = ?`).run(sessionId);
    if (includeRow) this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
  }

  // ── sessions ───────────────────────────────────────────────────────────

  /** Replace everything stored for one session file with a freshly parsed session. */
  saveSession(path: string, size: number, mtimeMs: number, badLines: number, s: NormalizedSession): string {
    const id = `${s.provider}:${s.nativeId}`;
    const parentId = s.parentNativeId ? `${s.provider}:${s.parentNativeId}` : null;
    const project = s.cwd ? basename(s.cwd) || s.cwd : null;
    // A session started from a ContextDeck handoff carries a marker in its first prompt
    const firstPrompt = s.messages.find((m) => m.role === 'user');
    const handoff = firstPrompt ? parseHandoffMarker(firstPrompt.text) : null;

    this.tx(() => {
      const prev = this.fileState(path);
      if (prev?.sessionId && prev.sessionId !== id) this.deleteSessionIfOrphaned(prev.sessionId, path);
      this.deleteSessionData(id, false);

      this.db
        .prepare(
          `INSERT INTO sessions(id, provider, native_id, short_id, title, cwd, project, git_branch, model, cli_version,
             started_at, updated_at, message_count, user_turns, assistant_turns, tool_calls, tokens_in, tokens_out,
             context_tokens, context_window, compactions, context_series, parent_id, is_subagent, source_path,
             handoff_id, handoff_from)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, native_id = excluded.native_id,
             short_id = excluded.short_id, title = excluded.title, cwd = excluded.cwd, project = excluded.project,
             git_branch = excluded.git_branch, model = excluded.model, cli_version = excluded.cli_version,
             started_at = excluded.started_at, updated_at = excluded.updated_at,
             message_count = excluded.message_count, user_turns = excluded.user_turns,
             assistant_turns = excluded.assistant_turns, tool_calls = excluded.tool_calls,
             tokens_in = excluded.tokens_in, tokens_out = excluded.tokens_out,
             context_tokens = excluded.context_tokens, context_window = excluded.context_window,
             compactions = excluded.compactions, context_series = excluded.context_series, parent_id = excluded.parent_id,
             is_subagent = excluded.is_subagent, source_path = excluded.source_path,
             handoff_id = excluded.handoff_id, handoff_from = excluded.handoff_from`,
        )
        .run(
          id,
          s.provider,
          s.nativeId,
          shortIdFor(s.provider, s.nativeId),
          s.title,
          s.cwd,
          project,
          s.gitBranch,
          s.model,
          s.cliVersion,
          s.startedAt,
          s.updatedAt,
          s.messages.length,
          s.userTurns,
          s.assistantTurns,
          s.toolCalls,
          s.tokensIn,
          s.tokensOut,
          s.contextTokens,
          s.contextWindow,
          s.compactions,
          s.contextSeries.length ? JSON.stringify(downsampleSeries(s.contextSeries, s.compactionPoints)) : null,
          parentId,
          s.isSubagent ? 1 : 0,
          path,
          handoff?.id ?? null,
          handoff && handoff.from !== id ? handoff.from : null,
        );

      const insMsg = this.db.prepare(
        `INSERT INTO messages(session_id, seq, role, ts, tool_name, text) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const insFts = this.db.prepare(`INSERT INTO messages_fts(rowid, text) VALUES (?, ?)`);
      for (const m of s.messages) {
        const res = insMsg.run(id, m.seq, m.role, m.ts, m.toolName ?? null, m.text);
        insFts.run(Number(res.lastInsertRowid), m.text);
      }

      const insFile = this.db.prepare(
        `INSERT OR IGNORE INTO session_files(session_id, path, abs_path) VALUES (?, ?, ?)`,
      );
      for (const f of s.filesTouched) insFile.run(id, f, absoluteIn(s.cwd, f));

      this.upsertFile(path, s.provider, size, mtimeMs, id, badLines, null);
    });
    return id;
  }

  listSessions(filter: ListFilter = {}): SessionRow[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.provider) {
      where.push('provider = ?');
      params.push(adapterByPrefix(filter.provider)?.id ?? filter.provider);
    }
    if (filter.project) {
      where.push('(project = ? OR cwd = ?)');
      params.push(filter.project, filter.project);
    }
    if (!filter.includeSubagents) where.push('is_subagent = 0');
    const sql = `SELECT * FROM sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY updated_at DESC NULLS LAST LIMIT ?`;
    params.push(filter.limit ?? 50);
    return (this.db.prepare(sql).all(...params) as Row[]).map(toSessionRow);
  }

  /**
   * Find one session by full id ("codex:019d…"), short id ("cx:1a2b3c4d"),
   * or any unique fragment of the native id.
   */
  resolve(ref: string): SessionRow {
    const trimmed = ref.trim();
    if (!trimmed) throw new Error('Empty session id.');
    const hasPrefix = trimmed.includes(':') && !!adapterByPrefix(trimmed.split(':')[0]!);
    const fragment = hasPrefix ? trimmed.split(':').slice(1).join(':') : trimmed;
    const provider = hasPrefix ? adapterByPrefix(trimmed.split(':')[0]!)!.id : null;
    const esc = (s: string) => s.replace(/[%_\\]/g, (ch) => '\\' + ch);
    const scope = provider ? `AND provider = ?` : '';
    const scoped = (...p: SQLInputValue[]) => (provider ? [...p, provider] : p);

    // Most specific first: exact id → short-id tail → native-id prefix → anywhere in native id.
    const stages: [string, SQLInputValue[]][] = [
      [`SELECT * FROM sessions WHERE id = ? OR short_id = ?`, [trimmed, trimmed]],
      [`SELECT * FROM sessions WHERE short_id LIKE ? ESCAPE '\\' ${scope}`, scoped(`%:${esc(fragment.toLowerCase())}`)],
      [`SELECT * FROM sessions WHERE native_id LIKE ? ESCAPE '\\' ${scope}`, scoped(`${esc(fragment)}%`)],
      [`SELECT * FROM sessions WHERE native_id LIKE ? ESCAPE '\\' ${scope}`, scoped(`%${esc(fragment)}%`)],
    ];
    for (const [sql, params] of stages) {
      const rows = this.db.prepare(`${sql} ORDER BY is_subagent, updated_at DESC LIMIT 10`).all(...params) as Row[];
      if (rows.length === 0) continue;
      if (rows.length === 1) return toSessionRow(rows[0]!);
      // A parent and its own subagents share an id fragment; the parent wins.
      const parents = rows.filter((r) => Number(r.is_subagent) === 0);
      if (parents.length === 1 && rows.every((r) => Number(r.is_subagent) === 0 || r.parent_id === parents[0]!.id)) {
        return toSessionRow(parents[0]!);
      }
      const list = rows.map((r) => `  ${r.short_id}  ${r.title}`).join('\n');
      throw new Error(`"${ref}" matches more than one session:\n${list}\nUse a longer id.`);
    }
    throw new Error(`No session matches "${ref}".`);
  }

  messages(sessionId: string, opts: { last?: number; roles?: string[] } = {}): StoredMessage[] {
    const roles = opts.roles?.length ? opts.roles : null;
    const roleSql = roles ? `AND role IN (${roles.map(() => '?').join(',')})` : '';
    const params: SQLInputValue[] = [sessionId, ...(roles ?? [])];
    let sql = `SELECT seq, role, ts, tool_name, text FROM messages WHERE session_id = ? ${roleSql} ORDER BY seq`;
    if (opts.last) {
      sql = `SELECT * FROM (SELECT seq, role, ts, tool_name, text FROM messages WHERE session_id = ? ${roleSql}
             ORDER BY seq DESC LIMIT ?) ORDER BY seq`;
      params.push(opts.last);
    }
    return (this.db.prepare(sql).all(...params) as Row[]).map((r) => ({
      seq: Number(r.seq),
      role: String(r.role),
      ts: (r.ts as string | null) ?? null,
      toolName: (r.tool_name as string | null) ?? null,
      text: String(r.text),
    }));
  }

  /** Context size over the session, or null if the tool didn't record token usage. */
  contextSeries(sessionId: string): ContextSeries | null {
    const r = this.db.prepare(`SELECT context_series FROM sessions WHERE id = ?`).get(sessionId) as Row | undefined;
    if (!r?.context_series) return null;
    try {
      const v = JSON.parse(String(r.context_series)) as ContextSeries;
      return Array.isArray(v.points) && Array.isArray(v.compactions) ? v : null;
    } catch {
      return null;
    }
  }

  filesTouched(sessionId: string): string[] {
    return (this.db.prepare(`SELECT path FROM session_files WHERE session_id = ? ORDER BY path`).all(sessionId) as Row[]).map(
      (r) => String(r.path),
    );
  }

  search(query: string, filter: ListFilter & { raw?: boolean } = {}): SearchHit[] {
    const fts = filter.raw ? query : toFtsQuery(query);
    if (!fts) return [];
    const where: string[] = [];
    const params: SQLInputValue[] = [fts];
    if (filter.provider) {
      where.push('s.provider = ?');
      params.push(adapterByPrefix(filter.provider)?.id ?? filter.provider);
    }
    if (filter.project) {
      where.push('(s.project = ? OR s.cwd = ?)');
      params.push(filter.project, filter.project);
    }
    params.push(filter.limit ?? 20);
    // FTS auxiliary functions (bm25, snippet) can't run inside an aggregate, so rank every
    // matching message first (materialized), then keep the best-ranked one per session.
    // bm25 is negative (lower is better); halving it for tool output means a match in
    // the conversation is shown ahead of a file path or command that happens to match.
    // SQLite returns the bare columns (role, snip) from the row that produced MIN(score).
    const sql = `
      WITH matches AS MATERIALIZED (
        SELECT m.session_id, m.role, m.seq, snippet(messages_fts, 0, '«', '»', '…', 14) AS snip,
               bm25(messages_fts) * (CASE WHEN m.role = 'tool' THEN 0.5 ELSE 1.0 END) AS score
        FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
        WHERE messages_fts MATCH ?
      ),
      best AS (
        SELECT session_id, role, seq, snip, MIN(score) AS best, COUNT(*) AS hits
        FROM matches GROUP BY session_id
      )
      SELECT s.*, best.snip, best.role AS hit_role, best.seq AS hit_seq, best.hits, best.best
      FROM best JOIN sessions s ON s.id = best.session_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY best.best LIMIT ?`;
    try {
      return (this.db.prepare(sql).all(...params) as Row[]).map((r) => ({
        session: toSessionRow(r),
        snippet: String(r.snip ?? '').replace(/\s+/g, ' '),
        role: String(r.hit_role),
        seq: Number(r.hit_seq),
        hits: Number(r.hits),
      }));
    } catch (err) {
      if (/fts5|syntax/i.test(String(err))) throw new Error(`Invalid search query: ${query}`);
      throw err;
    }
  }

  /** Every message in one session that matches a search, in conversation order. */
  matchesIn(sessionId: string, query: string, limit = 1000): SessionMatch[] {
    const fts = toFtsQuery(query);
    if (!fts) return [];
    try {
      return (
        this.db
          .prepare(
            `SELECT m.seq, m.role, snippet(messages_fts, 0, '«', '»', '…', 14) AS snip
             FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
             WHERE messages_fts MATCH ? AND m.session_id = ?
             ORDER BY m.seq LIMIT ?`,
          )
          .all(fts, sessionId, limit) as Row[]
      ).map((r) => ({ seq: Number(r.seq), role: String(r.role), snippet: String(r.snip ?? '').replace(/\s+/g, ' ') }));
    } catch (err) {
      if (/fts5|syntax/i.test(String(err))) throw new Error(`Invalid search query: ${query}`);
      throw err;
    }
  }

  // ── Search by meaning: storage ────────────────────────────────────────────

  /** Sessions to embed, most recently active first. */
  sessionsForEmbedding(): { id: string; title: string; updatedAt: string | null; messageCount: number }[] {
    return (this.db.prepare(`SELECT id, title, updated_at, message_count FROM sessions ORDER BY updated_at DESC`).all() as Row[]).map((r) => ({
      id: String(r.id),
      title: String(r.title),
      updatedAt: (r.updated_at as string | null) ?? null,
      messageCount: Number(r.message_count),
    }));
  }

  embeddedSignatures(model: string): Map<string, string> {
    const rows = this.db.prepare(`SELECT session_id, sig FROM embedded_sessions WHERE model = ?`).all(model) as Row[];
    return new Map(rows.map((r) => [String(r.session_id), String(r.sig)]));
  }

  chunkRefs(model: string, sessionId: string): Map<string, number> {
    const rows = this.db.prepare(`SELECT id, ref FROM chunks WHERE model = ? AND session_id = ?`).all(model, sessionId) as Row[];
    return new Map(rows.map((r) => [String(r.ref), Number(r.id)]));
  }

  /** Add and remove one session's pieces, and record what it looked like, in one step. */
  applyChunks(model: string, sessionId: string, add: ChunkRow[], removeIds: number[], sig: string | null): void {
    this.tx(() => {
      const del = this.db.prepare(`DELETE FROM chunks WHERE id = ?`);
      for (const id of removeIds) del.run(id);
      const ins = this.db.prepare(
        `INSERT OR REPLACE INTO chunks (model, session_id, kind, ref, seq, start, len, vec) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const c of add) {
        ins.run(model, sessionId, c.kind, c.ref, c.seq, c.start, c.len, new Uint8Array(c.vec.buffer, c.vec.byteOffset, c.vec.byteLength));
      }
      if (sig != null) {
        this.db
          .prepare(`INSERT INTO embedded_sessions (model, session_id, sig) VALUES (?, ?, ?) ON CONFLICT(model, session_id) DO UPDATE SET sig = excluded.sig`)
          .run(model, sessionId, sig);
      }
    });
  }

  /** Drop vectors from other models and for sessions that are gone. */
  pruneChunks(model: string): number {
    let removed = 0;
    this.tx(() => {
      removed += Number(this.db.prepare(`DELETE FROM chunks WHERE model != ? OR session_id NOT IN (SELECT id FROM sessions)`).run(model).changes);
      this.db.prepare(`DELETE FROM embedded_sessions WHERE model != ? OR session_id NOT IN (SELECT id FROM sessions)`).run(model);
    });
    return removed;
  }

  dropChunks(): void {
    this.db.exec(`DELETE FROM chunks; DELETE FROM embedded_sessions;`);
  }

  /** Changes whenever vectors are added or removed, to know when a cached copy is stale. */
  chunkStamp(model: string): string {
    const r = this.db.prepare(`SELECT COUNT(*) AS n, MAX(id) AS m FROM chunks WHERE model = ?`).get(model) as Row;
    return `${r.n}:${r.m ?? 0}`;
  }

  chunkStats(model: string): { pieces: number; sessions: number; bytes: number } {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT session_id) AS s, COALESCE(SUM(LENGTH(vec)), 0) AS b FROM chunks WHERE model = ?`)
      .get(model) as Row;
    return { pieces: Number(r.n), sessions: Number(r.s), bytes: Number(r.b) };
  }

  loadChunks(model: string): StoredChunk[] {
    return (this.db.prepare(`SELECT id, session_id, kind, seq, start, len, vec FROM chunks WHERE model = ?`).all(model) as Row[]).map((r) => {
      const b = r.vec as Uint8Array;
      return {
        id: Number(r.id),
        sessionId: String(r.session_id),
        kind: String(r.kind) as ChunkRow['kind'],
        seq: r.seq == null ? null : Number(r.seq),
        start: r.start == null ? null : Number(r.start),
        len: r.len == null ? null : Number(r.len),
        vec: new Int8Array(b.buffer, b.byteOffset, b.byteLength),
      };
    });
  }

  /** One message by its position in the session. */
  messageAt(sessionId: string, seq: number): StoredMessage | null {
    const r = this.db.prepare(`SELECT seq, role, ts, tool_name, text FROM messages WHERE session_id = ? AND seq = ?`).get(sessionId, seq) as
      | Row
      | undefined;
    return r ? { seq: Number(r.seq), role: String(r.role), ts: (r.ts as string | null) ?? null, toolName: (r.tool_name as string | null) ?? null, text: String(r.text) } : null;
  }

  /** Sessions grouped by working directory, across every provider. */
  projects(limit = 50): ProjectRow[] {
    const rows = this.db
      .prepare(
        `SELECT cwd, project, COUNT(*) AS n, GROUP_CONCAT(DISTINCT provider) AS providers,
                MAX(updated_at) AS last, SUM(tokens_in + tokens_out) AS tokens
         FROM sessions WHERE cwd IS NOT NULL AND is_subagent = 0
         GROUP BY cwd ORDER BY last DESC LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map((r) => ({
      cwd: String(r.cwd),
      project: String(r.project ?? r.cwd),
      sessions: Number(r.n),
      providers: String(r.providers ?? '')
        .split(',')
        .filter(Boolean)
        .sort(),
      lastActive: (r.last as string | null) ?? null,
      tokens: Number(r.tokens ?? 0),
    }));
  }

  /**
   * Sessions in any tool that touched the same files as this one — the seed of
   * cross-tool "workstreams". Falls back to same directory + branch.
   */
  related(sessionId: string, limit = 10): RelatedRow[] {
    const rows = this.db
      .prepare(
        `SELECT s.*, GROUP_CONCAT(DISTINCT b.path) AS shared, COUNT(DISTINCT b.abs_path) AS n
         FROM session_files a
         JOIN session_files b ON b.abs_path = a.abs_path AND b.session_id != a.session_id
         JOIN sessions s ON s.id = b.session_id
         WHERE a.session_id = ?
         GROUP BY s.id ORDER BY n DESC, s.updated_at DESC LIMIT ?`,
      )
      .all(sessionId, limit) as Row[];
    // Handoffs first: the session this one continued, and sessions that continued it
    const out: RelatedRow[] = [];
    const self = this.db.prepare(`SELECT handoff_from FROM sessions WHERE id = ?`).get(sessionId) as Row | undefined;
    if (self?.handoff_from) {
      const from = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(String(self.handoff_from)) as Row | undefined;
      if (from) out.push({ session: toSessionRow(from), sharedFiles: [], reason: 'continued-from' });
    }
    for (const r of this.db
      .prepare(`SELECT * FROM sessions WHERE handoff_from = ? ORDER BY started_at`)
      .all(sessionId) as Row[]) {
      out.push({ session: toSessionRow(r), sharedFiles: [], reason: 'continued-in' });
    }
    for (const r of rows) {
      const shared = String(r.shared ?? '')
        .split(',')
        .filter(Boolean);
      const existing = out.find((o) => o.session.id === String(r.id));
      if (existing) existing.sharedFiles = shared;
      else out.push({ session: toSessionRow(r), sharedFiles: shared, reason: 'shared-files' });
    }
    if (out.length < limit) {
      const me = this.db.prepare(`SELECT cwd, git_branch FROM sessions WHERE id = ?`).get(sessionId) as Row | undefined;
      if (me?.cwd && me.git_branch) {
        const seen = new Set([sessionId, ...out.map((o) => o.session.id)]);
        const more = this.db
          .prepare(
            `SELECT * FROM sessions WHERE cwd = ? AND git_branch = ? AND is_subagent = 0
             ORDER BY updated_at DESC LIMIT ?`,
          )
          .all(me.cwd, me.git_branch, limit + seen.size) as Row[];
        for (const r of more) {
          if (out.length >= limit) break;
          if (seen.has(String(r.id))) continue;
          out.push({ session: toSessionRow(r), sharedFiles: [], reason: 'same-branch' });
        }
      }
    }
    return out.slice(0, limit);
  }

  stats(): {
    sessions: number;
    subagents: number;
    messages: number;
    files: number;
    filesWithErrors: number;
    badLines: number;
    byProvider: { provider: string; sessions: number; tokens: number; lastActive: string | null }[];
    dbBytes: number;
  } {
    const one = (sql: string) => Number((this.db.prepare(sql).get() as Row).n ?? 0);
    const byProvider = (
      this.db
        .prepare(
          `SELECT provider, COUNT(*) AS n, SUM(tokens_in + tokens_out) AS t, MAX(updated_at) AS last
           FROM sessions GROUP BY provider ORDER BY n DESC`,
        )
        .all() as Row[]
    ).map((r) => ({
      provider: String(r.provider),
      sessions: Number(r.n),
      tokens: Number(r.t ?? 0),
      lastActive: (r.last as string | null) ?? null,
    }));
    let dbBytes = 0;
    try {
      dbBytes = statSync(this.path).size;
    } catch {
      /* in-memory */
    }
    return {
      sessions: one(`SELECT COUNT(*) AS n FROM sessions WHERE is_subagent = 0`),
      subagents: one(`SELECT COUNT(*) AS n FROM sessions WHERE is_subagent = 1`),
      messages: one(`SELECT COUNT(*) AS n FROM messages`),
      files: one(`SELECT COUNT(*) AS n FROM files`),
      filesWithErrors: one(`SELECT COUNT(*) AS n FROM files WHERE error IS NOT NULL`),
      badLines: one(`SELECT COALESCE(SUM(bad_lines), 0) AS n FROM files`),
      byProvider,
      dbBytes,
    };
  }

  fileErrors(limit = 20): { path: string; error: string }[] {
    return (
      this.db.prepare(`SELECT path, error FROM files WHERE error IS NOT NULL ORDER BY indexed_at DESC LIMIT ?`).all(limit) as Row[]
    ).map((r) => ({ path: String(r.path), error: String(r.error) }));
  }

  /** Subagent sessions of one parent, newest first. */
  subagents(parentId: string): SessionRow[] {
    return (
      this.db.prepare(`SELECT * FROM sessions WHERE parent_id = ? ORDER BY updated_at DESC`).all(parentId) as Row[]
    ).map(toSessionRow);
  }

  /** Number of subagent sessions per parent id. */
  subagentCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    const rows = this.db
      .prepare(`SELECT parent_id, COUNT(*) AS n FROM sessions WHERE is_subagent = 1 AND parent_id IS NOT NULL GROUP BY parent_id`)
      .all() as Row[];
    for (const r of rows) out[String(r.parent_id)] = Number(r.n);
    return out;
  }

  /**
   * Group top-level sessions into workstreams: pieces of work that span sessions
   * and tools. Two sessions belong together when they edited the same file, or
   * ran in the same folder on the same feature branch. Sessions that link to
   * nothing are gathered per project as "loose" groups.
   */
  workstreams(): WorkstreamGraph {
    const sessions = (this.db.prepare(`SELECT * FROM sessions WHERE is_subagent = 0`).all() as Row[]).map(toSessionRow);
    const byId = new Map(sessions.map((s) => [s.id, s]));

    // Union-find over session ids
    const parent = new Map<string, string>(sessions.map((s) => [s.id, s.id]));
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      while (parent.get(x) !== r) {
        const next = parent.get(x)!;
        parent.set(x, r);
        x = next;
      }
      return r;
    };
    const union = (a: string, b: string) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };

    // 1. Shared files. Files touched by many sessions (lockfiles, package.json…) link everything, so skip them.
    const fileRows = this.db
      .prepare(
        `SELECT sf.abs_path, sf.path, sf.session_id FROM session_files sf
         JOIN sessions s ON s.id = sf.session_id WHERE s.is_subagent = 0`,
      )
      .all() as Row[];
    const sessionsByFile = new Map<string, { path: string; ids: Set<string> }>();
    for (const r of fileRows) {
      const abs = String(r.abs_path);
      const entry = sessionsByFile.get(abs) ?? { path: String(r.path), ids: new Set<string>() };
      entry.ids.add(String(r.session_id));
      sessionsByFile.set(abs, entry);
    }
    const pairFiles = new Map<string, Set<string>>();
    for (const [abs, { ids }] of sessionsByFile) {
      if (ids.size < 2 || ids.size > MAX_SESSIONS_PER_SHARED_FILE) continue;
      if (UBIQUITOUS_FILES.has(basename(abs.replace(/\\/g, '/')))) continue;
      const list = [...ids].sort();
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          union(list[i]!, list[j]!);
          const key = `${list[i]}\n${list[j]}`;
          const set = pairFiles.get(key) ?? new Set<string>();
          set.add(abs);
          pairFiles.set(key, set);
        }
      }
    }

    // 2. Handoffs: a session continued in another tool is the same piece of work
    const handoffPairs: [string, string][] = [];
    for (const s of sessions) {
      if (s.handoffFrom && byId.has(s.handoffFrom)) {
        union(s.handoffFrom, s.id);
        handoffPairs.push([s.handoffFrom, s.id]);
      }
    }

    // 3. Same folder + same feature branch
    const byBranch = new Map<string, string[]>();
    for (const s of sessions) {
      if (!s.cwd || !s.gitBranch || TRUNK_BRANCHES.has(s.gitBranch)) continue;
      const key = `${s.cwd}\n${s.gitBranch}`;
      byBranch.set(key, [...(byBranch.get(key) ?? []), s.id]);
    }
    for (const ids of byBranch.values()) for (let i = 1; i < ids.length; i++) union(ids[0]!, ids[i]!);

    // Collect components
    const components = new Map<string, SessionRow[]>();
    for (const s of sessions) {
      const root = find(s.id);
      components.set(root, [...(components.get(root) ?? []), s]);
    }

    const workstreams: Workstream[] = [];
    const loose = new Map<string, SessionRow[]>();
    for (const members of components.values()) {
      if (members.length === 1) {
        const s = members[0]!;
        const key = s.cwd ?? '';
        loose.set(key, [...(loose.get(key) ?? []), s]);
        continue;
      }
      members.sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
      const first = members[0]!;
      const branches = new Set(members.map((m) => m.gitBranch));
      const branch = branches.size === 1 ? first.gitBranch : null;
      let label: string;
      if (branch && !TRUNK_BRANCHES.has(branch)) {
        label = humanizeBranch(branch);
      } else {
        // Name it after the files that tie it together, most shared first
        const ids = new Set(members.map((m) => m.id));
        const counts = new Map<string, number>();
        for (const [key, files] of pairFiles) {
          const [a, b] = key.split('\n') as [string, string];
          if (!ids.has(a) || !ids.has(b)) continue;
          for (const f of files) counts.set(f, (counts.get(f) ?? 0) + 1);
        }
        const names = [...counts.entries()]
          .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
          .map(([abs]) => basename(abs.replace(/\\/g, '/')));
        const unique = [...new Set(names)].slice(0, 2);
        label = unique.length ? unique.join(' and ') : first.title;
      }
      workstreams.push({
        id: `ws:${first.id}`,
        kind: 'linked',
        label,
        project: first.project,
        cwd: first.cwd,
        branch,
        providers: [...new Set(members.map((m) => m.provider))].sort(),
        sessionIds: members.map((m) => m.id),
        updatedAt: maxIso(members.map((m) => m.updatedAt)),
      });
    }
    for (const [cwd, members] of loose) {
      members.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
      const project = members[0]!.project;
      workstreams.push({
        id: `loose:${cwd}`,
        kind: 'loose',
        label: project ?? 'No project',
        project,
        cwd: cwd || null,
        branch: null,
        providers: [...new Set(members.map((m) => m.provider))].sort(),
        sessionIds: members.map((m) => m.id),
        updatedAt: maxIso(members.map((m) => m.updatedAt)),
      });
    }
    workstreams.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));

    const edges: WorkstreamEdge[] = [];
    for (const [key, files] of pairFiles) {
      const [a, b] = key.split('\n') as [string, string];
      if (!byId.has(a) || !byId.has(b)) continue;
      edges.push({
        a,
        b,
        kind: 'files',
        files: [...files].map((abs) => sessionsByFile.get(abs)?.path ?? abs).sort(),
      });
    }
    for (const [a, b] of handoffPairs) edges.push({ a, b, kind: 'handoff', files: [] });

    const sessionWorkstream: Record<string, string> = {};
    for (const w of workstreams) for (const id of w.sessionIds) sessionWorkstream[id] = w.id;
    return { workstreams, edges, sessionWorkstream };
  }
}

/** A file shared by more sessions than this is too common to signal shared work. */
const MAX_SESSIONS_PER_SHARED_FILE = 8;
const UBIQUITOUS_FILES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'Cargo.lock',
  'Cargo.toml',
  'go.mod',
  'go.sum',
  'poetry.lock',
  'requirements.txt',
  'pyproject.toml',
  'README.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  'AGENTS.md',
  '.gitignore',
  'tsconfig.json',
  '.env.example',
]);
const TRUNK_BRANCHES = new Set(['main', 'master', 'develop', 'dev', 'trunk', 'HEAD']);

function humanizeBranch(branch: string): string {
  const last = branch.split('/').filter(Boolean).pop() ?? branch;
  return last.replace(/[-_]+/g, ' ').trim() || branch;
}

function maxIso(values: (string | null)[]): string | null {
  let best: string | null = null;
  for (const v of values) if (v && (!best || v > best)) best = v;
  return best;
}

export interface Workstream {
  id: string;
  /** "linked": sessions joined by shared files or a feature branch. "loose": unlinked sessions of one project. */
  kind: 'linked' | 'loose';
  label: string;
  project: string | null;
  cwd: string | null;
  branch: string | null;
  providers: string[];
  sessionIds: string[];
  updatedAt: string | null;
}

export interface WorkstreamEdge {
  /** For handoff edges, `a` is the session handed off and `b` the one that continued it. */
  a: string;
  b: string;
  kind: 'files' | 'handoff';
  /** Files both sessions edited, as written in the sessions. */
  files: string[];
}

export interface WorkstreamGraph {
  workstreams: Workstream[];
  edges: WorkstreamEdge[];
  sessionWorkstream: Record<string, string>;
}
