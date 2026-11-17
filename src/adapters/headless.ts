import type { SessionRow } from '../schema.js';
import type { Approver, HeadlessCommand, HeadlessDriver, RunEvent, RunMode } from './types.js';

/**
 * Headless drivers: how to run one turn of each tool without a terminal, and
 * how to read what it streams back. Used for runs started from a phone.
 *
 * Every mode is listed in a fixed table below. Nothing a request sends can add
 * an argument: the run manager picks a driver, a session (or folder) and one
 * of two modes, and the prompt goes on stdin. There is no way to ask for a
 * mode that skips permissions; test/headless.test.ts checks every combination
 * for flags that would (bypassPermissions, dontAsk, danger-full-access, yolo,
 * --dangerously-*, auto modes, --approve-for-me, --bare).
 *
 * The prompt goes on stdin, never in the arguments: briefs are long, and
 * arguments are visible to other programs (`ps`).
 *
 * Each tool's binary can be replaced with CONTEXTDECK_CLAUDE_BIN,
 * CONTEXTDECK_CODEX_BIN or CONTEXTDECK_QWEN_BIN (tests use fake agents).
 */

const MAX_SUMMARY = 200;
const MAX_RESULT = 4000;

function bin(envVar: string, fallback: string): string {
  const v = process.env[envVar];
  return v && v.trim() ? v : fallback;
}

/**
 * A session id as an argument. Ids come from files on disk, so one that
 * isn't a plain id (or starts with "-" and would read as a flag) is refused.
 */
function sessionId(session: SessionRow): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(session.nativeId)) throw new Error('This session’s id can’t be passed to its tool safely.');
  return session.nativeId;
}

/** A session's folder, which every continued run happens in. */
function folderOf(session: SessionRow): string {
  if (!session.cwd) throw new Error('This session didn’t record its project folder, so it can’t be continued here.');
  return session.cwd;
}

function oneLine(s: string, max = MAX_SUMMARY): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** A one-line summary of a tool call's input: the command, file, pattern or address it acts on. */
export function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return typeof input === 'string' ? oneLine(input) : '';
  const o = input as Record<string, unknown>;
  for (const key of ['command', 'cmd', 'file_path', 'absolute_path', 'path', 'notebook_path', 'pattern', 'url', 'query', 'description', 'prompt']) {
    const v = o[key];
    if (typeof v === 'string' && v.trim()) return oneLine(v);
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return oneLine(v.join(' '));
  }
  return '';
}

function parseJson(line: string): Record<string, unknown> | null {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown) => (Array.isArray(v) ? v : []);

/**
 * Claude Code's `--output-format stream-json --verbose --include-partial-messages`.
 * Qwen Code streams the same shape.
 *
 * - `system` / `init`: the session id.
 * - `stream_event`: partial output; reply text comes from `text_delta`s.
 * - `assistant`: whole messages; only their tool calls are used, since their
 *   text already arrived as deltas.
 * - `result`: the end, with any `permission_denials`, the final text and cost.
 */
export function parseClaudeStyleLine(line: string): RunEvent[] {
  const j = parseJson(line);
  if (!j) return [];
  try {
    switch (j.type) {
      case 'system':
        return j.subtype === 'init' && str(j.session_id) ? [{ type: 'session', nativeId: str(j.session_id) }] : [];
      case 'stream_event': {
        const ev = obj(j.event);
        if (ev.type === 'content_block_start' && obj(ev.content_block).type === 'text') return [{ type: 'text', delta: '', start: true }];
        const delta = obj(ev.delta);
        if (ev.type === 'content_block_delta' && delta.type === 'text_delta' && str(delta.text)) return [{ type: 'text', delta: str(delta.text) }];
        return [];
      }
      case 'assistant': {
        const out: RunEvent[] = [];
        for (const block of arr(obj(j.message).content)) {
          const b = obj(block);
          if (b.type === 'tool_use') out.push({ type: 'tool', name: str(b.name) || 'tool', summary: summarizeInput(b.input) });
        }
        return out;
      }
      case 'result': {
        const out: RunEvent[] = [];
        for (const d of arr(j.permission_denials)) {
          const x = obj(d);
          const what = summarizeInput(x.tool_input);
          out.push({ type: 'denied', tool: str(x.tool_name) || 'tool', reason: what ? `Not allowed in this mode: ${what}` : 'Not allowed in this mode' });
        }
        const ok = j.is_error !== true && (j.subtype === undefined || j.subtype === 'success');
        const summary = str(j.result) ? str(j.result).slice(0, MAX_RESULT) : ok ? undefined : str(j.subtype).replace(/_/g, ' ');
        const cost = typeof j.total_cost_usd === 'number' && Number.isFinite(j.total_cost_usd) ? j.total_cost_usd : undefined;
        out.push({ type: 'done', ok, ...(summary ? { summary } : {}), ...(cost !== undefined ? { costUsd: cost } : {}) });
        return out;
      }
      default:
        return [];
    }
  } catch {
    return [];
  }
}

/**
 * Codex's `exec --json` (JSONL, as of 0.167).
 *
 * - `thread.started`: the session id (`thread_id`).
 * - `item.started` / `item.completed`: commands, file changes, MCP tool calls,
 *   web searches and agent messages. A command the sandbox refused is
 *   `declined`.
 * - `turn.completed` / `turn.failed`, and a top-level `error`.
 */
export function parseCodexLine(line: string): RunEvent[] {
  const j = parseJson(line);
  if (!j) return [];
  try {
    switch (j.type) {
      case 'thread.started':
        return str(j.thread_id) ? [{ type: 'session', nativeId: str(j.thread_id) }] : [];
      case 'item.started': {
        const item = obj(j.item);
        if (item.type === 'command_execution') return [{ type: 'tool', name: 'shell', summary: oneLine(str(item.command)) }];
        if (item.type === 'mcp_tool_call') return [{ type: 'tool', name: [str(item.server), str(item.tool)].filter(Boolean).join('.') || 'mcp', summary: summarizeInput(item.arguments) }];
        if (item.type === 'web_search') return [{ type: 'tool', name: 'web_search', summary: oneLine(str(item.query)) }];
        return [];
      }
      case 'item.completed': {
        const item = obj(j.item);
        switch (item.type) {
          case 'agent_message':
            return str(item.text) ? [{ type: 'text', delta: str(item.text), start: true }] : [];
          case 'file_change': {
            const paths = arr(item.changes).map((c) => str(obj(c).path)).filter(Boolean);
            return [{ type: 'tool', name: 'edit', summary: oneLine(paths.join(', ')) }];
          }
          case 'command_execution':
            return item.status === 'declined' ? [{ type: 'denied', tool: 'shell', reason: `Not allowed in this mode: ${oneLine(str(item.command))}` }] : [];
          case 'error':
            return str(item.message) ? [{ type: 'error', message: oneLine(str(item.message), 1000) }] : [];
          default:
            return [];
        }
      }
      case 'turn.completed':
        return [{ type: 'done', ok: true }];
      case 'turn.failed': {
        const message = str(obj(j.error).message);
        return [{ type: 'done', ok: false, ...(message ? { summary: message.slice(0, MAX_RESULT) } : {}) }];
      }
      case 'error':
        return str(j.message) ? [{ type: 'error', message: oneLine(str(j.message), 1000) }] : [];
      default:
        return [];
    }
  } catch {
    return [];
  }
}

// ── The allowed modes, per tool ───────────────────────────────────────────

/**
 * Claude Code, checked against 2.1.326.
 * - `-p` reads the prompt from stdin.
 * - `--permission-prompts none`: anything that would ask is denied, and shows
 *   up in the result's `permission_denials`.
 * - Plan only: `--permission-mode plan`. Edit this folder: `acceptEdits`
 *   (file edits allowed; commands that would ask are denied).
 * - Never `--bare`: it skips the user's CLAUDE.md and hooks, and needs an API
 *   key instead of their login.
 * Note: a `-p` run loads the folder's hooks and `.mcp.json` without the
 * workspace trust dialog, which is why the run manager only runs in folders
 * where this tool already has sessions.
 */
const CLAUDE_MODE: Record<'plan' | 'edit', string> = { plan: 'plan', edit: 'acceptEdits' };
const claudeStream = ['--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

/**
 * How Claude Code decides what needs a person.
 * - Plan only / Edit this folder: anything that would ask is denied
 *   (`--permission-prompts none`).
 * - Ask me first: `--permission-mode manual` (2.1.326 has no "default"
 *   mode), and every request goes to ContextDeck's approver, an MCP tool
 *   (`--permission-prompt-tool`). `--permission-prompts` stays at its default,
 *   "host": with "none", the tool would never be asked.
 */
function claudePermissions(mode: RunMode, approver: Approver | undefined): string[] {
  if (mode !== 'ask') return ['--permission-mode', CLAUDE_MODE[mode], '--permission-prompts', 'none'];
  if (!approver) throw new Error('An “ask me first” run needs ContextDeck’s approver.');
  return ['--permission-mode', 'manual', '--mcp-config', approver.mcpConfig, '--permission-prompt-tool', approver.tool];
}

/** For tools that can't send permission requests anywhere. */
function noAsk(label: string, mode: RunMode): 'plan' | 'edit' {
  if (mode === 'ask') throw new Error(`${label} can’t ask for approval here. Choose Plan only or Edit this folder.`);
  return mode;
}

export const claudeCodeHeadless: HeadlessDriver = {
  testedWith: 'Claude Code 2.1.326',
  checksFolderTrust: false,
  supportsAsk: true,
  continueArgs(session, mode, approver): HeadlessCommand {
    return {
      command: bin('CONTEXTDECK_CLAUDE_BIN', 'claude'),
      args: ['-p', '--resume', sessionId(session), ...claudeStream, ...claudePermissions(mode, approver)],
      cwd: folderOf(session),
    };
  },
  startArgs(cwd, mode, approver): HeadlessCommand {
    return {
      command: bin('CONTEXTDECK_CLAUDE_BIN', 'claude'),
      args: ['-p', ...claudeStream, ...claudePermissions(mode, approver)],
      cwd,
    };
  },
  parseLine: parseClaudeStyleLine,
};

/**
 * Codex, checked against codex-cli 0.167.0.
 * - `-` reads the prompt from stdin.
 * - `exec resume` has no `--sandbox` or `--cd` option, and resumed turns have
 *   been reported to drop the sandbox, so the sandbox is always set through
 *   config (`-c sandbox_mode=…`) as well, and the run happens in the session's
 *   folder.
 * - `approval_policy="never"`: `exec` can't answer approval prompts, so
 *   anything the sandbox doesn't allow fails instead of waiting.
 * - Never `--dangerously-bypass-approvals-and-sandbox`, `--approve-for-me`,
 *   `danger-full-access` or `--skip-git-repo-check`.
 * - Folder trust: Codex loads a project's `.codex/config.toml` (sandbox, MCP,
 *   hooks) only for a trusted repository, and runs hooks only with persisted
 *   hook trust (`--dangerously-bypass-hook-trust` overrides that; never used).
 */
const CODEX_SANDBOX: Record<'plan' | 'edit', string> = { plan: 'read-only', edit: 'workspace-write' };
const codexConfig = (mode: 'plan' | 'edit') => ['-c', `sandbox_mode="${CODEX_SANDBOX[mode]}"`, '-c', 'approval_policy="never"'];

export const codexHeadless: HeadlessDriver = {
  testedWith: 'codex-cli 0.167.0',
  checksFolderTrust: true,
  // `exec` can't answer approval prompts (see docs/ROADMAP.md for the open question)
  supportsAsk: false,
  continueArgs(session, mode): HeadlessCommand {
    const m = noAsk('Codex', mode);
    return {
      command: bin('CONTEXTDECK_CODEX_BIN', 'codex'),
      args: ['exec', 'resume', '--json', ...codexConfig(m), sessionId(session), '-'],
      cwd: folderOf(session),
    };
  },
  startArgs(cwd, mode): HeadlessCommand {
    const m = noAsk('Codex', mode);
    return {
      command: bin('CONTEXTDECK_CODEX_BIN', 'codex'),
      args: ['exec', '--json', '--sandbox', CODEX_SANDBOX[m], '-C', cwd, ...codexConfig(m), '-'],
      cwd,
    };
  },
  parseLine: parseCodexLine,
};

/**
 * Qwen Code, checked against the published 0.28.0 package's option
 * definitions, not a real run (it isn't installed where this was written).
 * - With stdin piped and no `-p`, it reads the prompt from stdin and runs once.
 * - Plan only: `--approval-mode plan`. Edit this folder: `auto-edit`.
 * - Sessions belong to a folder, so the run happens in the session's folder.
 * - Never `yolo` or `auto`.
 * Caveat: if Qwen Code's own sandbox is turned on in its settings, it
 * restarts itself with the stdin text added as a `--prompt` argument.
 */
const QWEN_MODE: Record<'plan' | 'edit', string> = { plan: 'plan', edit: 'auto-edit' };
const qwenStream = ['--output-format', 'stream-json', '--include-partial-messages'];

export const qwenCodeHeadless: HeadlessDriver = {
  testedWith: 'Qwen Code 0.28.0 (options read from the package; not run)',
  checksFolderTrust: false,
  // How headless Qwen Code handles approvals isn't documented (see docs/ROADMAP.md)
  supportsAsk: false,
  continueArgs(session, mode): HeadlessCommand {
    return {
      command: bin('CONTEXTDECK_QWEN_BIN', 'qwen'),
      args: ['--resume', sessionId(session), ...qwenStream, '--approval-mode', QWEN_MODE[noAsk('Qwen Code', mode)]],
      cwd: folderOf(session),
    };
  },
  startArgs(cwd, mode): HeadlessCommand {
    return {
      command: bin('CONTEXTDECK_QWEN_BIN', 'qwen'),
      args: [...qwenStream, '--approval-mode', QWEN_MODE[noAsk('Qwen Code', mode)]],
      cwd,
    };
  },
  parseLine: parseClaudeStyleLine,
};
