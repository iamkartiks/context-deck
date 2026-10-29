import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { getAdapter } from './adapters/index.js';
import { loadConfig, type Config } from './config.js';
import { ago, bytes, c, contextUsage, indent, providerLabel, table, tokens } from './format.js';
import { indexSources, watchSources, type IndexSummary } from './indexer.js';
import { openBrowser, startUiServer } from './server.js';
import { adapterByPrefix } from './adapters/index.js';
import { decisionMatches, loadDecisions, resolveDecisions, type ResolvedDecision } from './decisions.js';
import { buildBrief, saveBrief, startLaunch } from './handoff.js';
import { MeaningService, type MeaningStatus } from './meaning.js';
import type { Progress } from './semantic.js';
import { DEFAULT_MODEL, type SemanticSettings } from './settings.js';
import { commandText, findTerminal, runHere } from './platform.js';
import type { SessionRow } from './schema.js';
import { Store } from './store.js';
import { zstdSupported } from './util/jsonl.js';

const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    return String(pkg.version);
  } catch {
    return 'dev';
  }
})();

const HELP = `${c.bold('contextdeck')} ${VERSION} — one local index for all your AI coding agent sessions

${c.bold('Usage')}
  contextdeck <command> [options]

${c.bold('Commands')}
  index               Scan Claude Code, Codex and Qwen Code session files into the local index
  list                Recent sessions across every tool
  search <query>      Full-text search across every session ("quoted phrase", prefix*)
  decisions [query]   Decisions you marked, across every tool (mark them in the canvas)
  semantic [status|enable|disable]
                      Search by meaning with a local embedding model (off until you enable it)
  show <id>           Session details, files touched and the last messages
  resume <id>         Print (or --run) the command that reopens a session in its own tool
  handoff <id>        Continue a session's work in a new session, in any tool
  related <id>        Sessions in any tool that touched the same files
  projects            Sessions grouped by working directory, across tools
  ui                  Open the visual canvas in your browser (local only)
  watch               Keep the index up to date as you work
  stats               What's in the index
  doctor              Check paths, Node features and parse errors

${c.bold('Common options')}
  -p, --provider <id>   Only this tool: claude-code (cc), codex (cx) or qwen-code (qw)
      --project <name>  Only sessions in this project (folder name or full path)
  -n, --limit <n>       How many results (default 30)
      --json            Machine-readable output (stable; this is what the UI will use)
      --all             Include subagent sessions in lists

${c.bold('Paths')} (flag > env var > default)
      --home <dir>        Index location       CONTEXTDECK_HOME        ~/.contextdeck
      --claude-dir <dir>  Claude Code dir      CONTEXTDECK_CLAUDE_DIR  $CLAUDE_CONFIG_DIR or ~/.claude
      --codex-dir <dir>   Codex dir            CONTEXTDECK_CODEX_DIR   $CODEX_HOME or ~/.codex
      --qwen-dir <dir>    Qwen Code dir        CONTEXTDECK_QWEN_DIR    $QWEN_RUNTIME_DIR, $QWEN_HOME or ~/.qwen

${c.bold('Search by meaning')} (contextdeck semantic enable …)
      --model <name>      Embedding model (default ${DEFAULT_MODEL}; for English only, embeddinggemma or nomic-embed-text)
      --api <kind>        ollama (default) or openai, for LM Studio, llama.cpp's server, vLLM
      --url <address>     Where the model server listens (default http://127.0.0.1:11434)
      --dims <n>          Keep the first n numbers of each vector (default 512; 0 keeps all)
      --allow-remote      Allow a server on another computer. Session text is sent to it.
      --min-score <0-1>   Lowest score a match by meaning needs ("auto" = the model's default).
                          npm run eval:meaning suggests one for your model
      --drop              With disable: also delete stored vectors
      --words             With search: words only, skip meaning

${c.bold('Handoff options')}
  -t, --to <tool>       Tool to continue in: codex (cx), claude-code (cc) or qwen-code (qw).
                        Default: Codex, or Claude Code when handing off from Codex
      --print           Only print the brief
      --run             Start the new session right here in this terminal
      --no-check-in     Let the new agent carry on without checking in first

${c.bold('UI options')}
      --port <n>        Port for \`ui\` (default 4977; the next free one is used if taken)
      --no-open         Don't open the browser automatically

${c.bold('Examples')}
  contextdeck ui
  contextdeck index
  contextdeck search "rate limit" --provider codex
  contextdeck show cc:1a2b3c4d
  contextdeck resume cx:9f8e7d6c --run
  contextdeck handoff cc:1a2b3c4d --to codex --run

Everything stays on this machine. Session files are only ever read, never changed.
`;

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  json: { type: 'boolean' },
  all: { type: 'boolean' },
  full: { type: 'boolean' },
  raw: { type: 'boolean' },
  run: { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  provider: { type: 'string', short: 'p' },
  project: { type: 'string' },
  limit: { type: 'string', short: 'n' },
  messages: { type: 'string', short: 'm' },
  port: { type: 'string' },
  'no-open': { type: 'boolean' },
  to: { type: 'string', short: 't' },
  print: { type: 'boolean' },
  'no-check-in': { type: 'boolean' },
  home: { type: 'string' },
  'claude-dir': { type: 'string' },
  'codex-dir': { type: 'string' },
  'qwen-dir': { type: 'string' },
  model: { type: 'string' },
  api: { type: 'string' },
  url: { type: 'string' },
  dims: { type: 'string' },
  'allow-remote': { type: 'boolean' },
  drop: { type: 'boolean' },
  words: { type: 'boolean' },
  'min-score': { type: 'string' },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

class UsageError extends Error {}

function intOpt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--${name} must be a positive whole number`);
  return n;
}

function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}

function print(json: boolean, data: unknown, human: () => string): void {
  if (json) process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  else process.stdout.write(human() + '\n');
}

function sessionTable(rows: SessionRow[]): string {
  if (rows.length === 0) return c.dim('No sessions. Run `contextdeck index` first, or check `contextdeck doctor`.');
  return table(
    [
      { header: 'ID' },
      { header: 'TOOL' },
      { header: 'PROJECT' },
      { header: 'UPDATED' },
      { header: 'TURNS', align: 'right' },
      { header: 'CONTEXT', align: 'right' },
      { header: 'TITLE' },
    ],
    rows.map((s) => [
      c.bold(s.shortId),
      providerLabel(s.provider),
      s.project ?? '—',
      ago(s.updatedAt),
      String(s.userTurns),
      contextUsage(s),
      (s.isSubagent ? c.dim('↳ ') : '') + s.title,
    ]),
  );
}

function summaryLine(sum: IndexSummary): string {
  const parts = [
    `${sum.indexed} indexed`,
    `${sum.unchanged} unchanged`,
    sum.removed ? `${sum.removed} removed` : '',
    sum.empty ? `${sum.empty} without conversation` : '',
    sum.failed ? c.red(`${sum.failed} failed`) : '',
    sum.badLines ? c.yellow(`${sum.badLines} malformed lines skipped`) : '',
  ].filter(Boolean);
  return `${parts.join(', ')} ${c.dim(`(${sum.scanned} files, ${(sum.ms / 1000).toFixed(1)}s)`)}`;
}

// ── commands ───────────────────────────────────────────────────────────────

async function cmdIndex(cfg: Config, store: Store, v: Values): Promise<void> {
  const tty = process.stderr.isTTY && !v.quiet && !v.json;
  const sum = await indexSources(store, cfg.sources, {
    full: v.full,
    onFile: tty
      ? (path, done, total) => {
          if (done % 25 === 0 || done === total) process.stderr.write(`\r${c.dim(`scanning ${done}/${total}…`)}   `);
        }
      : undefined,
  });
  if (tty) process.stderr.write('\r\x1b[K');
  // Search by meaning, if it's on: embed what's new (stop any time with Ctrl+C)
  const meaning = new MeaningService(store, cfg.home);
  let meaningLine = '';
  if (meaning.enabled && !v.words) {
    const ctrl = new AbortController();
    const onInt = () => ctrl.abort();
    process.once('SIGINT', onInt);
    try {
      const r = await meaning.run(tty ? (p) => process.stderr.write(`\r${c.dim(progressText(p))}   `) : undefined, ctrl.signal);
      if (tty) process.stderr.write('\r\x1b[K');
      if (r.pieces || r.stopped) {
        meaningLine = c.dim(`Search by meaning: ${r.stopped ? 'paused' : 'up to date'}, ${plural(r.pieces, 'piece')} from ${plural(r.sessions, 'session')} added${r.stopped ? '; carries on next time' : ''}.`);
      }
    } catch (err) {
      if (tty) process.stderr.write('\r\x1b[K');
      meaningLine = c.yellow(`Search by meaning skipped: ${(err as Error).message}`);
    } finally {
      process.off('SIGINT', onInt);
    }
  }
  print(!!v.json, sum, () => {
    const lines = [summaryLine(sum)];
    for (const e of sum.errors.slice(0, 5)) lines.push(c.red(`  ✗ ${e.path}\n    ${e.error}`));
    if (sum.errors.length > 5) lines.push(c.dim(`  …and ${sum.errors.length - 5} more (see \`contextdeck doctor\`)`));
    if (meaningLine) lines.push(meaningLine);
    return lines.join('\n');
  });
}

function progressText(p: Progress): string {
  return p.sessionsTotal ? `embedding: ${p.sessionsDone}/${p.sessionsTotal} sessions, ${p.pieces} pieces…` : 'embedding…';
}

function meaningSummary(st: MeaningStatus): string {
  if (!st.enabled) return `${c.bold('Search by meaning: off.')} Turn it on once you have a local embedding model:\n  ollama pull ${DEFAULT_MODEL}\n  contextdeck semantic enable`;
  const where = `${st.model} ${c.dim(`via ${st.api === 'ollama' ? 'Ollama' : 'OpenAI-compatible API'} at ${st.url}${st.dims ? `, ${st.dims} dims` : ''}, cutoff ${st.minScore}`)}`;
  const lines = [`${c.bold('Search by meaning: on.')} ${where}`, `  ${plural(st.pieces, 'piece')} from ${plural(st.sessions, 'session')} ${c.dim(`(${bytes(st.bytes)} of vectors)`)}`];
  if (st.error) lines.push(c.yellow(`  Last problem: ${st.error}`));
  return lines.join('\n');
}

async function cmdSemantic(cfg: Config, store: Store, v: Values, args: string[]): Promise<void> {
  const sub = args[0] ?? 'status';
  const meaning = new MeaningService(store, cfg.home);
  if (sub === 'status') {
    const st = meaning.status();
    print(!!v.json, st, () => meaningSummary(st));
    return;
  }
  if (sub === 'disable' || sub === 'off') {
    const st = meaning.disable({ drop: v.drop });
    print(!!v.json, st, () => `Search by meaning is off.${v.drop ? ' Stored vectors deleted.' : ' Vectors are kept; `--drop` deletes them.'}`);
    return;
  }
  if (sub !== 'enable' && sub !== 'on') throw new UsageError('Usage: contextdeck semantic [status | enable | disable]');

  const input: Partial<SemanticSettings> = {};
  if (v.api !== undefined) {
    if (v.api !== 'ollama' && v.api !== 'openai') throw new UsageError('--api must be ollama or openai');
    input.api = v.api;
  }
  if (v.url !== undefined) input.url = v.url.replace(/\/+$/, '');
  if (v.model !== undefined) input.model = v.model;
  if (v.dims !== undefined) {
    const n = Number(v.dims);
    if (!Number.isInteger(n) || n < 0 || n > 8192) throw new UsageError('--dims must be 0 (keep all) or a whole number up to 8192');
    input.dims = n;
  }
  if (v['allow-remote']) input.allowRemote = true;
  if (v['min-score'] !== undefined) {
    if (v['min-score'] === 'auto') input.minScore = null;
    else {
      const n = Number(v['min-score']);
      if (!Number.isFinite(n) || n < 0 || n > 1) throw new UsageError('--min-score must be a number from 0 to 1, or "auto"');
      input.minScore = n;
    }
  }

  if (!v.json) process.stderr.write(c.dim('Checking the model answers…\n'));
  // The CLI catches up in the foreground instead, below, so progress can be shown
  const st = await meaning.enable(input, { background: false });
  if (!v.json) process.stdout.write(`${c.green('✓')} Search by meaning is on: ${st.model} ${c.dim(`at ${st.url}`)}\n`);

  const tty = process.stderr.isTTY && !v.json;
  const ctrl = new AbortController();
  const onInt = () => ctrl.abort();
  process.once('SIGINT', onInt);
  try {
    if (!v.json) process.stdout.write(c.dim('Embedding your sessions, newest first. Ctrl+C stops; it carries on next time you index or open the canvas.\n'));
    const r = await meaning.run(tty ? (p) => process.stderr.write(`\r${c.dim(progressText(p))}   `) : undefined, ctrl.signal);
    if (tty) process.stderr.write('\r\x1b[K');
    print(!!v.json, { ...meaning.status(), added: r }, () =>
      r.stopped
        ? `Paused after ${plural(r.sessions, 'session')}. Search by meaning already covers them.`
        : `${c.green('✓')} Done: ${plural(r.pieces, 'piece')} from ${plural(r.sessions, 'session')}. Try: contextdeck search "which chat decided on the database"`,
    );
  } finally {
    process.off('SIGINT', onInt);
  }
}

function cmdList(store: Store, v: Values): void {
  const rows = store.listSessions({
    provider: v.provider,
    project: v.project,
    includeSubagents: v.all,
    limit: intOpt(v.limit, 30, 'limit'),
  });
  print(!!v.json, rows, () => sessionTable(rows));
}

function decisionLine(d: ResolvedDecision): string {
  const s = d.session;
  const where = s ? `${c.bold(s.shortId)}  ${providerLabel(s.provider)}  ${s.project ?? '—'}  ${c.dim(ago(d.createdAt))}` : c.dim('(session no longer indexed)');
  const text = d.text.replace(/\n+/g, ' ');
  return `${c.green('◆')} ${text}\n  ${where}${d.anchored ? '' : c.dim('  · message no longer found; your words are kept')}`;
}

function cmdDecisions(cfg: Config, store: Store, v: Values, args: string[]): void {
  const query = args.join(' ').trim();
  const project = v.project;
  const provider = v.provider ? (adapterByPrefix(v.provider)?.id ?? v.provider) : null;
  const all = resolveDecisions(store, loadDecisions(cfg.home).decisions).filter(
    (d) =>
      (!query || decisionMatches(d, query)) &&
      (!project || d.session?.project === project || d.session?.cwd === project) &&
      (!provider || d.session?.provider === provider),
  );
  const rows = all.slice(0, intOpt(v.limit, 50, 'limit'));
  print(
    !!v.json,
    rows.map(({ session, ...d }) => ({ ...d, session: session ? { id: session.id, shortId: session.shortId, title: session.title, provider: session.provider, project: session.project } : null })),
    () => {
      if (!rows.length) {
        return c.dim(
          query || project || provider
            ? 'No decisions match.'
            : 'No decisions yet. In the canvas (`contextdeck ui`), open a session and choose “Mark as decision” on the message that settled something.',
        );
      }
      return rows.map(decisionLine).join('\n\n');
    },
  );
}

async function cmdSearch(cfg: Config, store: Store, v: Values, args: string[]): Promise<void> {
  const query = args.join(' ').trim();
  if (!query) throw new UsageError('Usage: contextdeck search <query>');
  const limit = intOpt(v.limit, 20, 'limit');
  const words = store.search(query, { provider: v.provider, project: v.project, limit: 200, raw: v.raw });
  // Search by meaning joins in when it's on (and not --words / --raw)
  const meaning = new MeaningService(store, cfg.home);
  const found = v.words || v.raw ? null : await meaning.search(query, words, 200);
  if (found?.error && !v.json) process.stderr.write(c.yellow(`Search by meaning unavailable (${found.error}); showing word matches.\n`));
  const providerId = v.provider ? (adapterByPrefix(v.provider)?.id ?? v.provider) : null;
  const hits = (found?.hits ?? words.map((h) => ({ ...h, via: 'words' as const })))
    .filter((h) => (!providerId || h.session.provider === providerId) && (!v.project || h.session.project === v.project || h.session.cwd === v.project))
    .slice(0, limit);
  // JSON output stays a plain list of hits; `contextdeck decisions <query> --json` covers decisions
  const decisions = v.json ? [] : resolveDecisions(store, loadDecisions(cfg.home).decisions).filter((d) => decisionMatches(d, query));
  print(!!v.json, hits, () => {
    const head = decisions.length ? `${c.bold('Decisions')}\n${decisions.slice(0, 10).map(decisionLine).join('\n\n')}\n\n${c.bold('Messages')}\n` : '';
    if (hits.length === 0) return head + c.dim(`No messages match ${JSON.stringify(query)}.`);
    return head + hits
      .map((h) => {
        const s = h.session;
        const head = `${c.bold(s.shortId)}  ${providerLabel(s.provider)}  ${s.project ?? '—'}  ${c.dim(ago(s.updatedAt))}  ${s.title}`;
        const snippet = h.snippet.replace(/«/g, useHighlight('[')).replace(/»/g, useHighlight(']', true));
        const how = h.via === 'meaning' ? `${h.role} · ${c.cyan('by meaning')}` : `${h.role} · ${h.hits} hit${h.hits === 1 ? '' : 's'}${h.via === 'both' ? ' · and by meaning' : ''}`;
        return `${head}\n${c.dim(`  ${how}:`)} ${snippet}`;
      })
      .join('\n\n');
  });
}

function useHighlight(fallback: string, close = false): string {
  if (!(process.stdout.isTTY && !process.env.NO_COLOR)) return fallback;
  return close ? '\x1b[22;39m' : '\x1b[1;33m';
}

function cmdShow(cfg: Config, store: Store, v: Values, args: string[]): void {
  const ref = args[0];
  if (!ref) throw new UsageError('Usage: contextdeck show <id>');
  const s = store.resolve(ref);
  const last = intOpt(v.messages, 12, 'messages');
  const messages = store.messages(s.id, { last, roles: v.all ? undefined : ['user', 'assistant'] });
  const files = store.filesTouched(s.id);
  const resume = getAdapter(s.provider)?.resumeCommand(s);
  const decisions = resolveDecisions(
    store,
    loadDecisions(cfg.home).decisions.filter((d) => d.sessionId === s.id),
  ).sort((a, b) => a.seq - b.seq);

  print(!!v.json, { session: s, filesTouched: files, messages, resume, decisions: decisions.map(({ session: _s, ...d }) => d) }, () => {
    const meta: [string, string][] = [
      ['Tool', `${providerLabel(s.provider)}${s.cliVersion ? c.dim(` ${s.cliVersion}`) : ''}`],
      ['Id', s.id],
      ['Project', s.cwd ?? '—'],
      ['Branch', s.gitBranch ?? '—'],
      ['Model', s.model ?? '—'],
      ['When', `${s.startedAt ?? '?'} → ${s.updatedAt ?? '?'} ${c.dim(`(${ago(s.updatedAt)})`)}`],
      ['Turns', `${plural(s.userTurns, 'prompt')}, ${plural(s.assistantTurns, 'reply', 'replies')}, ${plural(s.toolCalls, 'tool call')}`],
      ['Tokens', `${tokens(s.tokensIn)} in, ${tokens(s.tokensOut)} out`],
      ['Context', `${contextUsage(s)}${s.compactions ? c.yellow(`, compacted ${s.compactions}×`) : ''}`],
    ];
    if (s.isSubagent) meta.push(['Parent', s.parentId ?? '—']);
    meta.push(['File', c.dim(s.sourcePath)]);

    const out = [c.bold(s.title), '', ...meta.map(([k, val]) => `${c.dim(k.padEnd(8))} ${val}`)];
    if (decisions.length) {
      out.push('', c.bold(`Decisions (${decisions.length})`));
      out.push(...decisions.map((d) => `  ${c.green('◆')} ${d.text.replace(/\n+/g, ' ')}`));
    }
    if (files.length) {
      out.push('', c.bold(`Files touched (${files.length})`));
      out.push(...files.slice(0, 15).map((f) => `  ${f}`));
      if (files.length > 15) out.push(c.dim(`  …and ${files.length - 15} more`));
    }
    if (messages.length) {
      out.push('', c.bold(`Last ${messages.length} messages`) + c.dim(v.all ? '' : ' (add --all for tool calls)'));
      for (const m of messages) {
        const who =
          m.role === 'user' ? c.green('you') : m.role === 'assistant' ? c.magenta('agent') : c.dim(m.toolName ?? m.role);
        const text = m.text.length > 600 ? m.text.slice(0, 599) + '…' : m.text;
        out.push(`${who} ${c.dim(ago(m.ts))}`, indent(text), '');
      }
    }
    if (resume) out.push(c.bold('Resume'), `  ${commandText({ cwd: resume.cwd, command: resume.command, args: resume.args }, process.platform)}`);
    return out.join('\n').trimEnd();
  });
}

async function cmdResume(store: Store, v: Values, args: string[]): Promise<void> {
  const ref = args[0];
  if (!ref) throw new UsageError('Usage: contextdeck resume <id> [--run]');
  const s = store.resolve(ref);
  const adapter = getAdapter(s.provider);
  if (!adapter) throw new Error(`No adapter for provider ${s.provider}`);
  const cmd = adapter.resumeCommand(s);

  const launch = { cwd: cmd.cwd, command: cmd.command, args: cmd.args };
  if (!v.run) {
    const line = commandText(launch, process.platform);
    print(!!v.json, { ...cmd, display: line }, () => line);
    return;
  }
  if (cmd.cwd && !existsSync(cmd.cwd)) process.stderr.write(c.yellow(`Note: ${cmd.cwd} no longer exists; running here.\n`));
  process.exitCode = await runHere(launch);
}

function cmdRelated(store: Store, v: Values, args: string[]): void {
  const ref = args[0];
  if (!ref) throw new UsageError('Usage: contextdeck related <id>');
  const s = store.resolve(ref);
  const rows = store.related(s.id, intOpt(v.limit, 10, 'limit'));
  print(!!v.json, { session: s, related: rows }, () => {
    if (rows.length === 0) return c.dim(`Nothing related to ${s.shortId} yet (no shared files or branch).`);
    const head = `${c.dim('Related to')} ${c.bold(s.shortId)} ${s.title}\n`;
    return (
      head +
      table(
        [{ header: 'ID' }, { header: 'TOOL' }, { header: 'UPDATED' }, { header: 'WHY' }, { header: 'TITLE' }],
        rows.map((r) => [
          c.bold(r.session.shortId),
          providerLabel(r.session.provider),
          ago(r.session.updatedAt),
          r.reason === 'shared-files'
            ? `${r.sharedFiles.length} shared file${r.sharedFiles.length === 1 ? '' : 's'}`
            : `same branch`,
          r.session.title,
        ]),
      )
    );
  });
}

function cmdProjects(store: Store, v: Values): void {
  const rows = store.projects(intOpt(v.limit, 30, 'limit'));
  print(!!v.json, rows, () => {
    if (rows.length === 0) return c.dim('No projects yet. Run `contextdeck index`.');
    return table(
      [
        { header: 'PROJECT' },
        { header: 'SESSIONS', align: 'right' },
        { header: 'TOOLS' },
        { header: 'ACTIVE' },
        { header: 'TOKENS', align: 'right' },
        { header: 'PATH' },
      ],
      rows.map((p) => [
        c.bold(p.project),
        String(p.sessions),
        p.providers.map(providerLabel).join(', '),
        ago(p.lastActive),
        tokens(p.tokens),
        c.dim(p.cwd),
      ]),
    );
  });
}

async function cmdWatch(cfg: Config, store: Store, v: Values): Promise<void> {
  const first = await indexSources(store, cfg.sources);
  // Keeps search by meaning current too, when it's on
  const meaning = new MeaningService(store, cfg.home);
  meaning.kick();
  if (!v.json) {
    process.stdout.write(`${summaryLine(first)}\n`);
    for (const src of cfg.sources) {
      process.stdout.write(c.dim(`watching ${src.adapter.label}: ${src.root}${existsSync(src.root) ? '' : ' (missing)'}\n`));
    }
    process.stdout.write(c.dim('Ctrl+C to stop.\n'));
  }
  const w = watchSources(
    store,
    cfg.sources,
    (sum) => {
      if (v.json) process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...sum }) + '\n');
      else process.stdout.write(`${c.dim(new Date().toLocaleTimeString())} ${summaryLine(sum)}\n`);
      if (sum.indexed || sum.removed) meaning.kick();
    },
    { onError: (err) => process.stderr.write(c.red(`watch error: ${String(err)}\n`)) },
  );
  await new Promise<void>((done) => {
    const stop = () => {
      w.close();
      done();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  meaning.stop();
  await meaning.idle();
}

async function cmdHandoff(cfg: Config, store: Store, v: Values, args: string[]): Promise<void> {
  const ref = args[0];
  if (!ref) throw new UsageError('Usage: contextdeck handoff <id> [--to codex|claude-code|qwen-code] [--print | --run]');
  const from = store.resolve(ref);
  const to = v.to ? adapterByPrefix(v.to)?.id : from.provider === 'codex' ? 'claude-code' : 'codex';
  const target = to ? getAdapter(to) : undefined;
  if (!to || !target?.startCommand) throw new UsageError(`Unknown tool "${v.to}". Use codex (cx), claude-code (cc) or qwen-code (qw).`);

  const brief = buildBrief(store, from.id, { to, checkIn: !v['no-check-in'], home: cfg.home });
  if (v.print) {
    process.stdout.write(brief.text);
    return;
  }
  const path = saveBrief(cfg.home, brief.handoffId, brief.text);
  const launch = startLaunch(target, from, path, brief.handoffId);
  const line = commandText(launch, process.platform);

  if (!v.run) {
    print(!!v.json, { handoffId: brief.handoffId, path, command: line, tokens: brief.tokens }, () =>
      [
        `${c.bold('Brief ready')} ${c.dim(`(${brief.handoffId}, about ${tokens(brief.tokens)} tokens)`)}`,
        `  ${path}`,
        '',
        `${c.bold(`Start it in ${target.label}`)} ${c.dim('(or run this command again with --run)')}`,
        `  ${line}`,
        '',
        c.dim(`Read or edit the brief first if you like. ContextDeck links the new session to ${from.shortId} once it starts.`),
      ].join('\n'),
    );
    return;
  }

  if (from.cwd && !launch.cwd) process.stderr.write(c.yellow(`Note: ${from.cwd} no longer exists; starting here.\n`));
  process.stderr.write(c.dim(`Starting ${target.label} with the brief (${brief.handoffId})…\n`));
  // macOS and Linux: pass the brief itself as one argument, with no shell involved.
  // Windows: the one-line pointer prompt from startLaunch().
  const start = target.startCommand()!;
  process.exitCode = await runHere(
    process.platform === 'win32' ? launch : { cwd: launch.cwd, command: start.command, args: [...start.args, brief.text] },
  );
}

async function cmdUi(cfg: Config, store: Store, v: Values): Promise<void> {
  let port = 4977;
  if (v.port !== undefined) {
    port = Number(v.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError('--port must be a number from 0 to 65535');
  }
  const tty = process.stdout.isTTY;
  if (tty) process.stdout.write(c.dim('Indexing…\r'));
  const first = await indexSources(store, cfg.sources);
  process.stdout.write((tty ? '\x1b[K' : '') + summaryLine(first) + '\n');

  const server = await startUiServer(store, cfg, { port, initialIndex: first });
  process.stdout.write(
    `\n${c.bold('ContextDeck is open at')} ${c.cyan(server.url)}\n` +
      c.dim('Only this computer can reach it. Keeps updating as your agents work. Ctrl+C to stop.\n'),
  );
  if (!v['no-open']) openBrowser(server.url);

  await new Promise<void>((done) => {
    const stop = () => {
      process.stdout.write(c.dim('\nStopping…\n'));
      server.close().then(done, done);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

function cmdStats(cfg: Config, store: Store, v: Values): void {
  const st = store.stats();
  print(!!v.json, { dbPath: cfg.dbPath, ...st }, () => {
    const lines = [
      `${c.bold(String(st.sessions))} sessions ${c.dim(`(+${st.subagents} subagent)`)}, ${st.messages} messages indexed`,
      ...st.byProvider.map(
        (p) =>
          `  ${providerLabel(p.provider).padEnd(22)} ${String(p.sessions).padStart(5)} sessions  ${tokens(p.tokens).padStart(6)} tokens  last ${ago(p.lastActive)}`,
      ),
      c.dim(`Index: ${cfg.dbPath} (${bytes(st.dbBytes)})`),
    ];
    if (st.filesWithErrors) lines.push(c.yellow(`${st.filesWithErrors} files failed to parse — run \`contextdeck doctor\``));
    return lines.join('\n');
  });
}

const DIR_FLAG: Record<string, string> = { 'claude-code': 'claude', codex: 'codex', 'qwen-code': 'qwen' };

async function cmdDoctor(cfg: Config, store: Store, v: Values): Promise<void> {
  let fts5 = false;
  try {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE VIRTUAL TABLE t USING fts5(x)');
    db.close();
    fts5 = true;
  } catch {
    /* reported below */
  }
  const sources = await Promise.all(
    cfg.sources.map(async (s) => ({
      provider: s.adapter.id,
      label: s.adapter.label,
      root: s.root,
      exists: existsSync(s.root),
      files: (await s.adapter.discover(s.root)).length,
      envVar: s.adapter.envVar,
    })),
  );
  const st = store.stats();
  const errors = store.fileErrors();
  const terminal = findTerminal();
  // If search by meaning is on, check the model answers right now
  const meaningService = new MeaningService(store, cfg.home);
  if (meaningService.enabled) await meaningService.check();
  const meaningStatus = meaningService.status();
  const report = {
    meaning: meaningStatus,
    node: process.version,
    platform: process.platform,
    fts5,
    zstd: zstdSupported(),
    terminal: terminal?.name ?? null,
    dbPath: cfg.dbPath,
    sources,
    stats: st,
    errors,
  };

  print(!!v.json, report, () => {
    const ok = (b: boolean) => (b ? c.green('✓') : c.red('✗'));
    const lines = [
      `${ok(true)} Node ${process.version}`,
      `${ok(fts5)} SQLite full-text search (FTS5)`,
      `${ok(zstdSupported())} zstd support ${c.dim('(compressed Codex sessions; needs Node 22.15+)')}`,
      `${ok(!!terminal)} Open in Terminal: ${
        terminal ? terminal.name : c.dim(process.platform === 'linux' ? 'no terminal app or graphical session found; copy commands instead' : 'not available')
      }`,
      `${ok(true)} Index: ${cfg.dbPath} ${c.dim(`(${bytes(st.dbBytes)}, ${st.sessions} sessions)`)}`,
      meaningStatus.enabled
        ? `${ok(!meaningStatus.error)} Search by meaning: ${meaningStatus.model} ${c.dim(`(${plural(meaningStatus.sessions, 'session')} embedded${meaningStatus.error ? `; ${meaningStatus.error}` : ''})`)}`
        : `${c.dim('–')} Search by meaning: off ${c.dim('(optional; `contextdeck semantic` explains how to turn it on)')}`,
      '',
      ...sources.map(
        (s) =>
          `${ok(s.exists)} ${s.label.padEnd(12)} ${s.root} ${c.dim(
            s.exists ? `(${s.files} session files)` : `(not found — set ${s.envVar} or --${DIR_FLAG[s.provider] ?? s.provider}-dir)`,
          )}`,
      ),
    ];
    if (st.badLines) lines.push('', c.yellow(`${st.badLines} malformed lines were skipped across all files.`));
    if (errors.length) {
      lines.push('', c.red(`${errors.length} files failed to parse:`));
      for (const e of errors) lines.push(`  ${e.path}\n    ${c.dim(e.error)}`);
      lines.push(c.dim('If a file failed because the format changed, please open an issue with a redacted sample.'));
    }
    return lines.join('\n');
  });
}

// ── entry ──────────────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    process.stderr.write(`${c.red((err as Error).message)}\nRun \`contextdeck --help\` for usage.\n`);
    return 2;
  }
  const { values: v, positionals } = parsed;
  const [command, ...args] = positionals;

  if (v.version) {
    process.stdout.write(VERSION + '\n');
    return 0;
  }
  if (v.help || !command || command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  const cfg = loadConfig({ home: v.home, claudeDir: v['claude-dir'], codexDir: v['codex-dir'], qwenDir: v['qwen-dir'] });
  let store: Store | null = null;
  try {
    store = new Store(cfg.dbPath);
    switch (command) {
      case 'index':
        await cmdIndex(cfg, store, v);
        break;
      case 'list':
      case 'ls':
        cmdList(store, v);
        break;
      case 'search':
      case 'find':
        await cmdSearch(cfg, store, v, args);
        break;
      case 'decisions':
        cmdDecisions(cfg, store, v, args);
        break;
      case 'semantic':
      case 'meaning':
        await cmdSemantic(cfg, store, v, args);
        break;
      case 'show':
        cmdShow(cfg, store, v, args);
        break;
      case 'handoff':
      case 'continue':
        await cmdHandoff(cfg, store, v, args);
        break;
      case 'resume':
        await cmdResume(store, v, args);
        break;
      case 'related':
        cmdRelated(store, v, args);
        break;
      case 'projects':
        cmdProjects(store, v);
        break;
      case 'watch':
        await cmdWatch(cfg, store, v);
        break;
      case 'ui':
      case 'open':
        await cmdUi(cfg, store, v);
        break;
      case 'stats':
        cmdStats(cfg, store, v);
        break;
      case 'doctor':
        await cmdDoctor(cfg, store, v);
        break;
      default:
        throw new UsageError(`Unknown command "${command}". Run \`contextdeck --help\`.`);
    }
    return typeof process.exitCode === 'number' ? process.exitCode : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(c.red(message) + '\n');
    return err instanceof UsageError ? 2 : 1;
  } finally {
    store?.close();
  }
}
