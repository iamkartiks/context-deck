# Fixtures

Synthetic session files laid out exactly like each tool's real folders, used by the tests and by `npm run demo`.

**Everything here is invented.** The user "alice", the `acme-shop` and `blog` projects, ids, code and token counts are made up. Never add real transcripts, even edited ones; write synthetic lines that reproduce the shape you need.

| Path | Exercises |
|---|---|
| `claude/projects/-Users-alice-code-acme-shop/7c1e…1b11.jsonl` | summary title, meta and command wrappers, streamed usage counted once, tool results, an inline sidechain line, a truncated (malformed) line, a compaction |
| `claude/…/7c1e…1b11/subagents/agent-4e5f6a7b.jsonl` | current subagent layout, linked to its parent |
| `claude/projects/-Users-alice-code-blog/2f9d…7c22.jsonl` | a second project, plain-string content |
| `claude/projects/-Users-alice-code-blog/9b8a…7c33.jsonl` | a file with no conversation (snapshots only) |
| `codex/sessions/2026/10/27/rollout-…-019a…f701.jsonl` | current wrapped format, injected context, duplicated event_msg text, `apply_patch` files, token counts and context window, a compaction |
| `codex/sessions/2025/08/14/rollout-…-3a4b…4c5d.jsonl` | the older un-wrapped format |

The Claude and Codex `acme-shop` sessions both edit `src/auth/session.ts` (one absolute path, one relative), which is what makes `contextdeck related` link them across tools.
