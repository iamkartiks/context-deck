# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semantic versioning](https://semver.org/).

## [Unreleased]

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
