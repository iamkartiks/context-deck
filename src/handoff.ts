import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADAPTERS, getAdapter, type Adapter } from './adapters/index.js';
import { decisionsForChain } from './decisions.js';
import { ensureMarker, handoffMarker, HANDOFF_ID_RE, newHandoffId, parseHandoffMarker } from './handoff-marker.js';
import { posixQuote, windowsSafeText, type Launch } from './platform.js';
import type { ProviderId, SessionRow } from './schema.js';
import type { StoredMessage, Store } from './store.js';

/**
 * Handoff: continue a session's work in a new session, in any tool.
 *
 * The flow:
 *   1. buildBrief() writes a self-contained brief from what is already in the
 *      index: the goal, later instructions, where the work got to, files
 *      changed, recent commands, and how to pick up safely. No AI involved;
 *      nothing leaves the machine at this point.
 *   2. The person reviews or edits it.
 *   3. saveBrief() stores it under ~/.contextdeck/handoffs/ (owner-only), and
 *      startLaunch() describes how to start the target tool with the brief as
 *      its first message: `cd <project> && codex "$(cat <brief>)"` on macOS
 *      and Linux. On Windows a long multi-line argument can't pass safely
 *      through cmd.exe, so the first message is a one-line pointer to the
 *      brief file instead (see pointerPrompt()).
 *   4. The brief carries a marker line. When the new session is indexed, the
 *      store reads the marker and links the two sessions.
 */

export interface BriefOptions {
  /** Target tool, e.g. "codex". May be the same tool, for a fresh session. */
  to: ProviderId;
  /** Ask the new agent to summarise and wait for a go-ahead before changing files. Default true. */
  checkIn?: boolean;
  /** Reuse an id (e.g. when rebuilding a preview); a new one is made otherwise. */
  handoffId?: string;
  /**
   * ContextDeck's folder: used to read decisions you pinned (in this session
   * and the ones it continued from), and an earlier brief when a session
   * started from a pointer prompt.
   */
  home?: string;
}

export interface Brief {
  handoffId: string;
  text: string;
  /** Rough token count (characters / 4). */
  tokens: number;
  from: SessionRow;
  to: ProviderId;
  toLabel: string;
  /** Context window assumed for the new session, for "uses N% of the window". */
  targetWindow: number | null;
}

/** Hard ceiling for a brief, so it can't crowd the new session's window. */
export const MAX_BRIEF_CHARS = 24_000;
/** Ceiling for a brief the person edited and sent back. */
export const MAX_EDITED_BRIEF_CHARS = 200_000;

const LIMITS = {
  goal: 6_000,
  decision: 600,
  decisions: 20,
  instruction: 1_500,
  instructions: 12,
  reply: 2_500,
  replies: 2,
  commands: 15,
  command: 160,
  files: 40,
};

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Show a file relative to the project folder when it is inside it. */
function rel(file: string, cwd: string | null): string {
  if (!cwd) return file;
  const base = cwd.replace(/[\\/]+$/, '');
  for (const sep of ['/', '\\']) if (file.startsWith(base + sep)) return file.slice(base.length + 1);
  return file;
}

/** If a session was itself started by a handoff, its first prompt is a brief: pull out the original goal. */
function goalFromPreviousBrief(text: string): string | null {
  const m = /^## The goal\s*\n([\s\S]*?)(?:\n## |\s*$)/m.exec(text);
  return m ? m[1]!.trim() : null;
}

const POINTER_RE = /^Continue: .*Read the handoff brief in .+ and follow it\./;

function isPointer(text: string): boolean {
  return POINTER_RE.test(text.trim());
}

/** A brief saved by an earlier handoff, looked up by id in ContextDeck's own folder only. */
function readSavedBrief(home: string, handoffId: string): string | null {
  if (!HANDOFF_ID_RE.test(handoffId)) return null;
  try {
    return readFileSync(join(home, 'handoffs', `${handoffId}.md`), 'utf8');
  } catch {
    return null;
  }
}

function isCommand(text: string): boolean {
  return /^\/[a-z][\w:-]*(\s|$)/i.test(text.trim());
}

function ago(iso: string | null): string {
  if (!iso) return 'at an unknown time';
  const d = new Date(iso);
  return `on ${d.toISOString().slice(0, 10)} at ${d.toISOString().slice(11, 16)} UTC`;
}

function times(n: number): string {
  return n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`;
}

function contextLine(s: SessionRow): string | null {
  if (!s.contextTokens) return null;
  let win = s.contextWindow;
  let approx = '';
  if (!win && s.provider === 'claude-code') {
    win = s.contextTokens > 200_000 ? 1_000_000 : 200_000;
    approx = '~';
  }
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  const used = win ? `${Math.round((s.contextTokens / win) * 100)}% full (${k(s.contextTokens)} of ${approx}${k(win)} tokens)` : `${k(s.contextTokens)} tokens`;
  return `Its context window was ${used}${s.compactions ? ` and had been compacted ${times(s.compactions)}` : ''}.`;
}

function section(title: string, body: string | string[] | null): string {
  if (body == null || (Array.isArray(body) && body.length === 0) || body === '') return '';
  return `## ${title}\n\n${Array.isArray(body) ? body.join('\n') : body}\n\n`;
}

export function buildBrief(store: Store, ref: string, opts: BriefOptions): Brief {
  const from = store.resolve(ref);
  const source = getAdapter(from.provider);
  const target = getAdapter(opts.to);
  if (!target?.startCommand) throw new Error(`Can't hand off to "${opts.to}": that tool can't be started with a prompt.`);
  const handoffId = opts.handoffId && HANDOFF_ID_RE.test(opts.handoffId) ? opts.handoffId : newHandoffId();
  const checkIn = opts.checkIn !== false;
  const sourceLabel = source?.label ?? from.provider;
  const sameTool = from.provider === opts.to;

  const messages = store.messages(from.id);
  const users = messages.filter((m) => m.role === 'user' && !isCommand(m.text));
  const replies = messages.filter((m) => m.role === 'assistant');
  // Tool calls (not their results), leaving out pure reads and searches, which are noise here
  const calls = messages.filter(
    (m) => m.role === 'tool' && !/^[\w.-]+ result:/.test(m.text) && !/^(Read|Grep|Glob|LS|WebFetch|WebSearch|TodoWrite|read_file|read_many_files|grep_search|glob|list_directory|web_fetch|web_search|todo_write):/.test(m.text),
  );
  const files = store.filesTouched(from.id);

  // The goal: the first prompt, or the original goal if this session was itself a handoff
  const first = users[0];
  const earlier = first ? parseHandoffMarker(first.text) : null;
  const earlierText = first && earlier ? (isPointer(first.text) && opts.home ? readSavedBrief(opts.home, earlier.id) : null) ?? first.text : null;
  const goal = first ? (earlierText ? goalFromPreviousBrief(earlierText) ?? first.text : first.text) : from.title;

  // Decisions you pinned, in this session and the ones it continued from. They
  // are kept even when the brief has to shrink: they are the point of it.
  const pinned = opts.home ? decisionsForChain(store, opts.home, from.id) : [];
  const decisionLines = pinned.slice(-LIMITS.decisions).map((d) => {
    const label = d.session ? getAdapter(d.session.provider)?.label : undefined;
    const where = d.sessionId === from.id ? '' : label ? ` (decided earlier, in ${label})` : ' (decided in an earlier session)';
    return `- ${clip(d.text, LIMITS.decision).replace(/\n/g, '\n  ')}${where}`;
  });
  if (pinned.length > LIMITS.decisions) decisionLines.unshift(`- (${pinned.length - LIMITS.decisions} earlier decisions not shown)`);

  const build = (instructionCount: number, replyCount: number, commandCount: number): string => {
    const later = users.slice(1);
    const shown = later.slice(-instructionCount);
    const instructions = shown.map((m, i) => {
      const n = later.length - shown.length + i + 1;
      return `${n}. ${clip(m.text, LIMITS.instruction).replace(/\n/g, '\n   ')}`;
    });
    if (later.length > shown.length) instructions.unshift(`(${later.length - shown.length} earlier instructions not shown)`);

    const lastReplies = replies.slice(-replyCount).map((m: StoredMessage) => clip(m.text, LIMITS.reply));
    const inProject = (t: string) => (from.cwd ? t.split(`${from.cwd.replace(/[\\/]+$/, '')}/`).join('') : t);
    const commands = calls.slice(-commandCount).map((m) => `- ${clip(inProject(m.text.replace(/\n/g, ' ')), LIMITS.command)}`);
    const fileList = files.slice(0, LIMITS.files).map((f) => `- ${rel(f, from.cwd)}`);
    if (files.length > LIMITS.files) fileList.push(`- …and ${files.length - LIMITS.files} more`);

    const facts = [
      from.cwd ? `- Project folder: ${from.cwd}` : null,
      from.gitBranch ? `- Branch: ${from.gitBranch}` : null,
      `- Previous session: ${sourceLabel}${from.model ? ` (${from.model})` : ''}, last active ${ago(from.updatedAt)}.`,
      `- It had ${from.userTurns} prompt${from.userTurns === 1 ? '' : 's'} and ${from.toolCalls} tool call${from.toolCalls === 1 ? '' : 's'}. ${contextLine(from) ?? ''}`.trimEnd(),
      earlier ? `- This work has been handed over before; the goal below is the original one.` : null,
    ].filter(Boolean) as string[];

    const intro = sameTool
      ? `You're picking up work from an earlier ${sourceLabel} session. That session isn't available to you, so this brief is everything you know about it.`
      : `You're picking up work that was started in ${sourceLabel}. That session isn't available to you, so this brief is everything you know about it.`;

    const steps = [
      '1. Check the current state of the code first: run `git status` and `git diff`. The files listed above may have uncommitted changes, and some work may have happened after this brief was written.',
      decisionLines.length
        ? "2. Don't redo work that's already done, and don't reopen the decisions above unless I ask. If something looks finished, verify it instead of rewriting it."
        : "2. Don't redo work that's already done. If something above looks finished, verify it instead of rewriting it.",
      checkIn
        ? '3. Then reply with a short summary of where things stand and the next step you propose, and wait for my go-ahead before changing any files.'
        : '3. Then carry on with the next step.',
    ];

    return (
      `# Continue: ${from.title}\n\n` +
      `${handoffMarker(handoffId, from.id)}\n\n` +
      `${intro}\n\n` +
      section('Where things are', facts) +
      section('The goal', clip(goal, LIMITS.goal)) +
      section('Later instructions', instructions) +
      section('Decisions already made', decisionLines) +
      section(`Where the previous session got to`, lastReplies.length ? lastReplies.join('\n\n---\n\n') : 'The session ended before replying.') +
      section('Files it changed', fileList) +
      section('What it ran most recently', commands) +
      section('How to pick up', steps)
    ).trimEnd() + '\n';
  };

  // Shrink in steps until it fits the budget
  let text = build(LIMITS.instructions, LIMITS.replies, LIMITS.commands);
  if (text.length > MAX_BRIEF_CHARS) text = build(LIMITS.instructions, LIMITS.replies, 5);
  if (text.length > MAX_BRIEF_CHARS) text = build(6, 1, 5);
  if (text.length > MAX_BRIEF_CHARS) text = build(3, 1, 0);
  if (text.length > MAX_BRIEF_CHARS) text = `${text.slice(0, MAX_BRIEF_CHARS - 2)}…\n`;

  return {
    handoffId,
    text,
    tokens: Math.ceil(text.length / 4),
    from,
    to: opts.to,
    toLabel: target.label,
    targetWindow: target.defaultContextWindow ?? null,
  };
}

/** Where briefs are kept: ~/.contextdeck/handoffs/<id>.md, readable only by you. */
export function saveBrief(home: string, handoffId: string, text: string): string {
  if (!HANDOFF_ID_RE.test(handoffId)) throw new Error('Invalid handoff id.');
  const dir = join(home, 'handoffs');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${handoffId}.md`);
  writeFileSync(path, text, { mode: 0o600 });
  return path;
}

/**
 * Prepare a (possibly edited) brief for launch: enforce the size limit and
 * make sure the marker for this handoff is in it.
 */
export function finalizeBrief(text: string, handoffId: string, fromSessionId: string): string {
  if (!HANDOFF_ID_RE.test(handoffId)) throw new Error('Invalid handoff id.');
  if (!text.trim()) throw new Error('The brief is empty.');
  if (text.length > MAX_EDITED_BRIEF_CHARS) throw new Error(`The brief is too long (${text.length} characters; the limit is ${MAX_EDITED_BRIEF_CHARS}).`);
  return ensureMarker(text, handoffId, fromSessionId);
}

/**
 * The one-line first message used on Windows: it names the brief file and
 * carries the marker, so the new session is still linked. Only characters
 * that are safe on a Windows command line are used.
 */
export function pointerPrompt(title: string, briefPath: string, handoffId: string, fromSessionId: string): string {
  const t = windowsSafeText(title) || 'the previous session';
  return `Continue: ${t}. Read the handoff brief in ${briefPath} and follow it. ${handoffMarker(handoffId, fromSessionId)}`;
}

/**
 * How to start the target tool in the project folder with the brief as its
 * first message.
 *
 * macOS and Linux: the brief is read from its file with `"$(cat …)"`, so its
 * contents are passed as one argument and never interpreted by the shell.
 * Windows: the first message is pointerPrompt().
 */
export function startLaunch(
  target: Adapter,
  from: SessionRow,
  briefPath: string,
  handoffId: string,
  platform: NodeJS.Platform = process.platform,
): Launch {
  const start = target.startCommand?.();
  if (!start) throw new Error(`${target.label} can't be started with a prompt.`);
  const cwd = from.cwd && existsSync(from.cwd) ? from.cwd : null;
  if (platform === 'win32') {
    return { cwd, command: start.command, args: [...start.args, pointerPrompt(from.title, briefPath, handoffId, from.id)] };
  }
  return { cwd, command: start.command, args: start.args, posixTail: `"$(cat ${posixQuote(briefPath)})"` };
}

/** Tools that can receive a handoff. */
export function handoffTargets(): Adapter[] {
  return ADAPTERS.filter((a) => !!a.startCommand);
}
