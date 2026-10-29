# Architecture

ContextDeck has three layers. Data only flows one way: from the agents' files into the index, and from the index out to whoever asks.

```
 provider files (read-only)        normalise               index (cache)                consumers
 ─────────────────────────         ─────────               ─────────────                ─────────
 ~/.claude/projects/**.jsonl ──▶  claude-code adapter ─┐
                                                       ├─▶  Store (SQLite) ──▶  CLI
 ~/.codex/sessions/**.jsonl  ──▶  codex adapter ───────┘     sessions              UI server ─▶ canvas (ui/)
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

## 4. Workstreams (`Store.workstreams()`)

A workstream is work that spans sessions, often across tools. Sessions are joined (union-find) when:

- they edited the same file (resolved to an absolute path against each session's cwd), ignoring files so common they'd join everything (`package.json`, lockfiles, `README.md`…, or any file touched by more than 8 sessions), or
- they ran in the same folder on the same feature branch (`main`, `master`, `develop` and similar don't count), or
- one continued the other through a handoff (see below).

Linked groups are named after their feature branch, or else after the files that tie them together. Sessions that link to nothing are gathered per project as "loose" groups. The links are returned as `edges` (`kind: 'files'` or `'handoff'`), which the canvas draws as threads, dashed for handoffs.

## 5. Handoff (`src/handoff.ts`, `src/handoff-marker.ts`)

Continuing a session's work in a new session, in the same or another tool.

1. **`buildBrief()`** reads the session from the index and writes a markdown brief: title, marker line, where things are (folder, branch, previous tool and model, context use), the goal (first prompt), later instructions (other user prompts, newest 12, slash commands skipped), the last two replies, files changed (relative to the project), recent tool calls (pure reads and searches left out), and how to pick up. It shrinks in steps to stay under 24,000 characters. If the session was itself started from a handoff, the original goal is pulled out of its brief instead of nesting briefs.
2. **The marker**: `(ContextDeck handoff hf_<10 hex> from <provider>:<session id>)`. `finalizeBrief()` puts it back if the person deleted or changed it while editing.
3. **`saveBrief()`** writes `~/.contextdeck/handoffs/<id>.md` (directory 0700, file 0600).
4. **`startLaunch()`** describes how to start the target tool from the adapter's `startCommand()`. On macOS and Linux that's `cd <project> && <tool> "$(cat <brief file>)"`: both paths are shell-quoted, and the brief is read with `$(cat …)` inside double quotes, so its contents reach the tool as one argument and are never interpreted by the shell (there's a test for exactly that, with `$(…)` and backticks in the brief). On Windows a multi-line argument can't pass safely through cmd.exe, so the first message is a one-line pointer to the brief file, carrying the marker; a later handoff reads the original goal back from the saved brief. If the project folder no longer exists, it is left out.
5. **Linking**: when any session is saved, `Store.saveSession()` looks for a marker in its first user message and stores `handoff_id` and `handoff_from` (schema v3). `related()` reports `continued-from` / `continued-in` first, and `workstreams()` joins the two sessions.

An adapter becomes a handoff target by implementing `startCommand()` (and optionally `defaultContextWindow`). Claude Code and Codex both take an initial prompt as a positional argument (`claude "…"`, `codex "…"`).

## 6. Consumers


The CLI (`src/cli.ts`) is a thin layer over the store. Every command supports `--json`; changing its shape is a breaking change.

### The UI server (`src/server.ts`)

`contextdeck ui` indexes, then starts a `node:http` server on `127.0.0.1`. It serves the files in `ui/` from a fixed allow-list and a small JSON API:

| Route | |
|---|---|
| `GET /api/board` | All top-level sessions, workstreams, edges, subagent counts, providers, capabilities |
| `GET /api/session/:id` | One session: messages (last 600), files, context over time, related, subagents, resume command |
| `GET /api/search?q=` | Full-text search hits with snippets |
| `GET /api/events` | Server-sent events; `index` fires whenever the watcher re-indexes |
| `GET` / `PUT /api/layout` | Hand-placed card positions, stored in `board.json` (not in the index, so rebuilding the index never loses them) |
| `POST /api/reindex` | Rescan now |
| `POST /api/open-terminal` | Run a session's resume command in a new terminal window (501 when none is available) |
| `GET /api/handoff/preview?id=&to=&checkIn=` | Build a brief for a handoff, with its size and the target's window |
| `POST /api/handoff` | Save a (possibly edited) brief and return the start command; with `launch: true`, open it in a new terminal window |

Writes need the per-run token embedded in the page; see [SECURITY.md](../SECURITY.md) for the full model.

### The canvas (`ui/`)

`index.html`, `style.css` and `app.js`: no framework, no build step, no dependencies. It is one ES module with plain DOM rendering (cards are reused between renders, zones and threads are redrawn). Worth knowing before changing it:

- **Layout** is computed in the browser. Each group becomes a zone sized to its cards; zones are shelf-packed, trying many row widths and keeping the one whose shape best fits the screen. Hand-placed positions override the automatic ones, per grouping, and zones stretch around wherever their cards actually are.
- **Session text is never parsed as HTML.** Everything goes through `h()`, which creates text nodes. Search highlights come back from the server as `«…»` markers and are turned into `<mark>` elements by splitting strings.
- **Context fill** uses the real window for Codex and an estimate for Claude Code (200k, or 1M once a session has gone past 200k), shown as "~200k".
- **Context over time.** Adapters record the context size after every model turn (`contextSeries`) and where compactions happened (`compactionPoints`). The store keeps at most 120 points per session (`downsampleSeries`) in `sessions.context_series`, and `GET /api/session/:id` returns it for the chart in the side panel.
- **Design.** The look comes from the "minimal organiser" design: ground `#E4E3DF`, surface `#F7F6F2`, ink `#161616`, one accent (`#F4C95D`, Claude Code) and a warm grey (`#B7B3AA`, Codex). Tokens are CSS custom properties at the top of `style.css`; Geist and Geist Mono are bundled under `ui/fonts/` (SIL OFL). Cards stay paper-coloured in dark mode.
- Cards are positioned with the CSS `translate` property, not `transform`: individual transform properties apply before `transform`, so a tilted card positioned with `transform` would also have its position rotated.
- Browser storage holds only view preferences (view, grouping, hidden tools) and is optional.

## Why these choices

- **TypeScript + Node built-ins only**: the people most likely to contribute already have Node installed because their agents need it. Zero dependencies means zero install failures.
- **SQLite + FTS5** instead of a search server: single file, fast, transactional, and inspectable with any SQLite tool.
- **Redact at ingest** rather than at display: every future consumer (UI, export, summariser) gets safe text by default.
