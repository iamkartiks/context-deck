/**
 * The unified session schema.
 *
 * Every provider adapter turns its own on-disk format into these shapes.
 * The index, the CLI and (later) the UI only ever see these types, so adding
 * a provider never touches anything outside `src/adapters/`.
 */

/** Built-in provider ids. Third-party adapters may use any other string. */
export type ProviderId = 'claude-code' | 'codex' | (string & {});

export type Role = 'user' | 'assistant' | 'tool' | 'system';

export interface NormalizedMessage {
  /** Position in the session, starting at 0. */
  seq: number;
  role: Role;
  /** ISO-8601 timestamp, when the provider records one. */
  ts: string | null;
  /** Plain text, already redacted and truncated by the adapter helpers. */
  text: string;
  /** For tool calls and tool results: the tool's name. */
  toolName?: string;
}

export interface NormalizedSession {
  provider: ProviderId;
  /** The provider's own session id (what its `resume` command expects). */
  nativeId: string;
  title: string;
  /** Working directory the session ran in. */
  cwd: string | null;
  gitBranch: string | null;
  model: string | null;
  cliVersion: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  userTurns: number;
  assistantTurns: number;
  toolCalls: number;
  /** Total input tokens processed across the session (including cache reads). */
  tokensIn: number;
  tokensOut: number;
  /** Size of the context window at the last turn, in tokens. A "how full is it" signal. */
  contextTokens: number | null;
  /** Maximum context window, when the provider reports it. */
  contextWindow: number | null;
  /** Number of times the context was compacted / summarised. */
  compactions: number;
  /** Context size (tokens) after each model turn, in order. Drives the "context over time" chart. */
  contextSeries: number[];
  /** Indexes into contextSeries where a compaction happened (before that point). */
  compactionPoints: number[];
  /** Files the agent created, edited or deleted (as written in the session). */
  filesTouched: string[];
  /** For subagent sessions: the native id of the parent session. */
  parentNativeId: string | null;
  isSubagent: boolean;
  messages: NormalizedMessage[];
}

export interface ParseResult {
  session: NormalizedSession | null;
  /** Lines that could not be parsed as JSON. Malformed lines are skipped, never fatal. */
  badLines: number;
  warnings: string[];
}

/** A session as stored in the index (what list/search/show return). */
export interface SessionRow {
  id: string;
  provider: ProviderId;
  nativeId: string;
  shortId: string;
  title: string;
  cwd: string | null;
  project: string | null;
  gitBranch: string | null;
  model: string | null;
  cliVersion: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  messageCount: number;
  userTurns: number;
  assistantTurns: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  contextTokens: number | null;
  contextWindow: number | null;
  compactions: number;
  parentId: string | null;
  isSubagent: boolean;
  sourcePath: string;
  /** Set when this session was started from a ContextDeck handoff: the handoff id. */
  handoffId: string | null;
  /** The session this one continued (via a handoff), if any. */
  handoffFrom: string | null;
}

/** A session's context size over time, downsampled for display. */
export interface ContextSeries {
  /** Tokens in context after each (sampled) turn. */
  points: number[];
  /** Indexes into points where a compaction happened. */
  compactions: number[];
}

export function emptySession(provider: ProviderId, nativeId: string): NormalizedSession {
  return {
    provider,
    nativeId,
    title: '',
    cwd: null,
    gitBranch: null,
    model: null,
    cliVersion: null,
    startedAt: null,
    updatedAt: null,
    userTurns: 0,
    assistantTurns: 0,
    toolCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: null,
    contextWindow: null,
    compactions: 0,
    contextSeries: [],
    compactionPoints: [],
    filesTouched: [],
    parentNativeId: null,
    isSubagent: false,
    messages: [],
  };
}
