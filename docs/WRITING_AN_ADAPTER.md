# Writing an adapter

Adding a new coding agent (Gemini CLI, OpenCode, Cursor, Aider, …) is usually one source file, one fixture folder and one test file. This walkthrough uses a made-up tool called **Acme Agent** that stores sessions at `~/.acme/chats/<id>.jsonl`.

## 1. Learn the format

Before writing code, look at a few real session files from the tool:

- Where do they live? Is there an env var that moves them?
- One file per session? JSONL, JSON, SQLite?
- Which fields give you: session id, cwd, git branch, model, timestamps, user text, assistant text, tool calls, token usage?
- What does the tool inject that *isn't* a real prompt (system context, environment blocks)? Those must not become titles.
- How do you resume a session from the command line?

Write down what you find in the header comment of your adapter; the next contributor will thank you.

If the tool is open source, read where it writes sessions instead of guessing from samples. [`src/adapters/qwen-code.ts`](../src/adapters/qwen-code.ts) was written that way, from Qwen Code's `chatRecordingService.ts`, and its header says which file each rule comes from. It's also the shortest real adapter to copy from.

## 2. Create the adapter

`src/adapters/acme.ts`:

```ts
import { basename, join } from 'node:path';
import { emptySession, type ParseResult, type SessionRow } from '../schema.js';
import { listFiles, readJsonl } from '../util/jsonl.js';
import { asNumber, asString, clean, titleFrom, trackTime } from '../util/text.js';
import type { Adapter } from './types.js';

async function parse(filePath: string): Promise<ParseResult> {
  const s = emptySession('acme', basename(filePath, '.jsonl'));
  let badLines = 0;
  let seq = 0;
  let firstPrompt: string | null = null;

  for await (const line of readJsonl(filePath)) {
    if (!line.ok) { badLines++; continue; }           // never throw on bad lines
    const o = line.value as Record<string, unknown>;
    trackTime(s, o.time);
    s.cwd ??= asString(o.cwd);

    if (o.kind === 'prompt' && typeof o.text === 'string') {
      s.userTurns++;
      firstPrompt ??= o.text;
      s.messages.push({ seq: seq++, role: 'user', ts: asString(o.time), text: clean(o.text) });
    }
    if (o.kind === 'reply' && typeof o.text === 'string') {
      s.assistantTurns++;
      s.tokensOut += asNumber(o.outputTokens);
      s.messages.push({ seq: seq++, role: 'assistant', ts: asString(o.time), text: clean(o.text) });
    }
  }

  s.title = titleFrom(firstPrompt ?? '') || '(untitled session)';
  if (s.messages.length === 0) return { session: null, badLines, warnings: ['no conversation found'] };
  return { session: s, badLines, warnings: [] };
}

export const acmeAdapter: Adapter = {
  id: 'acme',
  label: 'Acme Agent',
  shortPrefix: 'ac',                       // must be unique: ids look like ac:1a2b3c4d
  envVar: 'CONTEXTDECK_ACME_DIR',
  defaultRoot: (env, home) => env.CONTEXTDECK_ACME_DIR ?? env.ACME_HOME ?? join(home, '.acme'),
  discover: (root) => listFiles(join(root, 'chats'), (rel) => rel.endsWith('.jsonl')),
  parse,
  resumeCommand: (session: SessionRow) => ({
    command: 'acme',
    args: ['--resume', session.nativeId],
    cwd: session.cwd,
    display: `acme --resume ${session.nativeId}`,
  }),
};
```

The helpers do the important safety work for you:

| Helper | Use it for |
|---|---|
| `readJsonl(path)` | Streaming lines (handles `.zst`). For a JSON or SQLite format, read it your own way but keep memory bounded. |
| `clean(text, max?)` | **Every** string you store: redacts secrets and truncates. |
| `titleFrom(text)` | First meaningful line, redacted, ≤100 chars. |
| `trackTime(s, ts)` | Keeps `startedAt`/`updatedAt` as the min/max timestamps. |
| `filesFromPatch(text)` | Files named in `*** Update File:` style patches. |
| `textFromContent(content)` | Text from a string or an array of `{type, text}` blocks. |

## 3. Register it

Add it to `ADAPTERS` in `src/adapters/index.ts`, and add a `--acme-dir` flag in `src/config.ts` and `src/cli.ts` if you want a CLI override (the env var works without one).

## 4. Add fixtures

Create `fixtures/acme/chats/…` with **synthetic** sessions that mirror the real layout. Cover:

- a normal session,
- the injected/noise messages the tool adds,
- one malformed line,
- an older format version, if the tool has changed format before.

Never copy a real transcript in, even "just to start". Rewrite it.

## 5. Test it

`test/acme.test.ts`, modelled on `test/codex.test.ts`: discovery, metadata, turn counts, tokens, files touched, title choice, resume command. Then update the counts in `test/store.test.ts` and `test/cli.test.ts` if your fixtures add sessions.

```bash
npm test
node bin/contextdeck.js --home .demo index && node bin/contextdeck.js --home .demo list
```

## 6. Checklist for the PR

- [ ] Header comment documents the layout and line types
- [ ] Every stored string goes through `clean()`
- [ ] Malformed lines counted, not thrown
- [ ] Injected context never becomes the title
- [ ] Never writes to the tool's folders, never uses the network
- [ ] Synthetic fixtures only
- [ ] README "Where it looks" table updated
