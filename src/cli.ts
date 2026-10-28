import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { getAdapter } from './adapters/index.js';
import { loadConfig, type Config } from './config.js';
import { ago, bytes, c, contextUsage, indent, providerLabel, table, tokens } from './format.js';
import { indexSources, watchSources, type IndexSummary } from './indexer.js';
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
  index               Scan Claude Code and Codex session files into the local index
  list                Recent sessions across every tool
  search <query>      Full-text search across every session ("quoted phrase", prefix*)
  show <id>           Session details, files touched and the last messages
  resume <id>         Print (or --run) the command that reopens a session in its own tool
  related <id>        Sessions in any tool that touched the same files
  projects            Sessions grouped by working directory, across tools
  watch               Keep the index up to date as you work
  stats               What's in the index
  doctor              Check paths, Node features and parse errors

${c.bold('Common options')}
  -p, --provider <id>   Only this tool: claude-code (cc) or codex (cx)
      --project <name>  Only sessions in this project (folder name or full path)
  -n, --limit <n>       How many results (default 30)
      --json            Machine-readable output (stable; this is what the UI will use)
      --all             Include subagent sessions in lists

${c.bold('Paths')} (flag > env var > default)
      --home <dir>        Index location       CONTEXTDECK_HOME        ~/.contextdeck
      --claude-dir <dir>  Claude Code dir      CONTEXTDECK_CLAUDE_DIR  $CLAUDE_CONFIG_DIR or ~/.claude
      --codex-dir <dir>   Codex dir            CONTEXTDECK_CODEX_DIR   $CODEX_HOME or ~/.codex

${c.bold('Examples')}
  contextdeck index
  contextdeck search "rate limit" --provider codex
  contextdeck show cc:1a2b3c4d
  contextdeck resume cx:9f8e7d6c --run

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
  home: { type: 'string' },
  'claude-dir': { type: 'string' },
  'codex-dir': { type: 'string' },
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
  print(!!v.json, sum, () => {
    const lines = [summaryLine(sum)];
    for (const e of sum.errors.slice(0, 5)) lines.push(c.red(`  ✗ ${e.path}\n    ${e.error}`));
    if (sum.errors.length > 5) lines.push(c.dim(`  …and ${sum.errors.length - 5} more (see \`contextdeck doctor\`)`));
    return lines.join('\n');
  });
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

function cmdSearch(store: Store, v: Values, args: string[]): void {
  const query = args.join(' ').trim();
  if (!query) throw new UsageError('Usage: contextdeck search <query>');
  const hits = store.search(query, {
    provider: v.provider,
    project: v.project,
    limit: intOpt(v.limit, 20, 'limit'),
    raw: v.raw,
  });
  print(!!v.json, hits, () => {
    if (hits.length === 0) return c.dim(`No matches for ${JSON.stringify(query)}.`);
    return hits
      .map((h) => {
        const s = h.session;
        const head = `${c.bold(s.shortId)}  ${providerLabel(s.provider)}  ${s.project ?? '—'}  ${c.dim(ago(s.updatedAt))}  ${s.title}`;
        const snippet = h.snippet.replace(/«/g, useHighlight('[')).replace(/»/g, useHighlight(']', true));
        return `${head}\n${c.dim(`  ${h.role} · ${h.hits} hit${h.hits === 1 ? '' : 's'}:`)} ${snippet}`;
      })
      .join('\n\n');
  });
}

function useHighlight(fallback: string, close = false): string {
  if (!(process.stdout.isTTY && !process.env.NO_COLOR)) return fallback;
  return close ? '\x1b[22;39m' : '\x1b[1;33m';
}

function cmdShow(store: Store, v: Values, args: string[]): void {
  const ref = args[0];
  if (!ref) throw new UsageError('Usage: contextdeck show <id>');
  const s = store.resolve(ref);
  const last = intOpt(v.messages, 12, 'messages');
  const messages = store.messages(s.id, { last, roles: v.all ? undefined : ['user', 'assistant'] });
  const files = store.filesTouched(s.id);
  const resume = getAdapter(s.provider)?.resumeCommand(s);

  print(!!v.json, { session: s, filesTouched: files, messages, resume }, () => {
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
    if (resume) out.push(c.bold('Resume'), `  ${resume.display}`);
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

  if (!v.run) {
    print(!!v.json, cmd, () => cmd.display);
    return;
  }
  const cwd = cmd.cwd && existsSync(cmd.cwd) ? cmd.cwd : process.cwd();
  if (cmd.cwd && cwd !== cmd.cwd) process.stderr.write(c.yellow(`Note: ${cmd.cwd} no longer exists; running here.\n`));
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(cmd.command, cmd.args, { cwd, stdio: 'inherit' });
    child.on('error', (err) =>
      reject(
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? new Error(`\`${cmd.command}\` is not installed or not on your PATH.`)
          : err,
      ),
    );
    child.on('exit', (code) => {
      process.exitCode = code ?? 0;
      resolveRun();
    });
  });
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
  const report = { node: process.version, fts5, zstd: zstdSupported(), dbPath: cfg.dbPath, sources, stats: st, errors };

  print(!!v.json, report, () => {
    const ok = (b: boolean) => (b ? c.green('✓') : c.red('✗'));
    const lines = [
      `${ok(true)} Node ${process.version}`,
      `${ok(fts5)} SQLite full-text search (FTS5)`,
      `${ok(zstdSupported())} zstd support ${c.dim('(compressed Codex sessions; needs Node 22.15+)')}`,
      `${ok(true)} Index: ${cfg.dbPath} ${c.dim(`(${bytes(st.dbBytes)}, ${st.sessions} sessions)`)}`,
      '',
      ...sources.map(
        (s) =>
          `${ok(s.exists)} ${s.label.padEnd(12)} ${s.root} ${c.dim(
            s.exists ? `(${s.files} session files)` : `(not found — set ${s.envVar} or --${s.provider === 'codex' ? 'codex' : 'claude'}-dir)`,
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

  const cfg = loadConfig({ home: v.home, claudeDir: v['claude-dir'], codexDir: v['codex-dir'] });
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
        cmdSearch(store, v, args);
        break;
      case 'show':
        cmdShow(store, v, args);
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
