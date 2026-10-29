import { basename, join, sep } from 'node:path';
import { emptySession, type NormalizedSession, type ParseResult, type SessionRow } from '../schema.js';
import { listFiles, readJsonl } from '../util/jsonl.js';
import { asNumber, asString, clean, MAX_TOOL_CHARS, titleFrom, trackTime, truncate } from '../util/text.js';
import type { Adapter, ResumeCommand } from './types.js';

/**
 * Qwen Code (github.com/QwenLM/qwen-code)
 *
 * The agent built for Qwen models. It also runs any OpenAI-compatible model,
 * local (Ollama, vLLM, LM Studio) or hosted (DeepSeek, OpenRouter, …), and
 * saves every session the same way, whichever model it used.
 *
 * Layout:  <QWEN_RUNTIME_DIR or QWEN_HOME or ~/.qwen>/projects/<sanitized-cwd>/chats/<session-id>.jsonl
 * Subagents: …/projects/<sanitized-cwd>/subagents/<session-id>/agent-<id>.jsonl
 *
 * Each line is a ChatRecord (packages/core/src/services/chatRecordingService.ts):
 *   { uuid, parentUuid, sessionId, timestamp, cwd, version, gitBranch,
 *     type: "user" | "assistant" | "tool_result" | "system", subtype?,
 *     message?: { role, parts: [{ text } | { functionCall } | { functionResponse } …] },
 *     usageMetadata?, model?, contextWindowSize?, systemPayload? }
 *
 * Messages use the Gemini API shape (Qwen Code is a fork of Gemini CLI), and
 * usage follows Gemini's field names whatever the model.
 */

/** Tools whose `file_path` argument is a file the agent changed. */
const EDIT_TOOLS = new Set(['edit', 'write_file', 'notebook_edit', 'replace']);

/** User records that are something other than a person typing a prompt. */
const USER_SUBTYPES = new Set([undefined, 'mid_turn_user_message']);

type Part = Record<string, unknown>;

function partsOf(message: unknown): Part[] {
  const parts = (message as { parts?: unknown } | null | undefined)?.parts;
  return Array.isArray(parts) ? (parts.filter((p) => p && typeof p === 'object') as Part[]) : [];
}

/** Visible text: text parts that aren't the model's hidden reasoning. */
function textOf(parts: Part[]): string {
  return parts
    .filter((p) => typeof p.text === 'string' && p.thought !== true)
    .map((p) => p.text as string)
    .join('\n')
    .trim();
}

function summariseCall(name: string, args: Record<string, unknown> | null): string {
  if (!args) return name;
  if (name === 'run_shell_command' && typeof args.command === 'string') return `${name}: $ ${args.command}`;
  const target =
    asString(args.file_path) ??
    asString(args.absolute_path) ??
    asString(args.path) ??
    asString(args.pattern) ??
    asString(args.url) ??
    asString(args.query) ??
    asString(args.description) ??
    asString(args.prompt);
  if (target) return `${name}: ${target}`;
  try {
    return `${name}: ${JSON.stringify(args)}`;
  } catch {
    return name;
  }
}

function responseText(response: unknown): string {
  if (typeof response === 'string') return response;
  if (!response || typeof response !== 'object') return '';
  const r = response as Record<string, unknown>;
  for (const key of ['output', 'error', 'content', 'llmContent']) {
    if (typeof r[key] === 'string') return r[key] as string;
  }
  try {
    return JSON.stringify(r);
  } catch {
    return '';
  }
}

async function parse(filePath: string): Promise<ParseResult> {
  const file = basename(filePath, '.jsonl');
  const segments = filePath.split(sep);
  const subIdx = segments.lastIndexOf('subagents');
  const isSubagent = subIdx > 0 && subIdx === segments.length - 3;
  const parentFromPath = isSubagent ? (segments[subIdx + 1] ?? null) : null;

  const s: NormalizedSession = emptySession('qwen-code', isSubagent ? `${parentFromPath}/${file}` : file);
  s.isSubagent = isSubagent;
  s.parentNativeId = parentFromPath;

  let badLines = 0;
  const warnings: string[] = [];
  let customTitle: string | null = null;
  let firstPrompt: string | null = null;
  let firstCommand: string | null = null;
  let sessionIdField: string | null = null;
  const files = new Set<string>();
  const callNames = new Map<string, string>(); // functionCall id → tool name
  let seq = 0;

  const push = (role: NormalizedSession['messages'][number]['role'], text: string, ts: unknown, toolName?: string) => {
    if (!text) return;
    s.messages.push({ seq: seq++, role, ts: asString(ts), text, ...(toolName ? { toolName } : {}) });
  };

  for await (const line of readJsonl(filePath)) {
    if (!line.ok) {
      badLines++;
      continue;
    }
    const o = line.value as Record<string, unknown>;
    if (!o || typeof o !== 'object') continue;
    const type = o.type;
    const subtype = asString(o.subtype) ?? undefined;
    const payload = (o.systemPayload && typeof o.systemPayload === 'object' ? o.systemPayload : {}) as Record<string, unknown>;

    sessionIdField ??= asString(o.sessionId);
    s.cwd ??= asString(o.cwd);
    s.gitBranch = asString(o.gitBranch) ?? s.gitBranch;
    s.cliVersion = asString(o.version) ?? s.cliVersion;
    trackTime(s, o.timestamp);

    if (type === 'system') {
      if (subtype === 'chat_compression') {
        s.compactions++;
        s.compactionPoints.push(s.contextSeries.length);
      } else if (subtype === 'custom_title') {
        customTitle = asString(payload.customTitle) ?? customTitle;
      } else if (subtype === 'session_model') {
        s.model ??= asString(payload.modelId);
      } else if (subtype === 'slash_command' && payload.phase === 'invocation') {
        const command = asString(payload.rawCommand);
        if (command) {
          firstCommand ??= command;
          push('user', clean(command), o.timestamp);
        }
      }
      continue;
    }

    const parts = partsOf(o.message);

    if (type === 'user') {
      if (!USER_SUBTYPES.has(subtype)) continue;
      // The prompt as typed, when recorded; otherwise the text sent to the model
      const text = (typeof payload.displayText === 'string' ? payload.displayText.trim() : '') || textOf(parts);
      if (!text) continue;
      s.userTurns++;
      firstPrompt ??= text;
      push('user', clean(text), o.timestamp);
      continue;
    }

    if (type === 'assistant') {
      s.model = asString(o.model) ?? s.model;
      const usage = o.usageMetadata as Record<string, unknown> | undefined;
      if (usage && typeof usage === 'object') {
        const input = asNumber(usage.promptTokenCount);
        const output = asNumber(usage.candidatesTokenCount);
        s.tokensIn += input;
        s.tokensOut += output + asNumber(usage.thoughtsTokenCount);
        if (input || output) {
          s.contextTokens = input + output;
          s.contextSeries.push(s.contextTokens);
        }
      }
      const window = asNumber(o.contextWindowSize);
      if (window) s.contextWindow = window;

      const text = textOf(parts);
      if (text || usage) s.assistantTurns++;
      push('assistant', clean(text), o.timestamp);
      for (const p of parts) {
        const call = p.functionCall as Record<string, unknown> | undefined;
        if (!call || typeof call !== 'object') continue;
        const name = asString(call.name) ?? 'tool';
        const id = asString(call.id);
        if (id) callNames.set(id, name);
        s.toolCalls++;
        const args = call.args && typeof call.args === 'object' ? (call.args as Record<string, unknown>) : null;
        if (EDIT_TOOLS.has(name)) {
          const f = asString(args?.file_path) ?? asString(args?.absolute_path) ?? asString(args?.notebook_path);
          if (f) files.add(f);
        }
        push('tool', clean(summariseCall(name, args), MAX_TOOL_CHARS), o.timestamp, name);
      }
      continue;
    }

    if (type === 'tool_result') {
      for (const p of parts) {
        const res = p.functionResponse as Record<string, unknown> | undefined;
        if (!res || typeof res !== 'object') continue;
        const name = asString(res.name) ?? (asString(res.id) && callNames.get(asString(res.id)!)) ?? 'tool';
        push('tool', clean(`${name} result: ${responseText(res.response)}`, MAX_TOOL_CHARS), o.timestamp, name);
      }
    }
    // Other record types (telemetry, snapshots, …) are not conversation
  }

  if (!isSubagent && sessionIdField) s.nativeId = sessionIdField;
  s.filesTouched = [...files];
  s.title = titleFrom(customTitle ?? firstPrompt ?? firstCommand ?? '') || '(untitled session)';

  if (s.messages.length === 0) return { session: null, badLines, warnings: [...warnings, 'no conversation found'] };
  return { session: s, badLines, warnings };
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./~:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export const qwenCodeAdapter: Adapter = {
  id: 'qwen-code',
  label: 'Qwen Code',
  shortPrefix: 'qw',
  envVar: 'CONTEXTDECK_QWEN_DIR',

  defaultRoot(env, home) {
    // Sessions are written under the runtime folder, which QWEN_RUNTIME_DIR moves
    return env.CONTEXTDECK_QWEN_DIR ?? env.QWEN_RUNTIME_DIR ?? env.QWEN_HOME ?? join(home, '.qwen');
  },

  async discover(root) {
    // projects/<p>/chats/<id>.jsonl and projects/<p>/subagents/<id>/agent-<x>.jsonl
    return listFiles(join(root, 'projects'), (rel) => {
      const parts = rel.split(/[\\/]/);
      if (!rel.endsWith('.jsonl')) return false;
      if (parts.length === 3 && parts[1] === 'chats') return true;
      return parts.length === 4 && parts[1] === 'subagents' && parts[3]!.startsWith('agent-');
    });
  },

  parse,

  // `qwen "prompt"` runs once and exits; `-i` runs the prompt and stays interactive.
  startCommand: () => ({ command: 'qwen', args: ['-i'] }),

  resumeCommand(session: SessionRow): ResumeCommand {
    // Subagents can't be resumed on their own; resume the parent conversation.
    const id = session.isSubagent && session.parentId ? session.parentId.split(':').slice(1).join(':') : session.nativeId;
    const args = ['--resume', id];
    const cwd = session.cwd;
    const display = `${cwd ? `cd ${shellQuote(cwd)} && ` : ''}qwen ${args.map(shellQuote).join(' ')}`;
    return { command: 'qwen', args, cwd, display: truncate(display, 400) };
  },
};
