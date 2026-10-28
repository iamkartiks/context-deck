import { mkdirSync, statSync } from 'node:fs';
import { basename, dirname, posix, win32 } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { adapterByPrefix, getAdapter } from './adapters/index.js';
import type { NormalizedSession, ProviderId, SessionRow } from './schema.js';

/**
 * The local index: one SQLite file (default ~/.contextdeck/index.db).
 *
 * It is a cache. Deleting it is always safe: `contextdeck index` rebuilds it
 * from the providers' own session files, which are never modified.
 */

const SCHEMA_VERSION = 1;

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

-- Full-text index; rowid = messages.id
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, tokenize = 'porter unicode61');

CREATE TABLE IF NOT EXISTS session_files (
  session_id  TEXT NOT NULL,
  path        TEXT NOT NULL,
  abs_path    TEXT NOT NULL,
  PRIMARY KEY (session_id, path)
);
CREATE INDEX IF NOT EXISTS session_files_abs ON session_files(abs_path);
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

export interface SearchHit {
  session: SessionRow;
  snippet: string;
  role: string;
  hits: number;
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
  reason: 'shared-files' | 'same-branch';
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
  };
}

export class Store {
  readonly path: string;
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.path = dbPath;
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF;');
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
    // Future migrations go here: if (current < 2) { … }
    this.db
      .prepare(`INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(String(SCHEMA_VERSION));
  }

  close(): void {
    this.db.close();
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
    this.db.prepare(`DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE session_id = ?)`).run(sessionId);
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

    this.tx(() => {
      const prev = this.fileState(path);
      if (prev?.sessionId && prev.sessionId !== id) this.deleteSessionIfOrphaned(prev.sessionId, path);
      this.deleteSessionData(id, false);

      this.db
        .prepare(
          `INSERT INTO sessions(id, provider, native_id, short_id, title, cwd, project, git_branch, model, cli_version,
             started_at, updated_at, message_count, user_turns, assistant_turns, tool_calls, tokens_in, tokens_out,
             context_tokens, context_window, compactions, parent_id, is_subagent, source_path)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, native_id = excluded.native_id,
             short_id = excluded.short_id, title = excluded.title, cwd = excluded.cwd, project = excluded.project,
             git_branch = excluded.git_branch, model = excluded.model, cli_version = excluded.cli_version,
             started_at = excluded.started_at, updated_at = excluded.updated_at,
             message_count = excluded.message_count, user_turns = excluded.user_turns,
             assistant_turns = excluded.assistant_turns, tool_calls = excluded.tool_calls,
             tokens_in = excluded.tokens_in, tokens_out = excluded.tokens_out,
             context_tokens = excluded.context_tokens, context_window = excluded.context_window,
             compactions = excluded.compactions, parent_id = excluded.parent_id,
             is_subagent = excluded.is_subagent, source_path = excluded.source_path`,
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
          parentId,
          s.isSubagent ? 1 : 0,
          path,
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
    // SQLite returns the bare columns (role, snip) from the row that produced MIN(score).
    const sql = `
      WITH matches AS MATERIALIZED (
        SELECT m.session_id, m.role, snippet(messages_fts, 0, '«', '»', '…', 14) AS snip,
               bm25(messages_fts) AS score
        FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
        WHERE messages_fts MATCH ?
      ),
      best AS (
        SELECT session_id, role, snip, MIN(score) AS best, COUNT(*) AS hits
        FROM matches GROUP BY session_id
      )
      SELECT s.*, best.snip, best.role AS hit_role, best.hits, best.best
      FROM best JOIN sessions s ON s.id = best.session_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY best.best LIMIT ?`;
    try {
      return (this.db.prepare(sql).all(...params) as Row[]).map((r) => ({
        session: toSessionRow(r),
        snippet: String(r.snip ?? '').replace(/\s+/g, ' '),
        role: String(r.hit_role),
        hits: Number(r.hits),
      }));
    } catch (err) {
      if (/fts5|syntax/i.test(String(err))) throw new Error(`Invalid search query: ${query}`);
      throw err;
    }
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
    const out: RelatedRow[] = rows.map((r) => ({
      session: toSessionRow(r),
      sharedFiles: String(r.shared ?? '')
        .split(',')
        .filter(Boolean),
      reason: 'shared-files',
    }));
    if (out.length < limit) {
      const self = this.db.prepare(`SELECT cwd, git_branch FROM sessions WHERE id = ?`).get(sessionId) as Row | undefined;
      if (self?.cwd && self.git_branch) {
        const seen = new Set([sessionId, ...out.map((o) => o.session.id)]);
        const more = this.db
          .prepare(
            `SELECT * FROM sessions WHERE cwd = ? AND git_branch = ? AND is_subagent = 0
             ORDER BY updated_at DESC LIMIT ?`,
          )
          .all(self.cwd, self.git_branch, limit + seen.size) as Row[];
        for (const r of more) {
          if (out.length >= limit) break;
          if (seen.has(String(r.id))) continue;
          out.push({ session: toSessionRow(r), sharedFiles: [], reason: 'same-branch' });
        }
      }
    }
    return out;
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
}
