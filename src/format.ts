import { getAdapter } from './adapters/index.js';
import type { SessionRow } from './schema.js';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const wrap = (open: number, close: number) => (s: string) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : s);
export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  cyan: wrap(36, 39),
  magenta: wrap(35, 39),
  yellow: wrap(33, 39),
  green: wrap(32, 39),
  red: wrap(31, 39),
};

const PROVIDER_COLOR: Record<string, (s: string) => string> = {
  'claude-code': c.yellow,
  codex: c.cyan,
};

export function providerLabel(provider: string): string {
  const label = getAdapter(provider)?.label ?? provider;
  return (PROVIDER_COLOR[provider] ?? ((s: string) => s))(label);
}

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d}d ago`;
  return iso.slice(0, 10);
}

export function tokens(n: number | null): string {
  if (n == null || n === 0) return '—';
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** "84k / 200k (42%)" when the window is known, otherwise just the size. */
export function contextUsage(s: Pick<SessionRow, 'contextTokens' | 'contextWindow'>): string {
  if (!s.contextTokens) return '—';
  if (!s.contextWindow) return tokens(s.contextTokens);
  const pct = Math.round((s.contextTokens / s.contextWindow) * 100);
  const text = `${tokens(s.contextTokens)} (${pct}%)`;
  return pct >= 80 ? c.red(text) : pct >= 60 ? c.yellow(text) : text;
}

// ANSI-aware width helpers so colored cells still line up
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const visible = (s: string) => s.replace(ANSI, '').length;

function fit(s: string, width: number): string {
  const plain = s.replace(ANSI, '');
  if (plain.length <= width) return s + ' '.repeat(width - plain.length);
  return plain.slice(0, Math.max(0, width - 1)) + '…';
}

export interface Column {
  header: string;
  /** Fixed width, or omitted to size to content. The last column takes what's left. */
  width?: number;
  align?: 'left' | 'right';
}

export function table(columns: Column[], rows: string[][]): string {
  const termWidth = process.stdout.columns || 120;
  const widths = columns.map((col, i) =>
    col.width ?? Math.max(visible(col.header), ...rows.map((r) => visible(r[i] ?? ''))),
  );
  const last = widths.length - 1;
  const used = widths.slice(0, last).reduce((a, b) => a + b + 2, 0);
  widths[last] = Math.max(12, Math.min(widths[last] ?? 12, termWidth - used - 1));

  const line = (cells: string[]) =>
    cells
      .map((cell, i) => {
        const w = widths[i] ?? 10;
        if (columns[i]?.align === 'right') {
          const v = visible(cell);
          return v >= w ? fit(cell, w) : ' '.repeat(w - v) + cell;
        }
        return i === last ? (visible(cell) > w ? fit(cell, w) : cell) : fit(cell, w);
      })
      .join('  ')
      .trimEnd();

  return [c.dim(line(columns.map((col) => col.header))), ...rows.map(line)].join('\n');
}

export function indent(text: string, by = '  '): string {
  return text
    .split('\n')
    .map((l) => by + l)
    .join('\n');
}
