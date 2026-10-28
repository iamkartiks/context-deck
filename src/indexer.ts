import { existsSync, watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Adapter } from './adapters/index.js';
import type { Store } from './store.js';

export interface Source {
  adapter: Adapter;
  root: string;
}

export interface IndexSummary {
  scanned: number;
  indexed: number;
  unchanged: number;
  removed: number;
  empty: number;
  failed: number;
  badLines: number;
  errors: { path: string; error: string }[];
  ms: number;
}

export interface IndexOptions {
  /** Re-parse every file, even unchanged ones. */
  full?: boolean;
  onFile?: (path: string, done: number, total: number) => void;
}

/**
 * Bring the index in line with what is on disk.
 *
 * Incremental by default: a file is re-parsed only if its size or mtime
 * changed. Files that disappeared are dropped from the index.
 */
export async function indexSources(store: Store, sources: Source[], opts: IndexOptions = {}): Promise<IndexSummary> {
  const started = Date.now();
  const sum: IndexSummary = {
    scanned: 0,
    indexed: 0,
    unchanged: 0,
    removed: 0,
    empty: 0,
    failed: 0,
    badLines: 0,
    errors: [],
    ms: 0,
  };

  for (const { adapter, root } of sources) {
    const files = await adapter.discover(root);
    const seen = new Set(files);
    let done = 0;

    for (const path of files) {
      done++;
      sum.scanned++;
      opts.onFile?.(path, done, files.length);

      let st;
      try {
        st = await stat(path);
      } catch {
        continue; // vanished between discover and stat
      }
      const prev = store.fileState(path);
      if (!opts.full && prev && prev.size === st.size && prev.mtimeMs === Math.trunc(st.mtimeMs)) {
        sum.unchanged++;
        continue;
      }

      try {
        const result = await adapter.parse(path);
        sum.badLines += result.badLines;
        if (result.session) {
          store.saveSession(path, st.size, st.mtimeMs, result.badLines, result.session);
          sum.indexed++;
        } else {
          store.recordFile(path, adapter.id, st.size, st.mtimeMs, result.badLines, null);
          sum.empty++;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        store.recordFile(path, adapter.id, st.size, st.mtimeMs, 0, message);
        sum.failed++;
        sum.errors.push({ path, error: message });
      }
    }

    // Only prune when the root exists: an unplugged drive should not wipe the index.
    if (existsSync(root)) {
      for (const known of store.knownFiles(adapter.id)) {
        if (!seen.has(known)) {
          store.removeFile(known);
          sum.removed++;
        }
      }
    }
  }

  sum.ms = Date.now() - started;
  return sum;
}

export interface Watcher {
  close(): void;
}

/**
 * Watch every source folder and re-index (incrementally) shortly after changes.
 * Uses native recursive watching where available, and falls back to polling.
 */
export function watchSources(
  store: Store,
  sources: Source[],
  onUpdate: (summary: IndexSummary) => void,
  opts: { debounceMs?: number; pollMs?: number; onError?: (err: unknown) => void } = {},
): Watcher {
  const debounceMs = opts.debounceMs ?? 750;
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let again = false;

  const run = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      const summary = await indexSources(store, sources);
      if (summary.indexed || summary.removed || summary.failed) onUpdate(summary);
    } catch (err) {
      opts.onError?.(err);
    } finally {
      running = false;
      if (again) {
        again = false;
        schedule();
      }
    }
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, debounceMs);
  };

  const watchers: FSWatcher[] = [];
  let poll: NodeJS.Timeout | null = null;

  for (const { root } of sources) {
    if (!existsSync(root)) continue;
    try {
      watchers.push(watch(root, { recursive: true, persistent: true }, () => schedule()));
    } catch {
      poll ??= setInterval(schedule, opts.pollMs ?? 5_000);
    }
  }
  if (watchers.length === 0) poll ??= setInterval(schedule, opts.pollMs ?? 5_000);

  return {
    close() {
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      for (const w of watchers) w.close();
    },
  };
}
