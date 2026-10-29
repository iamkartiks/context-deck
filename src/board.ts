import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Where you put cards on the canvas.
 *
 * This is the one piece of state you create yourself, so it lives in its own
 * file (~/.contextdeck/board.json), not in index.db. Deleting the index to
 * rebuild it never loses your arrangement.
 */

export const GROUPINGS = ['workstream', 'project', 'tool', 'day'] as const;
export type Grouping = (typeof GROUPINGS)[number];

export interface Point {
  x: number;
  y: number;
}

export interface Board {
  version: 1;
  /** Cards you moved by hand, per grouping. Cards not listed are placed automatically. */
  positions: Record<Grouping, Record<string, Point>>;
}

const MAX_CARDS_PER_GROUPING = 20_000;
const MAX_COORD = 1_000_000;

export function emptyBoard(): Board {
  return { version: 1, positions: { workstream: {}, project: {}, tool: {}, day: {} } };
}

export function boardPath(home: string): string {
  return join(home, 'board.json');
}

/** Parse and validate untrusted board data. Invalid entries are dropped, never thrown. */
export function sanitizeBoard(input: unknown): Board {
  const board = emptyBoard();
  const positions = (input as { positions?: unknown } | null)?.positions;
  if (!positions || typeof positions !== 'object') return board;
  for (const grouping of GROUPINGS) {
    const src = (positions as Record<string, unknown>)[grouping];
    if (!src || typeof src !== 'object') continue;
    let n = 0;
    for (const [id, p] of Object.entries(src as Record<string, unknown>)) {
      if (n >= MAX_CARDS_PER_GROUPING) break;
      if (id.length === 0 || id.length > 512 || !p || typeof p !== 'object') continue;
      const { x, y } = p as Record<string, unknown>;
      if (typeof x !== 'number' || typeof y !== 'number') continue;
      if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD) continue;
      board.positions[grouping][id] = { x: Math.round(x), y: Math.round(y) };
      n++;
    }
  }
  return board;
}

export function loadBoard(home: string): Board {
  try {
    return sanitizeBoard(JSON.parse(readFileSync(boardPath(home), 'utf8')));
  } catch {
    return emptyBoard();
  }
}

/** Write atomically, so a crash mid-write can't leave a half file. */
export function saveBoard(home: string, board: Board): void {
  const path = boardPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(board));
  renameSync(tmp, path);
}
