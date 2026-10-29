# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semantic versioning](https://semver.org/).

## [Unreleased]

## [0.4.0] - 2026-10-29

Handoff: continue a session's work in another tool.

### Added

- **Continue in another tool** from the session panel (Codex ↔ Claude Code), or **Fresh session** in the same tool when a window is nearly full.
- A brief is written from the indexed session: goal, later instructions, where it got to, files changed, recent commands, and how to pick up safely. It is shown in an editor with its size and share of the new window, plus a note when it will go to a different company.
- **Open in Terminal** (macOS) or **Copy command** starts the new session in the project folder with the brief as its first message. Briefs are saved to `~/.contextdeck/handoffs/` (owner-only).
- The new session is linked to the one it continues by a marker in the brief: same workstream, a dashed thread on the canvas, and "continues this session" in both panels. Links survive rebuilding the index.
- `contextdeck handoff <id> [--to …] [--print | --run] [--no-check-in]`.
- Index schema v3 (`handoff_id`, `handoff_from`); older indexes upgrade themselves.
- 22 new tests (107 total), including one that proves a brief full of shell syntax reaches the tool as plain text.

### Changed

- Session titles drop a leading markdown heading marker.
- The background is made inert while a dialog is open.

## [0.3.0] - 2026-10-29

A new look, from the "minimal organiser" design.

### Changed

- The canvas, list and session panel are restyled: Geist and Geist Mono (bundled, SIL OFL), 1px ink lines, a warm grey board, one yellow accent for Claude Code and warm grey for Codex, round vs square tool marks, uppercase tab controls.
- Smaller 208 × 132 cards; linked workstreams sit in boxes, unlinked sessions float with a quieter title.
- **Tidy up / Scatter** toggle: a neat grid, or the loose layout with your hand-placed cards. Moving a card while tidy switches back to scatter.
- Groups active in the last hour glow.
- The list view is grouped the same way as the canvas.
- Search narrows the board to matching sessions (full text plus titles, projects, branches and workstream names) and zooms to fit them.
- The session panel shows a large context percentage and a chart of context use over the whole session.

### Added

- Adapters record context size after every turn and where compactions happened; the index stores it (schema v2). Existing indexes upgrade themselves on first run by re-reading your session files.

### Fixed

- Tilted cards drifted away from their spots on large boards (their position was being rotated along with the card).

## [0.2.0] - 2026-10-29

The canvas.

### Added

- `contextdeck ui`: a local web app on `127.0.0.1` that opens in your browser and updates live as your agents work.
  - Canvas of session cards you can drag anywhere; positions are saved to `~/.contextdeck/board.json`, separate from the index.
  - Group by workstream, project, tool or day. Threads join sessions that edited the same files.
  - Each card fills up to show how full its context window is, with a line per compaction.
  - Search that highlights matching cards, a sortable list view, and a session reader with related sessions, subagents, files changed and the conversation.
  - Copy the resume command, or on macOS open it straight in Terminal.
  - Light and dark themes, keyboard shortcuts (`/`, `Esc`, `+`, `-`, `0`), works down to phone width.
  - No front-end dependencies or build step; the Schibsted Grotesk font (SIL OFL) is bundled so the page never loads anything from the internet.
- Workstreams: `Store.workstreams()` links sessions across tools by shared files and feature branch.
- Hardened local server: Host-header check against DNS rebinding, per-run token and Origin check for writes, strict CSP, static allow-list.
- `npm run demo:ui` with a generator for about 20 realistic synthetic sessions (`scripts/demo-data.mjs`).
- 17 new tests (79 total).

## [0.1.0] - 2026-10-28

First public scaffold.

### Added

- Unified session schema shared by all providers.
- Claude Code adapter: main sessions, subagents (current and older layouts), summaries as titles, streamed-usage de-duplication, compactions, edited files.
- Codex CLI adapter: current `{timestamp,type,payload}` rollouts, the older un-wrapped format, `.jsonl.zst` compressed rollouts, archived sessions, token usage and context window, files from `apply_patch`.
- Local SQLite index (Node's built-in `node:sqlite`) with FTS5 full-text search and incremental re-indexing.
- Secret redaction before indexing.
- CLI: `index`, `list`, `search`, `show`, `resume`, `related`, `projects`, `watch`, `stats`, `doctor`, with `--json` output.
- Synthetic fixtures, 62 tests, CI.
