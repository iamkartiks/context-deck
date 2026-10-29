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

## Phase 3: the canvas UI ✅ (v0.2)

A local web app (`contextdeck ui`) served on `127.0.0.1`.

- [x] Canvas: every session is a card, dragged anywhere and remembered; grouped by workstream, project, tool or day
- [x] Context health on every card: the card fills up as its window fills, with a line per compaction
- [x] List view, live updates from watch mode, search that lights up matching cards
- [x] Session reader: files changed, related sessions across tools, subagents, conversation with tool calls collapsed
- [x] Resume: copy the command, or open it in Terminal (macOS)

Still to do here:

- [ ] Pinch-to-zoom on touch screens (zoom buttons work today)
- [ ] Open in other terminals: iTerm2, Ghostty, Warp, Windows Terminal, GNOME Terminal
- [ ] Your own named groups: drag cards into a group you made, alongside the automatic ones
- [ ] Notes and pins on cards
- [ ] Keyboard navigation between cards (arrow keys)
- [ ] A Timeline grouping that lays days out left to right

## Phase 4: organisation that thinks

- [x] **Workstreams**: sessions linked across tools by shared files and feature branch (v0.2)
- [ ] Use time too: sessions within an hour of each other in the same folder probably belong together
- [ ] Local embeddings (e.g. `sqlite-vec`) for "find sessions like this one" and automatic clustering
- [ ] Auto titles and tags from a small local model, opt-in
- [ ] Duplicate and stale detection: "you've asked about this migration in 4 sessions across 2 tools"

## Phase 5: context handoff

- [ ] "Continue in another tool": build a compact brief from a session (goal, decisions, files changed, open todos) and start a new session in a different agent with it
- [ ] Hooks for live status ("waiting for you", "done") from tools that support them

## Non-goals

- Cloud sync or hosted accounts. If it ever happens, it's opt-in and a separate project.
- Running or orchestrating agents. Other tools do that well; ContextDeck organises what they leave behind and gets you back into it.
