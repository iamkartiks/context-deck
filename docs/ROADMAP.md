# Roadmap

ContextDeck grows in phases. Each phase is useful on its own, and everything stays local.

## Phase 1: the index ✅ (v0.1)

Claude Code + Codex adapters, unified schema, SQLite + full-text search, incremental indexing, watch mode, secret redaction, CLI with `--json`.

## Phase 2: more agents and a sturdier index

- [ ] Adapters: **Gemini CLI**, **OpenCode**, **Cursor** (SQLite store), **Aider**, **GitHub Copilot CLI**
- [ ] Resume parsing from the last byte offset for append-only files (cheap re-index of huge live sessions)
- [ ] Resolve git roots so subfolders of one repo group together
- [ ] Put session titles in the full-text index
- [ ] `contextdeck export <id> --md` (redacted Markdown, for sharing or pasting into another agent)
- [ ] Configurable extra redaction patterns

## Phase 3: the canvas UI

A local web app (`contextdeck ui`) served on `127.0.0.1`, built on the `--json` API.

- [ ] Timeline and list views with live updates from watch mode
- [ ] Session reader with tool calls collapsed
- [ ] **Canvas**: each session is a card; cards from any tool cluster by what they were about, not where they came from. Drag to regroup.
- [ ] Context-health badges: how full each window is, how often it compacted
- [ ] One-click resume (opens the right terminal in the right folder)

## Phase 4: organisation that thinks

- [ ] **Workstreams**: link sessions across tools by shared files, branch and time (the `related` command is the seed)
- [ ] Local embeddings (e.g. `sqlite-vec`) for "find sessions like this one" and automatic clustering
- [ ] Auto titles and tags from a small local model, opt-in
- [ ] Duplicate and stale detection: "you've asked about this migration in 4 sessions across 2 tools"

## Phase 5: context handoff

- [ ] "Continue in another tool": build a compact brief from a session (goal, decisions, files changed, open todos) and start a new session in a different agent with it
- [ ] Hooks for live status ("waiting for you", "done") from tools that support them

## Non-goals

- Cloud sync or hosted accounts. If it ever happens, it's opt-in and a separate project.
- Running or orchestrating agents. Other tools do that well; ContextDeck organises what they leave behind and gets you back into it.
