# Security policy

AI agent transcripts are sensitive: they contain source code, file paths, command output and sometimes credentials. ContextDeck's design assumes that and tries to keep the blast radius small:

- **Local only.** No network access, no telemetry, no accounts.
- **Read only.** Agent session files are opened for reading and never modified.
- **Redaction before indexing.** Text passes through `src/util/redact.ts` before it is written to the index. Redaction is best effort: it catches common key formats, bearer tokens, URL credentials, private keys and `SECRET=…`-style assignments, but it cannot catch everything.
- **The index is a cache.** It lives at `~/.contextdeck/index.db` (or `CONTEXTDECK_HOME`). Delete it whenever you like; `contextdeck index` rebuilds it.

Treat `index.db` with the same care as the session folders it was built from. Don't share it or commit it.

## The canvas server (`contextdeck ui`)

The UI is served by a small HTTP server that only listens on `127.0.0.1`. Because it serves transcript content, it defends against the ways a web page you visit could try to reach a local server:

- **DNS rebinding.** Every request must carry a `Host` header of `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`; anything else is refused with 403.
- **Cross-site reads.** No CORS headers are ever sent, so other origins can't read responses.
- **Cross-site writes.** Every request that changes something (saving the layout, rescanning, opening Terminal) needs a random token generated at startup and embedded only in the page this server serves, and any `Origin` header must match the server.
- **Content Security Policy.** The page runs under `default-src 'none'` with scripts, styles, fonts and requests limited to itself. Fonts are bundled, so the page makes no requests to the internet.
- **Static files** come from a fixed allow-list, so there is no path traversal.
- **Request bodies** are capped at 2 MB and the saved layout is validated and normalised before it is written.

**Open in Terminal** (macOS only) runs the session's own resume command (`claude --resume <id>` or `codex resume <id>`) in a new Terminal window. The command is built by ContextDeck from the indexed session, with every argument shell-quoted; nothing from the request other than the session id is used. It needs the token like every other write.

`board.json` (your canvas arrangement) contains only session ids and coordinates.

## Reporting a vulnerability

Please report privately rather than in a public issue. Use GitHub's **Report a vulnerability** button on the repository's Security tab (private vulnerability reporting). Include what you found, how to reproduce it, and its impact. Please don't include real transcript content; a synthetic reproduction is enough.

Things we especially want to hear about:

- a secret format that slips past redaction,
- any path where data could leave the machine,
- any way for a web page or another user to read from or act through the `contextdeck ui` server,
- any path where ContextDeck could modify an agent's files,
- crafted session files that cause crashes, hangs or unbounded memory use.

We aim to acknowledge reports within a few days and will credit reporters who want to be credited.
