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
}

export interface ResumeCommand {
  command: string;
  args: string[];
  cwd: string | null;
  /** Shown to the user, e.g. "cd ~/code/shop && claude --resume 1234". */
  display: string;
}
