# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semantic versioning](https://semver.org/).

## [Unreleased]

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
