# Roadmap

ContextDeck grows in phases. Each phase is useful on its own, and everything stays local.

## Phase 1: the index ✅ (v0.1)

Claude Code + Codex adapters, unified schema, SQLite + full-text search, incremental indexing, watch mode, secret redaction, CLI with `--json`.

## Phase 2: more agents and a sturdier index

- [x] **Qwen Code** adapter (v0.6): Qwen and any OpenAI-compatible model, local or hosted (DeepSeek, …)
- [ ] Adapters: **Gemini CLI**, **OpenCode**, **Aider**, **Goose**, **Cline / Roo** (VS Code), **Cursor** (SQLite store), **GitHub Copilot CLI**
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
- [x] Resume: copy the command, or open it in a terminal (macOS, Linux, Windows)

Still to do here:

- [ ] Pinch-to-zoom on touch screens (zoom buttons work today)
- [ ] Open in other terminals: iTerm2, Ghostty, Warp, Windows Terminal, GNOME Terminal
- [ ] Your own named groups: drag cards into a group you made, alongside the automatic ones
- [x] Decisions: mark the message that settled something; shown on cards, in their own view, in search and in handoff briefs (v0.7)
- [x] Search shows where it matched, and the side panel steps through every match (v0.7)
- [ ] Notes on cards
- [ ] Keyboard navigation between cards (arrow keys)
- [ ] A Timeline grouping that lays days out left to right

## Phase 4: organisation that thinks

- [x] **Workstreams**: sessions linked across tools by shared files and feature branch (v0.2)
- [ ] Use time too: sessions within an hour of each other in the same folder probably belong together
- [ ] Local embeddings (e.g. `sqlite-vec`) for "find sessions like this one" and automatic clustering
- [ ] Auto titles and tags from a small local model, opt-in
- [ ] Duplicate and stale detection: "you've asked about this migration in 4 sessions across 2 tools"

## Phase 5: context handoff

- [x] "Continue in another tool": a brief built from the session (goal, instructions, where it got to, files, commands), editable before launch, starts a new session in the other tool and is linked back to the original (v0.4)
- [x] "Fresh session" in the same tool when a window is nearly full (v0.4)
- [ ] Optional AI-written brief: ask the source tool to summarise its own session (`claude -p` / `codex exec`), or a local model through Ollama so nothing leaves the machine, for long sessions where decisions are buried mid-conversation
- [x] Hand off to and from Qwen Code (v0.6)
- [ ] Hand off to more tools as their adapters arrive (Gemini CLI, OpenCode, Aider)
- [ ] Handoff from a range of messages, not just the whole session
- [ ] Hooks for live status ("waiting for you", "done") from tools that support them

## Non-goals

- Cloud sync or hosted accounts. If it ever happens, it's opt-in and a separate project.
- Running or orchestrating agents. Other tools do that well; ContextDeck organises what they leave behind and gets you back into it.
