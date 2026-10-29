# ContextDeck

**One local index for every AI coding agent session.** Search, organise and resume your context windows across Claude Code, Codex and more, from one place.

If you use more than one coding agent, your context is scattered: Claude Code keeps sessions per project folder, Codex keeps them per date, and neither knows the other exists. ContextDeck reads both, puts them in one searchable index on your machine, and links related work across tools.

```bash
contextdeck ui
```

![The ContextDeck canvas: sessions from Claude Code (yellow) and Codex (grey) as cards on a dotted board, grouped into workstreams like "session cookies" and "offline sync". Each card fills up to show how full its context window is.](docs/images/canvas.png)

Every session is a card on a canvas. Cards from both tools gather into **workstreams**: sessions that edited the same files or ran on the same feature branch, whichever tool they ran in. Each card **fills up like a glass** to show how full its context window is, with a line for every time it was compacted, and groups that were active in the last hour **glow**. Drag cards wherever you like and ContextDeck remembers, or **Tidy up** into a neat grid. Click one to read it: how its context grew turn by turn, what it changed, what it's related to, and how to jump back in.

![A session open in the side panel: the resume command, a large context percentage with a chart of context use over the session, and the session's details.](docs/images/reader.png)

Prefer the terminal? Everything is in the CLI too:

```console
$ contextdeck list
ID           TOOL         PROJECT    UPDATED  TURNS    CONTEXT  TITLE
cx:d5e6f701  Codex CLI    acme-shop  13h ago      1  63k (23%)  The session refresh tests fail after the cookie refactor…
cc:0f3a1b11  Claude Code  acme-shop  36h ago      2        44k  Move auth from localStorage tokens to httpOnly session cookies
cc:9e8f7c22  Claude Code  blog       3d ago       1       9.6k  Add an RSS feed for the blog posts, generated at build time.

$ contextdeck related cc:0f3a1b11
Related to cc:0f3a1b11 Move auth from localStorage tokens to httpOnly session cookies
ID           TOOL       UPDATED  WHY            TITLE
cx:d5e6f701  Codex CLI  13h ago  1 shared file  The session refresh tests fail after the cookie refactor…

$ contextdeck resume cx:d5e6f701 --run     # reopens it in Codex, in the right folder
```

> **Status: early (v0.2).** The indexer, CLI and canvas UI work today. Next up: more agents and smarter organisation, see the [roadmap](docs/ROADMAP.md). Contributions are very welcome.

## Principles

- **Local only.** Nothing leaves your machine. No accounts, no telemetry, no network calls.
- **Read only.** Your agents' session files are never modified. The index is a disposable cache; delete it any time.
- **Secrets stripped at the door.** API keys, tokens, passwords and private keys are redacted before anything is indexed.
- **Zero native dependencies.** Built on Node's built-in SQLite, so installing never involves compiling anything.
- **Provider-neutral.** Each tool is a small adapter behind one schema. Adding a new agent touches one file.

## Install

Requires **Node.js 22.13 or newer** (22.15+ to read compressed Codex sessions).

```bash
git clone https://github.com/iamkartiks/context-deck.git contextdeck
cd contextdeck
npm install
npm run build
npm link            # puts `contextdeck` on your PATH
```

Try it on a set of made-up sample sessions first, without touching your real ones:

```bash
npm run demo:ui     # about 20 sample sessions across 5 projects, opens the canvas
```

Then open your own:

```bash
contextdeck doctor  # shows which session folders were found
contextdeck ui      # indexes, then opens the canvas in your browser
```

## The canvas

`contextdeck ui` starts a small server on `127.0.0.1` (port 4977, or the next free one) and opens your browser. Leave it running: it watches your session folders, and new or changed sessions appear on the canvas as your agents work.

| | |
|---|---|
| **Move around** | Drag the background, or scroll. Pinch or ⌘/Ctrl+scroll to zoom. `+` `-` zoom, `0` shows everything. |
| **Arrange** | Drag cards anywhere; positions are saved per grouping. **Tidy up** lines everything up in a grid; **Scatter** goes back to the loose layout with your placements. |
| **Group by** | **Workstream** (linked work across tools), **Project**, **Tool** or **Day**. Threads between cards show sessions that edited the same files. |
| **Search** | Press `/`. The board narrows to matching sessions (searching their full conversations, titles, projects and branches) and zooms to fit them. |
| **Read** | Click a card: context use over the session (real per-turn data, with each compaction marked), files it changed, related sessions in other tools, subagents, and the conversation (tool calls hidden unless you ask). |
| **Resume** | **Copy command**, or on macOS **Open in Terminal**, which runs it in a new Terminal window in the right folder. |
| **List view** | Every session in rows, grouped the same way as the canvas. Handy on small screens. |

Options: `--port <n>`, `--no-open`. The page loads nothing from the internet (fonts are bundled) and only this computer can reach it; see [SECURITY.md](SECURITY.md) for how it's locked down.

Claude Code doesn't record how big its context window is, so its fill level is an **estimate** (200k tokens, or 1M once a session goes past 200k), shown as "~200k" in the side panel. Codex records the real window size.

## Commands

| Command | What it does |
|---|---|
| `ui` | Open the canvas in your browser (see above). |
| `index [--full]` | Scan session files into the index. Incremental: only changed files are re-read. |
| `list` | Recent sessions across every tool. `--all` includes subagents. |
| `search <query>` | Full-text search. Words are ANDed; `"exact phrase"`, `prefix*` and `OR` work. |
| `show <id>` | Metadata, files touched, context usage, last messages and the resume command. `--all` adds tool calls, `-m 30` shows more. |
| `resume <id> [--run]` | Print, or run, the command that reopens the session in its own tool and folder. |
| `related <id>` | Sessions in *any* tool that edited the same files (or share the branch). |
| `projects` | Your work grouped by folder, showing which tools you used where. |
| `watch` | Stay running and re-index as your agents write. |
| `stats` / `doctor` | What's indexed; what was found, what failed and why. |

Common options: `-p claude-code|codex` (or `cc|cx`), `--project <name>`, `-n <limit>`, and `--json` on every command for scripting.

**Ids.** Every session gets a short id like `cc:0f3a1b11` (Claude Code) or `cx:d5e6f701` (Codex). Anywhere an id is expected you can also paste a full id or any unique fragment of it.

## Where it looks

| Tool | Default location | Override |
|---|---|---|
| Claude Code | `~/.claude/projects/` | `--claude-dir`, `CONTEXTDECK_CLAUDE_DIR`, or Claude's own `CLAUDE_CONFIG_DIR` |
| Codex CLI | `~/.codex/sessions/` and `archived_sessions/` | `--codex-dir`, `CONTEXTDECK_CODEX_DIR`, or Codex's own `CODEX_HOME` |
| The index | `~/.contextdeck/index.db` | `--home`, `CONTEXTDECK_HOME` |
| Your canvas arrangement | `~/.contextdeck/board.json` | same folder as the index |

## How it works

```
 ~/.claude/projects/**.jsonl ─┐                      ┌─ CLI: list / search / show / resume
 ~/.codex/sessions/**.jsonl  ─┼─▶ adapters ─▶ SQLite ─┤
 (your next agent here)      ─┘   (normalise,  + FTS5 └─ local server ─▶ canvas in your browser
                                   redact)
```

Each adapter streams one session file line by line (some are hundreds of MB), maps it onto a [shared schema](src/schema.ts), and the store keeps sessions, messages, a full-text index and the files each session touched. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Both tools' file formats are **undocumented and change between versions**. Adapters read every field defensively, skip lines they can't parse, and report them in `contextdeck doctor`. If yours shows parse failures, please [open an issue](.github/ISSUE_TEMPLATE/format_change.yml).

## Use it as a library

```ts
import { loadConfig, Store, indexSources } from 'contextdeck';

const cfg = loadConfig();
const store = new Store(cfg.dbPath);
await indexSources(store, cfg.sources);
console.log(store.search('rate limit', { provider: 'codex' }));
```

## Contributing

The most useful contributions right now:

1. **New adapters**: Gemini CLI, OpenCode, Cursor, Aider, Copilot CLI. See [docs/WRITING_AN_ADAPTER.md](docs/WRITING_AN_ADAPTER.md); it's typically one file plus a fixture. A new tool shows up on the canvas automatically.
2. **Format reports**: a redacted sample of a session line we fail to parse.
3. **The canvas**: plain HTML, CSS and one JavaScript module in [`ui/`](ui), no build step. `npm run demo:ui` gives you realistic data to work against. See the roadmap for what's next.

Read [CONTRIBUTING.md](CONTRIBUTING.md) to get set up (it takes about two minutes). By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Not affiliated

ContextDeck is an independent community project. It is not affiliated with or endorsed by Anthropic or OpenAI. "Claude Code" and "Codex" are named only to describe compatibility.

## License

[MIT](LICENSE)
