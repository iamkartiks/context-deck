import { randomBytes } from 'node:crypto';

/**
 * The handoff marker: one line inside a brief that ties the new session back to
 * the one it continues, e.g.
 *
 *   (ContextDeck handoff hf_1a2b3c4d5e from claude-code:7c1e2a90-…)
 *
 * It travels inside the new session's first prompt, so the link lives in the
 * transcript itself and survives rebuilding the index.
 */

export const HANDOFF_ID_RE = /^hf_[0-9a-f]{10}$/;
const MARKER_RE = /ContextDeck handoff (hf_[0-9a-f]{10}) from ([a-z0-9][a-z0-9-]*:[^\s)]+)/;

export function newHandoffId(): string {
  return `hf_${randomBytes(5).toString('hex')}`;
}

export function handoffMarker(id: string, fromSessionId: string): string {
  return `(ContextDeck handoff ${id} from ${fromSessionId})`;
}

export function parseHandoffMarker(text: string): { id: string; from: string } | null {
  const m = MARKER_RE.exec(text);
  return m ? { id: m[1]!, from: m[2]! } : null;
}

/**
 * Make sure a (possibly hand-edited) brief still carries the marker for this
 * handoff. If the person deleted it, it is added back after the first line.
 */
export function ensureMarker(text: string, id: string, fromSessionId: string): string {
  const found = parseHandoffMarker(text);
  if (found && found.id === id && found.from === fromSessionId) return text;
  const cleaned = found ? text.replace(MARKER_RE, '').replace(/\(\s*\)/, '') : text;
  const lines = cleaned.split('\n');
  const at = lines.length > 1 ? 1 : lines.length;
  lines.splice(at, 0, '', handoffMarker(id, fromSessionId));
  return lines.join('\n');
}
