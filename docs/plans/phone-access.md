# Plan: use ContextDeck from your phone

Status: proposed · Owner: the maintainer reviews every PR · Last updated: 2026-11-17

This plan lets you use ContextDeck from a phone while your agents and sessions stay on your laptop. The phone is a remote screen and keyboard: it never stores your sessions, and nothing goes through a server you don't own.

It ships in three phases, each useful on its own and each a stopping point:

| Phase | You can, from your phone | Risk |
|---|---|---|
| 1. Look and decide | Browse the canvas and list, search, read sessions, mark and check decisions | Low: reads, plus writes to `decisions.json` |
| 2. Start work | Hand off or resume a session; the agent runs in the background on the laptop, and you watch its output | Medium: starts agents, but only in "plan only" or "edit this folder" modes |
| 3. Chat and approve | Send messages to a session and answer the agent's permission requests | Higher: interactive control, with approvals |

Read this whole document before starting. Then read `README.md`, `SECURITY.md`, `docs/ARCHITECTURE.md` and `src/server.ts`. Phase 1 changes the security model, so get the design right before writing UI.

---

## 0. Ground rules for this work

These come from the project and are not up for change in this plan:

- **Local only.** No ContextDeck-run servers, relays, accounts or telemetry. The phone reaches the laptop over the user's own Tailscale network (tailnet), and nothing else.
- **Never public.** ContextDeck must never set up Tailscale Funnel, port forwarding, `0.0.0.0` binds or anything else that exposes it to the internet. Refuse with an error if the user's Serve configuration for our port is public.
- **The server still listens on `127.0.0.1` only.** Tailscale Serve proxies HTTPS from the tailnet to it. Don't add a "bind to other interfaces" option.
- **Read-only access to agent session folders,** as today. Phase 2 starts agents, and the agents write their own session files; ContextDeck still never writes to them.
- **Zero native dependencies.** Node 22+, `node:` built-ins only. Vendoring a small MIT/BSD pure-JS library is fine (see QR codes below), with its licence file.
- **Off by default.** Nothing in this plan runs unless the user starts `contextdeck ui --phone`. Plain `contextdeck ui` behaves exactly as today, and its tests must not change.
- **Branches and PRs,** one PR per numbered item below. Never commit to `main`. Each PR keeps `npm test` green on Linux, macOS and Windows.
- **Plain-language UI copy:** sentence case, say what the user sees, no hype.

---

## 1. How the pieces fit

```
Phone browser ──HTTPS over tailnet──▶ tailscale serve (on the laptop)
                                         │ proxies to http://127.0.0.1:<port>
                                         │ adds Tailscale-User-Login / -Name headers
                                         ▼
                              ContextDeck server (127.0.0.1)
                               ├─ request is "local" or "remote" (see 2.1)
                               ├─ remote: device cookie + Tailscale login required
                               ├─ scopes decide which routes a device may call
                               └─ Phase 2+: RunManager starts agents headless
                                      claude -p … / codex exec … / qwen -p …
```

Facts this design relies on (checked 2026-11-17; re-check on the versions you test with):

- **Tailscale Serve** proxies a local port to HTTPS on the device's tailnet name (`<device>.<tailnet>.ts.net`). It's tailnet-only, unlike Funnel, which is public. Serve adds `Tailscale-User-Login`, `Tailscale-User-Name` and sometimes `Tailscale-User-Profile-Pic`, and strips any copies a client sends. The headers are missing for traffic from tagged devices and from Funnel. Tailscale's docs recommend the backend listen on localhost only, so clients can't bypass Serve and forge the headers. That's exactly our setup. ([Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve))
- **Claude Code** runs a turn headless with `claude -p`, resumes a session with `--resume <id>`, streams with `--output-format stream-json --verbose --include-partial-messages`, and takes `--permission-mode` (`default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`). `--permission-prompt-tool mcp__<server>__<tool>` sends permission prompts to an MCP tool, and `--permission-prompts none` denies anything that would prompt. A `-p` run loads project hooks and `.mcp.json` without a trust dialog. ([headless](https://code.claude.com/docs/en/headless), [CLI reference](https://code.claude.com/docs/en/cli-reference))
- **Codex** runs `codex exec "<prompt>"`, resumes with `codex exec resume <SESSION_ID> "<prompt>"`, emits JSONL with `--json`, sets the sandbox with `--sandbox read-only|workspace-write|danger-full-access`, sets the folder with `-C <dir>`, and reads the prompt from stdin with `-`. Third-party wrappers report that resumed turns can drop the sandbox setting, and approvals for MCP tools can't be answered in `exec`. Treat both as real until proven otherwise. ([cheat sheet](https://github.com/jqueryscript/codex-commands-cheat-sheet/blob/main/README.md), [openai/codex#24135](https://github.com/openai/codex/issues/24135))
- **Qwen Code** runs `qwen -p`, resumes with `--resume <sessionId>`, streams with `--output-format stream-json --include-partial-messages`, and takes `--approval-mode plan|default|auto-edit|auto|yolo`. Sessions are scoped to the working directory. What happens in headless mode when a tool needs approval isn't documented. ([Qwen Code headless](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/))

---

## 2. Phase 1: look and decide

Goal: `contextdeck ui --phone`, scan a QR code on the laptop, and the phone shows ContextDeck. You can browse, search and read sessions, and mark or check decisions. Everything else (handoff, open in terminal, reindex, layout writes, search-by-meaning settings) is hidden and refused for phones.

### 2.1 Local vs remote requests (PR 1)

Every request gets a context, `{ remote: boolean, device?: Device }`, computed once at the top of the handler in `src/server.ts`.

- Today, `allowedHosts()` is `127.0.0.1:<port>`, `localhost:<port>` and `[::1]:<port>`. Keep that exactly for local requests.
- In phone mode, add one more allowed Host: the laptop's tailnet name, e.g. `laptop.tail1234.ts.net`. Read it from `tailscale status --json` (`Self.DNSName`, trailing dot removed) at startup. Not a wildcard, not `*.ts.net`.
- A request is **remote** when its Host is the tailnet name. Requests arrive from `127.0.0.1` either way, because Serve proxies them, so the Host header is what tells them apart.
- Remote requests **must** carry `Tailscale-User-Login`. If it's missing (tagged device, misconfiguration), refuse with 403 and a clear message.
- Allowed Origins for writes become `http://<local hosts>` plus `https://<tailnet name>` in phone mode.
- Document the boundary in `SECURITY.md`: a program already running on the laptop could forge these headers by calling `127.0.0.1` directly. That's out of scope, because such a program can already read `~/.claude` and every other session folder.

### 2.2 Devices and pairing (PR 2)

Today, `index.html` is served with the per-run write token baked in (`__CONTEXTDECK_TOKEN__`). That's safe only because nobody else can load the page. For remote requests, the page and every `/api/*` route need a paired device first.

**Store:** `~/.contextdeck/devices.json`, written like `decisions.json` (atomic rename, mode `0600`, sanitised on load, version field):

```json
{
  "version": 1,
  "devices": [{
    "id": "dv_7f3a9c21e0",
    "name": "Pixel 9",
    "tailscaleLogin": "you@example.com",
    "secretHash": "<sha256 of the device secret, hex>",
    "scopes": ["view", "decide"],
    "createdAt": "…", "lastSeenAt": "…", "expiresAt": "…"
  }],
  "pending": []
}
```

**Pairing flow:**

1. On the laptop, `contextdeck ui --phone` prints a QR code in the terminal, and the desktop canvas has **Pair a phone** under its settings. Both create a one-time pairing code: 128 random bits, valid for 5 minutes, single use, held in memory only.
2. The QR code encodes `https://<tailnet name>/pair#<code>`. The code is in the fragment, so it never reaches the server log, proxies or the browser's Referer header.
3. The phone loads `/pair`. This is a small page, `ui/pair.html` with `ui/pair.js`, under the same strict CSP. It's the only page served to an unpaired remote request, and it contains no token and no data. It reads the fragment and POSTs `{ code, name }` to `POST /api/pair`.
4. The server checks the code (constant-time compare, unexpired, unused) and records a **pending** device with the request's `Tailscale-User-Login`.
5. **The laptop must approve it.** The desktop canvas shows "Allow Pixel 9 (you@example.com) to open ContextDeck?" with Allow and Deny. The terminal prints the same, but approval happens only in the desktop UI, a local request. This stops a photographed QR code from pairing someone else's phone.
6. While waiting, the phone polls `GET /api/pair/status`. Once approved, the server issues the device secret (256 random bits) and stores only its SHA-256. The secret is set as a cookie: `cd_device=<secret>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`.
7. The phone redirects to `/`.

**Every later remote request:**
- hash the cookie and find the device;
- check that `Tailscale-User-Login` matches the device's recorded login, so a stolen cookie is useless from another tailnet user;
- check it hasn't expired, and update `lastSeenAt`, throttled to once a minute;
- if the device is unknown or expired, serve only the pair page or a 401.

Then the existing write token and Origin checks run on top, unchanged.

**Limits:**
- 5 pairing attempts per minute, counted per tailnet login and in total;
- at most 10 paired devices;
- devices expire 30 days after they were last seen;
- pending requests expire after 5 minutes.

**Revoking:**
- `contextdeck phone devices` lists devices: name, login, scopes, last seen.
- `contextdeck phone revoke <id|all>` removes them.
- The desktop canvas has the same list, plus **Disconnect all phones**.
- Revoking takes effect on the next request; open event streams for that device close within 1 second.

**Audit log:** `~/.contextdeck/phone-audit.log`, one JSON line per remote action (pair requested, approved or denied, device revoked, every write, and in later phases every run and approval), mode `0600`. Rotate at 1 MB, keeping one old file. Never log message text, briefs or secrets: just ids, routes and outcomes.

### 2.3 Scopes (PR 2)

Each route declares what it needs. Local requests have every scope. Remote requests have only the device's scopes.

| Scope | Routes | Default for new phones |
|---|---|---|
| `view` | `GET /api/board`, `/api/session/:id`, `/api/search`, `/api/matches`, `/api/decisions`, `/api/layout`, `/api/semantic`, `/api/events` | yes |
| `decide` | `POST/PUT/DELETE /api/decisions…` | yes |
| `handoff` (phase 2) | `GET /api/handoff/preview`, `POST /api/runs` with `kind: "handoff"` | no |
| `run` (phase 2) | `POST /api/runs` with `kind: "resume"` or `"new"`, `DELETE /api/runs/:id` | no |
| `edit` (phase 2) | Runs in "edit this folder" mode | no |
| `approve` (phase 3) | `POST /api/approvals/:id` | no |
| never remote | `POST /api/open-terminal`, `PUT /api/layout`, `POST /api/reindex`, `PUT /api/semantic`, device management | — |

Implement this as one table in the server (route plus method, mapped to a scope), not checks scattered through handlers. Add a test that walks every route and fails if one has no entry. Scopes beyond the defaults are granted in the desktop UI's device list.

### 2.4 Tailscale setup (PR 3)

The new module is `src/tailscale.ts`. All calls go through `spawn` with an argument array, never a shell. The binary is `CONTEXTDECK_TAILSCALE_BIN`, else `tailscale` on PATH. On macOS, also try `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.

- `status()`: runs `tailscale status --json`. Returns `{ running, dnsName, httpsEnabled }`, or a readable error like "Tailscale isn't running", "Tailscale isn't installed" or "HTTPS certificates aren't enabled for your tailnet".
- `serve(port)`: proxies HTTPS 443 on the tailnet name to `http://127.0.0.1:<port>`. The exact CLI changed across Tailscale versions. Check `tailscale serve --help` on the versions in CI's fake and on a real machine, support the current form, and fail with the command to run by hand if it doesn't work.
- After setting up, read `tailscale serve status --json` and verify the proxy points at our port **and is not Funnel**. If Funnel is on for that port, stop and refuse.
- `unserve(port)`: on shutdown, remove only the entry ContextDeck added. Never reset the user's other Serve config. Record what we added in memory so Ctrl+C cleans it up, and print the manual undo command if cleanup fails.
- `--phone --no-serve` skips setup for people who configure Serve themselves. ContextDeck still verifies it isn't Funnel.

### 2.5 CLI (PR 3)

- `contextdeck ui --phone`: starts as today, then sets up Serve and prints the phone URL, a QR code for pairing, and a line saying who can reach it ("Devices on your Tailscale network that you approve"). Without `--phone`, it prints exactly what it prints today.
- `contextdeck phone devices [--json]`, `contextdeck phone revoke <id|all>`.
- **QR codes:** vendor Project Nayuki's QR Code generator (MIT, pure JS/TS, no dependencies) into `src/vendor/qrcodegen/` with its licence. Render it in the terminal with Unicode half-blocks and in the desktop UI as an inline SVG. Add `src/vendor/` to the lint and coverage exclusions, and keep it unmodified.

### 2.6 Phone UI (PR 4)

The canvas already works at 400 px wide. Phone mode needs a few changes:

- Remote clients open in **List** view, with the session reader as a full-screen page and a back button. The canvas stays available from the view switcher.
- Hide controls a device's scopes don't allow: handoff, Open in terminal, reindex, the search-by-meaning settings, card dragging. Don't just disable them.
- Show a small "Phone · read-only" or "Phone · can run agents" chip in the header, so it's always clear what this device can do.
- Add a web app manifest, `ui/manifest.webmanifest` with `manifest-src 'self'` in the CSP, so "Add to Home Screen" works. No service worker in phase 1.
- Keep tap targets at least 44 px, check that it works in both themes, and check for horizontal overflow at 360 px.

### 2.7 Tests for phase 1

Use the existing helpers (`scratch()`, an in-process server). Add a fake `tailscale` binary: a small Node script selected through `CONTEXTDECK_TAILSCALE_BIN`, which returns canned `status --json` and `serve status --json` output and records the arguments it was called with.

- **Local mode is unchanged:** all existing server tests pass without edits.
- **Host:** the tailnet name is accepted only in phone mode, and other `*.ts.net` names are refused.
- **Missing login header:** a remote request without `Tailscale-User-Login` gets 403.
- **Unpaired remote:** `/` returns the pair page, which contains no `__CONTEXTDECK_TOKEN__` and no token, and `/api/board` returns 401.
- **Pairing:** a code is single use and expires; a wrong code, too many attempts, or a pending device not yet approved all fail; denial works; approval sets a cookie with the right attributes; only the hash is stored; the file is `0600` (skip the permission check on Windows).
- **Cookie:** the cookie with a different `Tailscale-User-Login` is refused, and an expired device is refused.
- **Scopes:** every route has a table entry, a view-only device can't call write routes, and "never remote" routes are refused even for a device holding every scope.
- **Origin:** remote writes need `https://<tailnet name>` as the Origin.
- **Revoking:** it takes effect on the next request, and the device's event stream closes.
- **Serve:** the module calls the expected arguments, refuses when Funnel is on, and on shutdown removes only its own entry.
- **Audit log:** it gets an entry per action, and contains no message text.

**Manual test, required before merging PR 4:** a real phone on the same tailnet; pair, approve, browse, search, mark a decision; revoke and confirm the phone is locked out; stop `ui` and confirm the Serve entry is gone.

### 2.8 Phase 1 is done when

- `contextdeck ui --phone`, scanning the QR code and approving on the laptop gives a working read-and-decide view on the phone.
- An unpaired device, or a paired device from a different tailnet login, sees nothing but the pair page.
- Plain `contextdeck ui` is unchanged.
- `SECURITY.md`, the README and `docs/ARCHITECTURE.md` describe phone mode, the threat model (2.1 and section 5) and how to revoke.

---

## 3. Phase 2: start work from the phone

Goal: from the phone, **Continue in Codex**, **Fresh session**, or **Resume with a message**. The agent runs headless on the laptop, in the session's folder, and the phone shows its output live. No approvals yet: each run is **Plan only** (no changes) or **Edit this folder**.

### 3.1 Headless drivers in adapters (PR 5)

Extend `Adapter` in `src/adapters/types.ts` with an optional capability, so third-party adapters keep working:

```ts
headless?: {
  /** argv for one turn that continues an existing session. The prompt arrives on stdin. */
  continueArgs(session: SessionRow, mode: RunMode): { command: string; args: string[]; cwd: string };
  /** argv for one turn that starts a new session in `cwd`. The prompt arrives on stdin. */
  startArgs(cwd: string, mode: RunMode): { command: string; args: string[]; cwd: string };
  /** Turn one line of the tool's streamed output into zero or more RunEvents. Never throws. */
  parseLine(line: string): RunEvent[];
};
type RunMode = 'plan' | 'edit';
type RunEvent =
  | { type: 'session'; nativeId: string }         // so a new run links to its session
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; summary: string }
  | { type: 'denied'; tool: string; reason: string }
  | { type: 'done'; ok: boolean; summary?: string; costUsd?: number }
  | { type: 'error'; message: string };
```

**Always send the prompt on stdin, never as an argument.** Briefs are long, and arguments can leak through `ps`. All three tools read stdin in headless mode; for Codex, pass `-` as the prompt.

Per tool (verify every flag against `--help` on the installed version, and write the version you tested into the adapter's comment):

| | Plan only | Edit this folder |
|---|---|---|
| Claude Code | `claude -p --resume <id> --output-format stream-json --verbose --include-partial-messages --permission-mode plan --permission-prompts none` | the same, with `--permission-mode acceptEdits` |
| Codex | `codex exec resume <id> --json --sandbox read-only -C <cwd> -` | `--sandbox workspace-write`, still no approvals |
| Qwen Code | `qwen -p --resume <id> --output-format stream-json --include-partial-messages --approval-mode plan` (cwd = session cwd) | `--approval-mode auto-edit` |

New sessions use the same flags without the resume part.

Never construct `bypassPermissions`, `dontAsk` with broad allow rules, `danger-full-access`, `yolo`, `--dangerously-*` or `auto` from any phone request. Keep the allowed flags in a fixed table, and add a test that runs every mode for every adapter and asserts none of those strings appear.

Don't use Claude Code's `--bare`. It skips the user's `CLAUDE.md` and hooks, and needs an API key instead of their subscription login.

**Codex sandbox on resume:** because resumed `exec` turns have reportedly dropped the sandbox, also pass the sandbox as config (`-c sandbox_mode="read-only"` or `"workspace-write"`). Add an integration test, skipped unless `CONTEXTDECK_REAL_CODEX=1`, that resumes a session in read-only mode, asks it to create a file, and asserts the file wasn't created. Record the result in the PR.

**Folder trust:** a Claude Code `-p` run loads the folder's hooks and `.mcp.json` without asking. Only allow runs in folders that already have at least one indexed session from that same tool, i.e. folders the user has already worked in. Refuse any other folder with a clear message.

### 3.2 RunManager (PR 6)

New module `src/runs.ts`, owned by the UI server.

- `start({ kind: 'resume' | 'new' | 'handoff', sessionRef?, target?, cwd?, prompt, mode, deviceId })` returns a `Run`.
- **One active run per session,** and a small queue (at most 3 waiting) for follow-up messages. At most 3 runs at once overall.
- **Spawn:** `spawn(command, args, { cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })`. Write the prompt to stdin, then close it.
- **Read output line by line,** with lines capped at 1 MB. Pass each line to `parseLine`, and push events to the subscribers' event streams, batching text deltas for 100 ms.
- **Cancel:** send SIGINT first so the agent records the turn, then SIGTERM after 5 seconds, then SIGKILL after 10. On Windows, `taskkill /T /F` is the fallback.
- **Time limit:** 30 minutes per run by default, configurable in `config.json`.
- **Logs:** `~/.contextdeck/runs/<runId>.jsonl` (mode 0600) holds events, not raw output. Keep the last 50 runs or 7 days. Redact text with the same `redact()` the indexer uses before writing.
- **When a run ends,** reindex just that session's file (`indexSources` already supports single sources; add a narrow helper if it doesn't), so the reader shows the new turn straight away.
- **Handoff runs** reuse `buildBrief()` and `saveBrief()`. The prompt is the brief text on stdin, and the handoff marker links the new session as it does today.

**Routes, with scopes from 2.3:**
- `POST /api/runs` starts a run;
- `GET /api/runs` lists active and recent runs;
- `GET /api/runs/:id` returns a run and its recent events;
- `DELETE /api/runs/:id` cancels a run;
- the event stream gains `run` and `run-event` messages.

**Keep the laptop awake** while a run is active and a phone is connected:
- macOS: `caffeinate -i -w <runPid>`;
- Linux: `systemd-inhibit --what=idle --why="ContextDeck run" sleep <n>` if available;
- Windows: skip, and note it in the docs.

### 3.3 Phone UI for runs (PR 7)

- In the session reader:
  - **Continue in…** and **Fresh session** buttons, for the `handoff` scope. They open the existing brief composer, then **Start on laptop**.
  - **Send a message**, for the `run` scope. It resumes the session with your message.
- **Mode picker:** "Plan only (no changes)", the default, or "Edit files in <folder>", shown only with the `edit` scope. It names the folder in full, every time.
- **Run panel:** a live transcript of text, tool lines and denied actions, with Stop, status and elapsed time. A "Stopped" or "Failed" state shows the reason.
- **Cards** get a status chip, "Running", "Queued" or "Done", for sessions with runs.
- On the laptop's desktop canvas, show phone-started runs too, with "Started from Pixel 9".

### 3.4 Tests for phase 2

- **Fake agents:** add `test/fake-agents/` with Node scripts that act as `claude`, `codex` and `qwen`. They read stdin, write the arguments they received to a file, and replay recorded stream fixtures (synthetic, no real transcripts). Select them with `CONTEXTDECK_CLAUDE_BIN`, `CONTEXTDECK_CODEX_BIN` and `CONTEXTDECK_QWEN_BIN`.
- **Exact arguments:** the argument array for every adapter, mode and kind, plus the forbidden-flags test.
- **The prompt goes on stdin,** never in the arguments.
- **Limits:** one active run per session, the queue, and the overall limit.
- **Cancel and time limit:** signals are sent in order, and the run ends as Stopped.
- **Folder trust:** an unknown folder is refused.
- **Scopes:** a `view`-only device can't start runs, and only `edit` can choose edit mode.
- **Logs:** run logs are redacted, mode 0600, and pruned.
- **Reindex:** after a run, the session shows the new turn.
- **Handoff:** a handoff run links the new session to the old one.
- **Crashes:** a crashed agent, invalid JSON lines and a huge line all produce a Failed run, not a server crash.
- **CLI tests that use in-process fakes** must use async `execFile`, not `spawnSync`, as in the existing suite, or they deadlock.

### 3.5 Phase 2 is done when

From the phone, with a device granted `handoff`, `run` and `edit`:
- hand off a Claude Code session to Codex, in plan mode, and watch it reply;
- resume a session with a message in edit mode, and see its file changes appear in the reader;
- stop a run.

Nothing a phone sends can start an agent with approvals bypassed.

---

## 4. Phase 3: chat and approvals

Goal: a chat-style conversation with a session from the phone, where the agent asks before running commands or editing outside the allowed mode, and you answer on the phone.

### 4.1 Approvals for Claude Code (PR 8)

- ContextDeck ships a tiny MCP server that talks JSON-RPC over stdio, written with `node:` built-ins: `contextdeck approver`. It exposes one tool, `approve`. For an approval run, the RunManager starts Claude Code with:
  - `--mcp-config` pointing at a temp file (0600) that names `contextdeck approver --run <runId>`;
  - `--permission-prompt-tool mcp__contextdeck__approve`;
  - `--permission-mode default`.
- The approver connects back to the UI server over a local channel: a Unix socket in `~/.contextdeck/` with mode 0600, or a named pipe on Windows, authenticated with a per-run random secret passed in its environment. It forwards `{ tool, input }` and waits for the answer.
- **Confirm the exact input and output format** of a permission-prompt tool (an allow/deny decision, optionally with updated input) against the current Agent SDK docs before writing it. Add a contract test with a recorded example.
- **The phone gets an approval card:**
  - the tool;
  - the command, or a diff for edits, using the edit tool's old and new strings;
  - the folder.
  - Buttons: **Allow once** and **Deny**.
- **Unanswered approvals** are denied after 10 minutes, and the agent is told so.
- **Only devices with the `approve` scope** see approval cards. The laptop's desktop UI can always answer.
- Approve and deny are written to the audit log.

### 4.2 Chat UI (PR 9)

- The session reader gets a message box at the bottom. Sending queues a resume run; replies stream in as messages. A run already in progress shows "Working… · Stop".
- Approval cards appear inline in the conversation and on a "Needs you" list in the header, with a count.
- When it reconnects, the phone re-fetches active runs and pending approvals. The event stream must recover from the phone sleeping.

### 4.3 Codex and Qwen Code in phase 3

Their headless modes don't offer a way to send approvals to another program that ContextDeck can rely on: Codex `exec` can't answer approval prompts, and Qwen Code's headless approval behaviour isn't documented. Keep them to Plan only and Edit this folder, and say so in the UI ("Codex can't ask for approval here. Choose Plan only or Edit this folder.").

File an investigation issue for each:
- Codex: does `codex app-server` or Codex's MCP server mode support approval callbacks?
- Qwen Code: does `--input-format stream-json` carry permission requests?

Don't build either without the maintainer's go-ahead.

### 4.4 Notifications (later, optional, needs a decision)

Push notifications ("Codex needs approval") would mean a service worker plus Web Push. Web Push messages travel through Google's or Apple's push services: encrypted, but still a third party. That conflicts with "local only", so it needs the maintainer's explicit decision and an opt-in setting. Until then, the "Needs you" count and an optional sound while the page is open are enough.

### 4.5 Phase 3 is done when

- From the phone, you can chat with a Claude Code session in default mode.
- When it wants to run `npm test`, an approval card appears; Allow lets it run, and Deny makes the agent change course.
- An unanswered approval is denied after the time limit.
- A device without `approve` never sees approval cards.

---

## 5. Threat model

| Threat | Defence |
|---|---|
| Someone on the internet | Nothing listens publicly. `127.0.0.1` only, Serve is tailnet-only, and ContextDeck refuses to run if Funnel is on for its port |
| Another device or user on the tailnet | Pairing needs a one-time code from the QR code **and** approval on the laptop. Each device is tied to its Tailscale login. Scopes are minimal by default |
| A photographed QR code | The code expires after 5 minutes and works once, and the laptop must approve the device, showing its name and login |
| A stolen phone | Revoke from the laptop (`contextdeck phone revoke`). Devices expire after 30 idle days. The phone holds no sessions, only a cookie |
| A stolen cookie | Useless from a different Tailscale login. HttpOnly, Secure, SameSite=Strict |
| A malicious web page open on the laptop (DNS rebinding, CSRF) | The Host allow-list, Origin checks and write token stay as today. The tailnet name isn't attacker-controlled DNS |
| A malicious web page open on the phone | No CORS, SameSite=Strict cookies, write token plus Origin required |
| A phone request starting a dangerous agent mode | A fixed table of allowed flags, a forbidden-flags test, and the folder-trust rule |
| A repository's hooks or MCP config running unexpectedly in `-p` mode | Runs only in folders where that tool has already run interactively |
| Secrets in run output | Run logs go through `redact()`; the audit log holds no content |
| A program on the laptop forging headers | Out of scope, and stated in SECURITY.md; it could already read every session folder |

---

## 6. PR breakdown

| PR | Contents | Depends on | Size |
|---|---|---|---|
| 1 | Request context, Host and Origin for phone mode, behind a flag no one can set yet | — | S |
| 2 | Devices store, pairing, approval, cookie auth, scope table, audit log | 1 | L |
| 3 | `src/tailscale.ts`, `ui --phone`, `phone devices/revoke`, vendored QR, terminal QR | 2 | M |
| 4 | Phone UI: list-first layout, scope-aware controls, desktop pairing and device list, manifest; docs and SECURITY | 3 | M |
| 5 | Headless drivers for the three adapters, fake agents, forbidden-flags test | 4 | M |
| 6 | RunManager, run routes, run logs, keep-awake, single-session reindex | 5 | L |
| 7 | Phone and desktop run UI, mode picker, status chips | 6 | M |
| 8 | Approver MCP server and local channel, approval routes, Claude Code approvals | 7 | L |
| 9 | Chat UI, "Needs you", reconnection | 8 | M |

Stop after PR 4 and ask the maintainer whether to continue. Phase 1 should be used for a while before phase 2 starts.

---

## 7. Configuration

New keys in `~/.contextdeck/config.json`, sanitised like the existing ones:

```json
{
  "phone": {
    "deviceIdleDays": 30,
    "maxDevices": 10,
    "runTimeoutMinutes": 30,
    "maxConcurrentRuns": 3,
    "approvalTimeoutMinutes": 10
  }
}
```

There's no setting to turn phone mode on permanently: it's on only while `contextdeck ui --phone` runs.

---

## 8. Documentation to update

- `README.md`: a "Use it from your phone" section (needs Tailscale, the steps, what a phone can and can't do, how to revoke).
- `SECURITY.md`: the threat model above, the cookie and pairing design, the audit log, and the out-of-scope boundary.
- `docs/ARCHITECTURE.md`: request contexts, scopes, RunManager, the adapter `headless` capability.
- `docs/WRITING_AN_ADAPTER.md`: how to add `headless`, and the forbidden-modes rule.
- `CHANGELOG.md`: one entry per phase.
- `docs/ROADMAP.md`: tick items off, and add the Codex and Qwen Code approval investigations.

---

## 9. Questions for the maintainer before PR 2

1. Default phone scopes: is `view` plus `decide` right, or should new phones be `view` only?
2. Device expiry: 30 days idle?
3. Should pairing also be possible from the terminal (approve with a `y` keypress), or only in the desktop UI as planned?
4. Is it acceptable to vendor Nayuki's QR generator (MIT)?
5. Phase 3 notifications: keep them out for now, as planned?
