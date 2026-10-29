import { checkAllowed, createEmbedder, EmbedError, type Embedder } from './embedder.js';
import { catchUp, combine, defaultMinScore, hasMeasuredCutoff, searchByMeaning, type CombinedHit, type Progress } from './semantic.js';
import { DEFAULT_URLS, loadSettings, saveSettings, type SemanticSettings } from './settings.js';
import type { SearchHit, Store } from './store.js';

/**
 * Search by meaning as a service: what the canvas server and the CLI use.
 * Holds the settings, runs one catch-up at a time in the background, reports
 * progress, and falls back to word search whenever the model can't be reached.
 */

export type MeaningState = 'off' | 'catching-up' | 'ready' | 'error';

export interface MeaningStatus {
  enabled: boolean;
  state: MeaningState;
  api: SemanticSettings['api'];
  url: string;
  model: string;
  dims: number;
  /** The lowest score a match by meaning needs (yours, or the model's default). */
  minScore: number;
  /** Pieces and sessions with vectors for the current model. */
  pieces: number;
  sessions: number;
  bytes: number;
  /** While catching up. */
  progress: Progress | null;
  /** The last problem talking to the model, if any. */
  error: string | null;
}

export class MeaningService {
  private settings: SemanticSettings;
  private running: Promise<void> | null = null;
  private again = false;
  private abort: AbortController | null = null;
  private progress: Progress | null = null;
  private error: string | null = null;
  private listeners = new Set<(s: MeaningStatus) => void>();
  private lastEmit = 0;

  constructor(
    private store: Store,
    private home: string,
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.settings = loadSettings(home).semantic;
  }

  get enabled(): boolean {
    return this.settings.enabled;
  }

  /** True when neither you nor a measurement set the cutoff for this model. */
  cutoffIsGeneric(): boolean {
    return this.settings.minScore == null && !hasMeasuredCutoff(this.settings.model);
  }

  private embedder(): Embedder {
    return createEmbedder(this.settings, this.fetchImpl);
  }

  status(): MeaningStatus {
    const s = this.settings;
    const stats = s.enabled ? this.store.chunkStats(this.embedder().key) : { pieces: 0, sessions: 0, bytes: 0 };
    return {
      enabled: s.enabled,
      state: !s.enabled ? 'off' : this.running ? 'catching-up' : this.error ? 'error' : 'ready',
      api: s.api,
      url: s.url,
      model: s.model,
      dims: s.dims,
      minScore: s.minScore ?? defaultMinScore(s.model),
      ...stats,
      progress: this.running ? this.progress : null,
      error: this.error,
    };
  }

  onChange(fn: (s: MeaningStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastEmit < 400) return;
    this.lastEmit = now;
    const st = this.status();
    for (const fn of this.listeners) fn(st);
  }

  /**
   * Check the model answers, then save and turn on. Throws a readable error
   * (nothing is saved) if it doesn't. Starts catching up in the background.
   */
  async enable(input: Partial<SemanticSettings>, opts: { background?: boolean } = {}): Promise<MeaningStatus> {
    const next: SemanticSettings = { ...this.settings, ...input, enabled: true };
    if (input.api && !input.url && input.api !== this.settings.api) next.url = DEFAULT_URLS[input.api];
    checkAllowed(next);
    const [v] = await createEmbedder(next, this.fetchImpl).embed(['ContextDeck check'], 'query');
    if (!v?.length) throw new EmbedError(`"${next.model}" didn't return a vector.`);
    const all = loadSettings(this.home);
    all.semantic = next;
    saveSettings(this.home, all);
    const modelChanged = next.model !== this.settings.model || next.dims !== this.settings.dims || next.api !== this.settings.api;
    this.settings = all.semantic;
    this.error = null;
    if (modelChanged) this.stop();
    if (opts.background !== false) this.kick();
    this.emit(true);
    return this.status();
  }

  /** Ask the model for one vector, to see that it answers. Records and returns any problem. */
  async check(): Promise<string | null> {
    try {
      await this.embedder().embed(['ContextDeck check'], 'query');
      this.error = null;
    } catch (err) {
      this.error = (err as Error).message;
    }
    return this.error;
  }

  /** Turn off. With drop, also delete the stored vectors. */
  disable(opts: { drop?: boolean } = {}): MeaningStatus {
    this.stop();
    const all = loadSettings(this.home);
    all.semantic.enabled = false;
    saveSettings(this.home, all);
    this.settings = all.semantic;
    this.error = null;
    if (opts.drop) {
      this.store.dropChunks();
      this.store.reclaim();
    }
    this.emit(true);
    return this.status();
  }

  stop(): void {
    this.abort?.abort();
    this.again = false;
  }

  /** Bring vectors up to date in the background (after indexing). Safe to call often. */
  kick(): void {
    if (!this.settings.enabled) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.runOnce().finally(() => {
      this.running = null;
      this.emit(true);
      if (this.again) {
        this.again = false;
        this.kick();
      }
    });
  }

  /** Wait for any background work (tests, CLI). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  /** Catch up in the foreground, reporting progress (CLI). */
  async run(onProgress?: (p: Progress) => void, signal?: AbortSignal): Promise<{ pieces: number; sessions: number; stopped: boolean }> {
    await this.idle();
    const r = await catchUp(this.store, this.embedder(), this.home, { onProgress, signal });
    return { pieces: r.pieces, sessions: r.sessionsDone, stopped: r.stopped };
  }

  private async runOnce(): Promise<void> {
    this.abort = new AbortController();
    this.progress = { sessionsTotal: 0, sessionsDone: 0, pieces: 0 };
    try {
      await catchUp(this.store, this.embedder(), this.home, {
        signal: this.abort.signal,
        onProgress: (p) => {
          this.progress = p;
          this.emit();
        },
      });
      this.error = null;
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.abort = null;
      this.progress = null;
    }
  }

  /**
   * Word search plus meaning. If meaning is off, not ready, or the model
   * can't be reached, the word results come back unchanged (via "words").
   */
  async search(query: string, words: SearchHit[], limit: number): Promise<{ hits: CombinedHit[]; usedMeaning: boolean; error: string | null }> {
    const plain = (error: string | null) => ({ hits: words.slice(0, limit).map((h) => ({ ...h, via: 'words' as const })), usedMeaning: false, error });
    if (!this.settings.enabled || !query.trim()) return plain(null);
    try {
      const meaning = await searchByMeaning(this.store, this.embedder(), query, { home: this.home });
      if (this.error && !this.running) {
        this.error = null;
        this.emit(true);
      }
      const minScore = this.settings.minScore ?? defaultMinScore(this.settings.model);
      return { hits: combine(this.store, words, meaning, limit, { minScore }), usedMeaning: true, error: null };
    } catch (err) {
      this.error = (err as Error).message;
      this.emit(true);
      return plain(this.error);
    }
  }
}
