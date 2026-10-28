import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import * as zlib from 'node:zlib';

export type JsonlLine = { ok: true; value: unknown; lineNo: number } | { ok: false; lineNo: number };

export function zstdSupported(): boolean {
  return typeof (zlib as Record<string, unknown>).createZstdDecompress === 'function';
}

function openStream(path: string): Readable {
  const raw = createReadStream(path);
  if (path.endsWith('.zst')) {
    const create = (zlib as unknown as { createZstdDecompress?: () => NodeJS.ReadWriteStream })
      .createZstdDecompress;
    if (!create) {
      raw.destroy();
      throw new Error(`Cannot read ${path}: this Node version has no zstd support (needs Node 22.15+).`);
    }
    return raw.pipe(create()) as unknown as Readable;
  }
  return raw;
}

/**
 * Stream a JSONL file line by line, never loading the whole file.
 * Session files can be hundreds of megabytes, so this matters.
 * Blank lines are skipped; malformed lines are reported as { ok: false }.
 */
export async function* readJsonl(path: string): AsyncGenerator<JsonlLine> {
  const rl = createInterface({ input: openStream(path), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    if (!line.trim()) continue;
    try {
      yield { ok: true, value: JSON.parse(line), lineNo };
    } catch {
      yield { ok: false, lineNo };
    }
  }
}

/** Recursively list files under `root` that satisfy `accept`. Missing root → []. */
export async function listFiles(root: string, accept: (relPath: string) => boolean): Promise<string[]> {
  let entries: string[];
  try {
    entries = (await readdir(root, { recursive: true })) as string[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((rel) => accept(rel))
    .map((rel) => join(root, rel))
    .sort();
}
