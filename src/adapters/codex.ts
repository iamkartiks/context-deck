import { basename, join } from 'node:path';
import { emptySession, type NormalizedSession, type ParseResult, type SessionRow } from '../schema.js';
import { listFiles, readJsonl } from '../util/jsonl.js';
import {
  asNumber,
  asString,
  clean,
  filesFromPatch,
  MAX_TOOL_CHARS,
  textFromContent,
  titleFrom,
  trackTime,
  truncate,
} from '../util/text.js';
import type { Adapter, ResumeCommand } from './types.js';

/**
 * OpenAI Codex CLI
 *
 * Layout:  <CODEX_HOME or ~/.codex>/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl[.zst]
 *          <CODEX_HOME or ~/.codex>/archived_sessions/… (same format)
 *
 * Current format, one event per line: { timestamp, type, payload }
 *   type = session_meta | turn_context | response_item | event_msg | compacted
 * Older format (before the wrapper was introduced): first line is a bare
 *   { id, timestamp, instructions } object, then bare response items.
 */

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** Context Codex injects as "user" messages that are not real prompts. */
const INJECTED_PREFIXES = [
  '<environment_context>',
  '<user_instructions>',
  '<permissions instructions>',
  '<user_shell_command>',
  '<turn_aborted>',
  '# AGENTS.md instructions',
  '<INSTRUCTIONS>',
];

function isInjected(text: string): boolean {
  const t = text.trimStart();
  return INJECTED_PREFIXES.some((p) => t.startsWith(p));
}

function parseArgs(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function commandText(cmd: unknown): string | null {
  if (Array.isArray(cmd)) {
    // ["bash", "-lc", "actual command"] → show the actual command
    const parts = cmd.map(String);
    if (parts.length >= 3 && /^(ba|z)?sh$/.test(parts[0] ?? '') && parts[1]?.startsWith('-')) {
      return parts.slice(2).join(' ');
    }
    return parts.join(' ');
  }
  return asString(cmd);
}

async function parse(filePath: string): Promise<ParseResult> {
  const fallbackId = UUID_RE.exec(basename(filePath))?.[1] ?? basename(filePath).replace(/\.jsonl(\.zst)?$/, '');
  const s: NormalizedSession = emptySession('codex', fallbackId);

  let badLines = 0;
  const warnings: string[] = [];
  const files = new Set<string>();
  const callNames = new Map<string, string>(); // call_id → tool name
  // Codex logs user/assistant text twice (response_item and event_msg). Keep both
  // streams and use event_msg only if a file has no response_item messages.
  const items: NormalizedSession['messages'] = [];
  const events: NormalizedSession['messages'] = [];
  let itemUserTurns = 0;
  let itemAssistantTurns = 0;
  let eventUserTurns = 0;
  let eventAssistantTurns = 0;
  let firstItemPrompt: string | null = null;
  let firstEventPrompt: string | null = null;
  let threadName: string | null = null;

  const add = (list: typeof items, role: (typeof items)[number]['role'], text: string, ts: unknown, toolName?: string) => {
    if (!text) return;
    list.push({ seq: 0, role, ts: asString(ts), text, ...(toolName ? { toolName } : {}) });
  };

  const handleItem = (p: Record<string, unknown>, ts: unknown) => {
    switch (p.type) {
      case 'message': {
        const role = p.role;
        const text = textFromContent(p.content);
        if (!text.trim()) return;
        if (role === 'user') {
          if (isInjected(text)) return;
          itemUserTurns++;
          firstItemPrompt ??= text;
          add(items, 'user', clean(text), ts);
        } else if (role === 'assistant') {
          itemAssistantTurns++;
          add(items, 'assistant', clean(text), ts);
        }
        // developer / system messages are instructions, not conversation
        return;
      }
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call': {
        s.toolCalls++;
        const name = asString(p.name) ?? (p.type === 'local_shell_call' ? 'shell' : 'tool');
        const callId = asString(p.call_id) ?? asString(p.id);
        if (callId) callNames.set(callId, name);
        const args = parseArgs(p.arguments) ?? (p.action as Record<string, unknown> | undefined) ?? null;
        const rawInput = typeof p.input === 'string' ? p.input : typeof p.arguments === 'string' ? p.arguments : '';
        const cmd = commandText(args?.command);
        for (const f of filesFromPatch(rawInput + '\n' + (cmd ?? ''))) files.add(f);
        const summary = cmd ? `${name}: $ ${cmd}` : `${name}: ${rawInput || JSON.stringify(args ?? {})}`;
        add(items, 'tool', clean(summary, MAX_TOOL_CHARS), ts, name);
        return;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const callId = asString(p.call_id);
        const name = (callId && callNames.get(callId)) || 'tool';
        let out = p.output;
        if (out && typeof out === 'object') out = (out as Record<string, unknown>).content ?? JSON.stringify(out);
        const parsed = typeof out === 'string' ? parseArgs(out) : null;
        const text = parsed && typeof parsed.output === 'string' ? parsed.output : String(out ?? '');
        add(items, 'tool', clean(`${name} result: ${text}`, MAX_TOOL_CHARS), ts, name);
        return;
      }
      default:
        // reasoning, web_search_call, … are not indexed
        return;
    }
  };

  let lineIndex = 0;
  for await (const line of readJsonl(filePath)) {
    if (!line.ok) {
      badLines++;
      continue;
    }
    const o = line.value as Record<string, unknown>;
    if (!o || typeof o !== 'object') continue;
    const first = lineIndex++ === 0;
    const ts = o.timestamp;
    trackTime(s, ts);

    const type = o.type;
    const payload = (o.payload && typeof o.payload === 'object' ? o.payload : null) as Record<string, unknown> | null;

    if (!payload) {
      // Older format
      if (first && typeof o.id === 'string' && !('type' in o)) {
        s.nativeId = o.id;
        const git = o.git as Record<string, unknown> | undefined;
        s.gitBranch = asString(git?.branch) ?? s.gitBranch;
        continue;
      }
      if (o.record_type === 'state') continue;
      handleItem(o, ts);
      continue;
    }

    switch (type) {
      case 'session_meta': {
        const id = asString(payload.id);
        if (id) s.nativeId = id;
        s.cwd = asString(payload.cwd) ?? s.cwd;
        s.cliVersion = asString(payload.cli_version) ?? s.cliVersion;
        trackTime(s, payload.timestamp);
        const git = payload.git as Record<string, unknown> | undefined;
        s.gitBranch = asString(git?.branch) ?? s.gitBranch;
        threadName = asString(payload.thread_name) ?? asString(payload.title) ?? threadName;
        // Subagent threads point at their parent, when recorded
        const parent = asString(payload.parent_thread_id) ?? asString(payload.parent_id);
        if (parent) {
          s.isSubagent = true;
          s.parentNativeId = parent;
        }
        break;
      }
      case 'turn_context':
        s.model = asString(payload.model) ?? s.model;
        s.cwd = asString(payload.cwd) ?? s.cwd;
        break;
      case 'response_item':
        handleItem(payload, ts);
        break;
      case 'compacted':
        s.compactions++;
        s.compactionPoints.push(s.contextSeries.length);
        break;
      case 'event_msg': {
        const ev = payload.type;
        if (ev === 'token_count') {
          const info = payload.info as Record<string, unknown> | null | undefined;
          const total = info?.total_token_usage as Record<string, unknown> | undefined;
          const last = info?.last_token_usage as Record<string, unknown> | undefined;
          if (total) {
            s.tokensIn = asNumber(total.input_tokens);
            s.tokensOut = asNumber(total.output_tokens);
          }
          if (last) {
            s.contextTokens = asNumber(last.input_tokens) + asNumber(last.output_tokens);
            s.contextSeries.push(s.contextTokens);
          }
          const window = asNumber(info?.model_context_window);
          if (window) s.contextWindow = window;
        } else if (ev === 'user_message') {
          const text = asString(payload.message);
          if (text && !isInjected(text)) {
            eventUserTurns++;
            firstEventPrompt ??= text;
            add(events, 'user', clean(text), ts);
          }
        } else if (ev === 'agent_message') {
          const text = asString(payload.message);
          if (text) {
            eventAssistantTurns++;
            add(events, 'assistant', clean(text), ts);
          }
        } else if (ev === 'context_compacted') {
          s.compactions++;
          s.compactionPoints.push(s.contextSeries.length);
        }
        break;
      }
      default:
        break;
    }
  }

  const hasItemMessages = itemUserTurns + itemAssistantTurns > 0;
  if (hasItemMessages) {
    s.messages = items;
    s.userTurns = itemUserTurns;
    s.assistantTurns = itemAssistantTurns;
  } else {
    // Merge event text with any tool items, ordered by timestamp
    s.messages = [...events, ...items].sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
    s.userTurns = eventUserTurns;
    s.assistantTurns = eventAssistantTurns;
  }
  s.messages.forEach((m, i) => (m.seq = i));
  s.filesTouched = [...files];
  s.title = titleFrom(threadName ?? firstItemPrompt ?? firstEventPrompt ?? '') || '(untitled session)';

  if (s.messages.length === 0) return { session: null, badLines, warnings: [...warnings, 'no conversation found'] };
  return { session: s, badLines, warnings };
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./~:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export const codexAdapter: Adapter = {
  id: 'codex',
  label: 'Codex CLI',
  shortPrefix: 'cx',
  envVar: 'CONTEXTDECK_CODEX_DIR',

  defaultRoot(env, home) {
    return env.CONTEXTDECK_CODEX_DIR ?? env.CODEX_HOME ?? join(home, '.codex');
  },

  async discover(root) {
    const accept = (rel: string) => /rollout-.*\.jsonl(\.zst)?$/.test(rel);
    const [live, archived] = await Promise.all([
      listFiles(join(root, 'sessions'), accept),
      listFiles(join(root, 'archived_sessions'), accept),
    ]);
    return [...live, ...archived];
  },

  parse,

  // `codex "prompt"` starts the interactive TUI with an initial prompt.
  startCommand: () => ({ command: 'codex', args: [] }),
  defaultContextWindow: 272_000,

  resumeCommand(session: SessionRow): ResumeCommand {
    const args = ['resume', session.nativeId];
    const cwd = session.cwd;
    const display = `${cwd ? `cd ${shellQuote(cwd)} && ` : ''}codex ${args.map(shellQuote).join(' ')}`;
    return { command: 'codex', args, cwd, display: truncate(display, 400) };
  },
};
