import { redact } from './redact.js';

/** Per-message caps keep the index small even when sessions are hundreds of MB. */
export const MAX_MESSAGE_CHARS = 8_000;
export const MAX_TOOL_CHARS = 2_000;
export const MAX_TITLE_CHARS = 100;

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

/** Redact, then truncate. Every string that enters the index goes through here. */
export function clean(text: string, max = MAX_MESSAGE_CHARS): string {
  return truncate(redact(text.replace(/\u0000/g, '')).trim(), max);
}

/** First meaningful line of a prompt, for use as a session title. */
export function titleFrom(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  return truncate(redact(line).replace(/\s+/g, ' '), MAX_TITLE_CHARS);
}

/** Pull text out of the common "content" shapes: a string, or an array of blocks. */
export function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
    } else if (block && typeof block === 'object') {
      const b = block as Record<string, unknown>;
      if (typeof b.text === 'string') parts.push(b.text);
      else if (b.type === 'image' || b.type === 'input_image') parts.push('[image]');
    }
  }
  return parts.join('\n');
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Keep the earliest and latest ISO timestamps seen. */
export function trackTime(s: { startedAt: string | null; updatedAt: string | null }, ts: unknown): void {
  const t = asString(ts);
  if (!t || Number.isNaN(Date.parse(t))) return;
  if (!s.startedAt || t < s.startedAt) s.startedAt = t;
  if (!s.updatedAt || t > s.updatedAt) s.updatedAt = t;
}

/**
 * Files named in an apply_patch-style patch ("*** Update File: src/a.ts").
 * Used by Codex, and by any agent that edits through unified patches.
 */
export function filesFromPatch(text: string): string[] {
  const files: string[] = [];
  const re = /\*\*\* (?:Update|Add|Delete) File: (.+)/g;
  for (const m of text.matchAll(re)) {
    const f = m[1]?.trim();
    if (f) files.push(f);
  }
  return files;
}
