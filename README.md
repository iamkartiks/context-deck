# ContextDeck

**One local index for every AI coding agent session.** Search, organise and resume your context windows across Claude Code, Codex and more, from one place.

If you use more than one coding agent, your context is scattered: Claude Code keeps sessions per project folder, Codex keeps them per date, and neither knows the other exists. ContextDeck reads both, puts them in one searchable index on your machine, and links related work across tools.

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

> **Status: early (v0.1).** The indexer and CLI work today. The visual canvas UI is the next milestone, see the [roadmap](docs/ROADMAP.md). Contributions are very welcome.

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

Try it on the bundled sample sessions first, without touching your real ones:

```bash
npm run demo
```

Then index your own:

```bash
contextdeck doctor  # shows which session folders were found
contextdeck index   # first run takes a few seconds; later runs only read changed files
contextdeck list
```

## Commands

| Command | What it does |
|---|---|
| `index [--full]` | Scan session files into the index. Incremental: only changed files are re-read. |
| `list` | Recent sessions across every tool. `--all` includes subagents. |
| `search <query>` | Full-text search. Words are ANDed; `"exact phrase"`, `prefix*` and `OR` work. |
| `show <id>` | Metadata, files touched, context usage, last messages and the resume command. `--all` adds tool calls, `-m 30` shows more. |
| `resume <id> [--run]` | Print, or run, the command that reopens the session in its own tool and folder. |
| `related <id>` | Sessions in *any* tool that edited the same files (or share the branch). |
| `projects` | Your work grouped by folder, showing which tools you used where. |
| `watch` | Stay running and re-index as your agents write. |
| `stats` / `doctor` | What's indexed; what was found, what failed and why. |

Common options: `-p claude-code|codex` (or `cc|cx`), `--project <name>`, `-n <limit>`, and `--json` on every command for scripting. The JSON shape is what the upcoming UI consumes, so treat it as an API.

**Ids.** Every session gets a short id like `cc:0f3a1b11` (Claude Code) or `cx:d5e6f701` (Codex). Anywhere an id is expected you can also paste a full id or any unique fragment of it.

## Where it looks

| Tool | Default location | Override |
|---|---|---|
| Claude Code | `~/.claude/projects/` | `--claude-dir`, `CONTEXTDECK_CLAUDE_DIR`, or Claude's own `CLAUDE_CONFIG_DIR` |
| Codex CLI | `~/.codex/sessions/` and `archived_sessions/` | `--codex-dir`, `CONTEXTDECK_CODEX_DIR`, or Codex's own `CODEX_HOME` |
| The index | `~/.contextdeck/index.db` | `--home`, `CONTEXTDECK_HOME` |

## How it works

```
 ~/.claude/projects/**.jsonl ─┐                      ┌─ list / search / show
 ~/.codex/sessions/**.jsonl  ─┼─▶ adapters ─▶ SQLite ─┼─ related / projects
 (your next agent here)      ─┘   (normalise,  + FTS5 └─ resume ─▶ claude / codex
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

1. **New adapters**: Gemini CLI, OpenCode, Cursor, Aider, Copilot CLI. See [docs/WRITING_AN_ADAPTER.md](docs/WRITING_AN_ADAPTER.md); it's typically one file plus a fixture.
2. **Format reports**: a redacted sample of a session line we fail to parse.
3. **The UI**: see the roadmap.

Read [CONTRIBUTING.md](CONTRIBUTING.md) to get set up (it takes about two minutes). By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Not affiliated

ContextDeck is an independent community project. It is not affiliated with or endorsed by Anthropic or OpenAI. "Claude Code" and "Codex" are named only to describe compatibility.

## License

[MIT](LICENSE)
