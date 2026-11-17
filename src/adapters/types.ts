import type { ParseResult, ProviderId, SessionRow } from '../schema.js';

/**
 * The contract every provider adapter implements.
 *
 * Adapters are read-only: they never write to the provider's folders.
 * See docs/WRITING_AN_ADAPTER.md for a walkthrough.
 */
export interface Adapter {
  id: ProviderId;
  /** Human-readable name, e.g. "Claude Code". */
  label: string;
  /** Two-letter prefix used in short ids, e.g. "cc" → cc:1a2b3c4d. */
  shortPrefix: string;
  /** Environment variable users can set to point at a non-default folder. */
  envVar: string;

  /** Folder that holds this provider's sessions on this machine. */
  defaultRoot(env: NodeJS.ProcessEnv, home: string): string;

  /** Every session file under `root`. Must return [] (not throw) if root is missing. */
  discover(root: string): Promise<string[]>;

  /** Parse one session file into the unified schema. Must not throw on bad lines. */
  parse(filePath: string): Promise<ParseResult>;

  /** The shell command that resumes this session in the provider's own CLI. */
  resumeCommand(session: SessionRow): ResumeCommand;

  /**
   * How to start a NEW interactive session with an initial prompt, used for
   * handoffs. The prompt is appended as the last argument. Omit if the tool
   * can't take an initial prompt; it then can't be a handoff target.
   */
  startCommand?(): { command: string; args: string[] };
  /** Context window to assume for a new session, for "how much of the window will the brief use". */
  defaultContextWindow?: number;

  /**
   * Running one turn without a terminal, for runs started from a phone.
   * Optional: an adapter without it can't be run that way. See
   * docs/WRITING_AN_ADAPTER.md for the rules, especially the forbidden modes.
   */
  headless?: HeadlessDriver;
}

/**
 * What a headless run may do. There is deliberately no mode that skips
 * permissions: `plan` changes nothing, `edit` may change files in the
 * session's folder and nothing else.
 */
export type RunMode = 'plan' | 'edit';
export const RUN_MODES: readonly RunMode[] = ['plan', 'edit'];

/** What a headless run reports, parsed from the tool's streamed output. */
export type RunEvent =
  /** The tool's own id for the session, so a new run links to its session. */
  | { type: 'session'; nativeId: string }
  /** Reply text. `start` marks the beginning of a new message. */
  | { type: 'text'; delta: string; start?: boolean }
  /** A tool call: its name and a one-line summary (a command, a file). */
  | { type: 'tool'; name: string; summary: string }
  /** Something the mode didn't allow, so the tool skipped it. */
  | { type: 'denied'; tool: string; reason: string }
  | { type: 'done'; ok: boolean; summary?: string; costUsd?: number }
  | { type: 'error'; message: string };

/** A command to spawn without a shell. The prompt goes on stdin, never in `args`. */
export interface HeadlessCommand {
  command: string;
  args: string[];
  cwd: string;
}

export interface HeadlessDriver {
  /** The tool version these arguments and this output format were checked against. */
  testedWith: string;
  /** One turn that continues an existing session, in its own folder. Throws if the session has no folder. */
  continueArgs(session: SessionRow, mode: RunMode): HeadlessCommand;
  /** One turn that starts a new session in `cwd`. */
  startArgs(cwd: string, mode: RunMode): HeadlessCommand;
  /** Turn one line of the tool's output into zero or more events. Never throws. */
  parseLine(line: string): RunEvent[];
}

export interface ResumeCommand {
  command: string;
  args: string[];
  cwd: string | null;
  /** Shown to the user, e.g. "cd ~/code/shop && claude --resume 1234". */
  display: string;
}
