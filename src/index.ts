/**
 * Library entry point. The CLI is one consumer; the upcoming UI and anyone
 * building on contextdeck can import the same pieces.
 */
export * from './schema.js';
export { ADAPTERS, getAdapter, type Adapter, type ResumeCommand } from './adapters/index.js';
export { claudeCodeAdapter } from './adapters/claude-code.js';
export { codexAdapter } from './adapters/codex.js';
export { Store, toFtsQuery, shortIdFor, type SearchHit, type ProjectRow, type RelatedRow } from './store.js';
export { indexSources, watchSources, type Source, type IndexSummary } from './indexer.js';
export { loadConfig, type Config } from './config.js';
export { redact } from './util/redact.js';
