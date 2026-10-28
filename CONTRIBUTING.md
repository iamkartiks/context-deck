# Contributing to ContextDeck

Thanks for helping. This guide gets you from clone to a merged pull request.

## Setup (about two minutes)

You need Node.js 22.13+ (`.nvmrc` pins 22; `nvm use` picks it up).

```bash
git clone <your-fork-url> contextdeck && cd contextdeck
npm install
npm test          # builds, then runs the whole suite
npm run demo      # indexes the sample sessions in fixtures/ into ./.demo
```

There are no native dependencies, so if `npm install` works, everything works.

## Day-to-day

| | |
|---|---|
| `npm run dev` | Rebuild on save |
| `npm test` | Build + all tests (Node's built-in test runner) |
| `npm run typecheck` | Types only |
| `node bin/contextdeck.js --home .demo --claude-dir fixtures/claude --codex-dir fixtures/codex <command>` | Run the CLI against the samples |

Point the CLI at a throwaway `--home` while developing so you never disturb your real index.

## Project layout

```
src/
  schema.ts            the unified types every adapter produces
  adapters/            one file per tool (+ types.ts contract, index.ts registry)
  store.ts             SQLite index: sessions, messages, FTS, files touched
  indexer.ts           incremental scan + watch mode
  cli.ts, format.ts    the command line
  util/                streaming JSONL reader, redaction, text helpers
test/                  *.test.ts, one per module
fixtures/              synthetic session files that mirror each tool's real layout
docs/                  architecture, adapter guide, roadmap
```

## What makes a good PR

- **Small and focused.** One adapter, one bug, one feature.
- **Tests with the change.** Parser changes need a fixture line that exercises them. Bug fixes need a test that failed before.
- **No real transcripts in fixtures.** Write synthetic sessions. Never commit anything copied from your own `~/.claude` or `~/.codex` without rewriting it, since transcripts contain code, paths and secrets.
- **No secret-shaped strings in source.** Build fake keys at runtime (see `test/redact.test.ts`) so GitHub push protection stays quiet.
- **Read-only, local-only.** Adapters must never write to a tool's folders, and nothing may make network calls. These are promises the README makes to users.
- **Keep dependencies at zero** unless there is a strong reason; discuss it in an issue first.

## Format changes (the most common bug)

Claude Code and Codex change their on-disk formats without notice. When something breaks:

1. Run `contextdeck doctor` to find the failing file.
2. Find the line shape that's new or changed.
3. Add a minimal, synthetic version of that line to the matching fixture (or a new fixture file).
4. Make the adapter handle **both** old and new shapes; users have sessions from many versions on disk.

## Commit and PR conventions

- Commit messages: imperative and short (`codex: read thread_name as title`). Prefix with the area when it helps: `claude-code:`, `codex:`, `store:`, `cli:`, `docs:`.
- Fill in the PR template; CI must be green.
- Update `CHANGELOG.md` under "Unreleased" for anything user-visible.

## Reporting security issues

Please don't open public issues for vulnerabilities, especially anything that could leak transcript contents. See [SECURITY.md](SECURITY.md).
