# Architecture

ContextDeck has three layers. Data only flows one way: from the agents' files into the index, and from the index out to whoever asks.

```
 provider files (read-only)        normalise               index (cache)                consumers
 ─────────────────────────         ─────────               ─────────────                ─────────
 ~/.claude/projects/**.jsonl ──▶  claude-code adapter ─┐
                                                       ├─▶  Store (SQLite) ──▶  CLI (today)
 ~/.codex/sessions/**.jsonl  ──▶  codex adapter ───────┘     sessions              UI (next)
                                     │                       messages + FTS5       library users
                                     └── redact + truncate   session_files
```

## 1. Adapters (`src/adapters/`)

An adapter knows one tool's on-disk format and nothing else. It implements the contract in [`types.ts`](../src/adapters/types.ts):

- `defaultRoot()`: where the tool keeps sessions on this machine.
- `discover(root)`: every session file under that root.
- `parse(file)`: stream the file and return a `NormalizedSession` (see [`schema.ts`](../src/schema.ts)).
- `resumeCommand(session)`: the shell command that reopens it.

Rules every adapter follows:

- **Stream, never slurp.** Codex rollouts over 700 MB exist in the wild. Use `readJsonl()`.
- **Never throw on bad data.** Malformed lines are counted (`badLines`) and skipped. Unknown line types are ignored.
- **Everything through `clean()`**, which redacts secrets and caps length (8k chars per message, 2k per tool call) so the index stays small.
- **Keep only conversation.** Injected system context, thinking blocks and tool-result bodies beyond the cap are left out, because they bloat search with noise.

## 2. The store (`src/store.ts`)

One SQLite file, opened with Node's built-in `node:sqlite` (no native build step). Tables:

| Table | Holds |
|---|---|
| `files` | Every session file seen: size, mtime, which session it produced, parse errors. Drives incremental indexing. |
| `sessions` | One row per session, with the counters from the schema. `id` is `<provider>:<nativeId>`. |
| `messages` | The cleaned text of each message, in order. |
| `messages_fts` | FTS5 index over `messages.text` (rowid = `messages.id`), Porter-stemmed. |
| `session_files` | Files each session edited, plus an absolute path resolved against the session's cwd. Powers `related`. |

Re-indexing one file deletes and re-inserts that session's rows inside a transaction, so readers never see half a session.

The index is a cache. Its schema is versioned in `meta.schema_version`; when it changes, add a migration in `Store.migrate()`, or bump the version and let users rebuild.

## 3. Indexer (`src/indexer.ts`)

`indexSources()` walks each adapter's files and re-parses only those whose size or mtime changed. Files that vanished are pruned, **unless the whole source root is missing** (an unmounted drive shouldn't erase history).

`watchSources()` uses recursive `fs.watch` with a debounce, falling back to polling where recursive watching isn't available. It just calls the same incremental indexer.

### Known limits (good first issues)

- A changed file is re-parsed from the start. Both formats are append-only, so resuming from the last byte offset would make huge live sessions much cheaper.
- `project` is the folder name of the cwd. Resolving the git root would group subfolders of one repo together.
- Session titles aren't in the full-text index yet; only messages are.

## 4. Consumers

The CLI (`src/cli.ts`) is a thin layer over the store. Every command supports `--json`, and that output is the contract the UI will build on. Changing its shape is a breaking change.

## Why these choices

- **TypeScript + Node built-ins only**: the people most likely to contribute already have Node installed because their agents need it. Zero dependencies means zero install failures.
- **SQLite + FTS5** instead of a search server: single file, fast, transactional, and inspectable with any SQLite tool.
- **Redact at ingest** rather than at display: every future consumer (UI, export, summariser) gets safe text by default.
