# Security policy

AI agent transcripts are sensitive: they contain source code, file paths, command output and sometimes credentials. ContextDeck's design assumes that and tries to keep the blast radius small:

- **Local only.** No network access, no telemetry, no accounts.
- **Read only.** Agent session files are opened for reading and never modified.
- **Redaction before indexing.** Text passes through `src/util/redact.ts` before it is written to the index. Redaction is best effort: it catches common key formats, bearer tokens, URL credentials, private keys and `SECRET=…`-style assignments, but it cannot catch everything.
- **The index is a cache.** It lives at `~/.contextdeck/index.db` (or `CONTEXTDECK_HOME`). Delete it whenever you like; `contextdeck index` rebuilds it.

Treat `index.db` with the same care as the session folders it was built from. Don't share it or commit it.

## Reporting a vulnerability

Please report privately rather than in a public issue. Use GitHub's **Report a vulnerability** button on the repository's Security tab (private vulnerability reporting). Include what you found, how to reproduce it, and its impact. Please don't include real transcript content; a synthetic reproduction is enough.

Things we especially want to hear about:

- a secret format that slips past redaction,
- any path where data could leave the machine,
- any path where ContextDeck could modify an agent's files,
- crafted session files that cause crashes, hangs or unbounded memory use.

We aim to acknowledge reports within a few days and will credit reporters who want to be credited.
