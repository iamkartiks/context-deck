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

**Open in Terminal** runs the session's own resume command (`claude --resume <id>` or `codex resume <id>`) in a new terminal window: Terminal on macOS, a terminal app found on your PATH on Linux, Windows Terminal or PowerShell on Windows. The command is built by ContextDeck from the indexed session, with every argument quoted for that system's shell; nothing from the request other than the session id is used. On Linux the terminal is started directly with an argument list (no shell in between). On Windows, where the command passes through a command line, anything containing a character that cmd.exe, Windows Terminal or PowerShell treats specially (`" % ^ & | < > ! ` $ ;` or a line break) is refused rather than escaped. It needs the token like every other write.

**Handoffs** start a new agent session with a brief built from an existing one:

- The brief is built from indexed text, which was already redacted, and the person sees and can edit all of it before anything starts.
- Starting a handoff to a different tool sends the brief to that tool's provider. The UI says which company before you start.
- Briefs are saved to `~/.contextdeck/handoffs/` with owner-only permissions (directory 0700, files 0600). The file name is a generated id checked against `hf_` plus 10 hex digits, so a request can't choose where a file is written.
- On macOS and Linux the start command reads the brief with `$(cat '<file>')` inside double quotes, so the brief's contents are passed as one argument and never run as shell code. A test checks this with a brief full of `$(…)`, backticks and quotes.
- On Windows the brief never goes on a command line. The tool is started with a one-line pointer to the brief file, built only from the session title (special characters removed), the brief's path and the marker. Reading an earlier brief back is done by handoff id, inside ContextDeck's own folder only.
- Like every other write, `POST /api/handoff` needs the per-run token and a matching Origin. The target must be a known tool.

### Phone mode (`contextdeck ui --phone`)

Phone mode lets devices on your own Tailscale network reach the canvas through Tailscale Serve, which proxies HTTPS from your tailnet to the server on `127.0.0.1`. It's on only while `contextdeck ui --phone` runs. The server still listens only on `127.0.0.1`.

**Tailscale setup:**
- ContextDeck runs the `tailscale` CLI with an argument list, never through a shell.
- It points `https://<tailnet name>/` at its port with Serve, and refuses to replace anything else already served there.
- It never turns on Funnel. It refuses to run if Funnel is on for that address, or for any address that reaches its port, and it checks this both before and after setting up Serve.
- When it stops, it removes only the Serve entry it added, and prints the command to remove it by hand if that fails.
- With `--no-serve`, it leaves Serve alone but still refuses Funnel.

**Telling requests apart:**

- **Local or remote.** In phone mode, one more `Host` is accepted: this computer's exact tailnet name (e.g. `laptop.tail1234.ts.net`), never a wildcard. Requests with that Host are remote. A request carrying a proxy header (`Tailscale-User-*`, `X-Forwarded-*`, `Forwarded`) is also treated as remote, even if its Host looks local, so a proxy that rewrites Host can't make a phone look like this computer.
- **A Tailscale user is required.** Remote requests must carry the `Tailscale-User-Login` header that Serve adds and strips from clients. Without it (for example, traffic from a tagged device) the request is refused with 403.
- **Origins are kept apart.** Local writes accept only `http://` loopback origins. Remote writes must carry `Origin: https://<tailnet name>`, and then need the per-run token like every other write.

**Pairing a device:**

1. On the computer, a one-time pairing code is made: 128 random bits, held in memory only, valid for 5 minutes, usable once. Making a new code cancels the last one.
2. The code travels in the URL fragment (`https://<tailnet name>/pair#<code>`), which browsers never send to a server, so it can't show up in logs or Referer headers. The pairing page removes it from the address bar.
3. The pairing page is the only thing an unpaired device can load. It holds no token and no data.
4. The phone sends the code and a device name. A right code creates a *pending* request tied to the phone's Tailscale login.
5. **The computer must allow it.** Allowing or denying is a local-only action. A photographed QR code alone isn't enough to pair.
6. Once allowed, the phone gets a 256-bit device secret in a cookie (`HttpOnly; Secure; SameSite=Strict`, 30 days).
7. `~/.contextdeck/devices.json` (owner-only) stores only the secret's SHA-256.

**Limits on pairing:**
- 5 tries per minute, counted per Tailscale login and in total;
- at most 10 devices, with waiting requests counting toward the limit;
- requests expire after 5 minutes.

**On every remote request:**
- the cookie's hash must match a device;
- the device must belong to the same Tailscale login, so a stolen cookie is useless to anyone else;
- the device must not have expired. A device expires 30 days after it was last seen.

**Scopes:** each route needs a scope, listed in one table (`src/scopes.ts`). Any route missing from that table is refused to remote devices.
- New devices get `view` and `decide`.
- Opening a terminal, changing the layout, rescanning, search-by-meaning settings, starting a handoff, and managing devices are never allowed remotely, whatever a device holds.

**Revoking** removes the device. Its next request fails, and its open event streams close within a second, even when it was revoked from the command line.

**Audit log:** `~/.contextdeck/phone-audit.log` (owner-only) gets one JSON line per pairing request, approval, denial, revocation, scope change and write from a device. Entries hold ids, routes and outcomes, never message text, briefs or secrets. The log is rotated at 1 MB, keeping one old file.

**Out of scope:** a program already running on this computer could call `127.0.0.1` directly and forge these headers. That program can already read `~/.claude` and every other session folder, so phone mode doesn't defend against it.

`board.json` (your canvas arrangement) contains only session ids and coordinates.

**Search by meaning** is off by default; while off, nothing talks to any model.
- **What's sent:** when on, ContextDeck sends prompts, replies, titles and decisions (already redacted) to the embedding server in `~/.contextdeck/config.json` (owner-only).
- **Where it can go:** that server must be on this computer (`localhost`, `127.x`, `::1`). Any other address is refused unless set from the command line with `--allow-remote`. The canvas can't turn that on, and `PUT /api/semantic` rejects non-local addresses.
- **Checks:** model names are checked against a strict character set, and URLs can't carry credentials. Turning it on or off needs the per-run token and a matching Origin, like every write.
- **Where vectors live:** in the index (`chunks` table), which is a cache. `contextdeck semantic disable --drop` deletes them.

`decisions.json` holds the decisions you marked: your words, session ids, message positions and a fingerprint of each message. It quotes your sessions, so it's written owner-only (0600) like the index. Adding, editing and removing decisions need the per-run token and a matching Origin like every other write; ids are checked against `d_` plus 10 hex digits, positions must point at a real message, and text is capped at 2,000 characters.

## Reporting a vulnerability

Please report privately rather than in a public issue. Use GitHub's **Report a vulnerability** button on the repository's Security tab (private vulnerability reporting). Include what you found, how to reproduce it, and its impact. Please don't include real transcript content; a synthetic reproduction is enough.

Things we especially want to hear about:

- a secret format that slips past redaction,
- any path where data could leave the machine,
- any way for a web page or another user to read from or act through the `contextdeck ui` server,
- any path where ContextDeck could modify an agent's files,
- crafted session files that cause crashes, hangs or unbounded memory use.

We aim to acknowledge reports within a few days and will credit reporters who want to be credited.
