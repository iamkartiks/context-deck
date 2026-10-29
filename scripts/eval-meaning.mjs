#!/usr/bin/env node
/**
 * How well does search by meaning work with your model?
 *
 *   npm run eval:meaning                         (uses your saved settings, or the defaults)
 *   npm run eval:meaning -- --model bge-m3       (try another model)
 *   npm run eval:meaning -- --api openai --url http://127.0.0.1:1234 --model <name>
 *
 * Builds a small set of made-up sessions in a temporary folder, embeds them
 * with your local model, then asks questions that share few or no words with
 * the answer: English paraphrases, Hindi in Devanagari, and Hinglish typed in
 * Latin letters. Reports how often the right session comes first, and in the
 * top 3, compared with word search alone. Nothing here touches your real
 * sessions or index, and nothing leaves your computer unless you point --url
 * elsewhere.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../dist/src/config.js';
import { createEmbedder, EmbedError } from '../dist/src/embedder.js';
import { indexSources } from '../dist/src/indexer.js';
import { catchUp, combine, searchByMeaning } from '../dist/src/semantic.js';
import { loadSettings } from '../dist/src/settings.js';
import { Store } from '../dist/src/store.js';

const { values: v } = parseArgs({
  options: {
    model: { type: 'string' },
    api: { type: 'string' },
    url: { type: 'string' },
    dims: { type: 'string' },
    home: { type: 'string' },
    'allow-remote': { type: 'boolean' },
    verbose: { type: 'boolean' },
  },
});

/** Each topic: one session (prompt + the reply that settled it) and questions about it. */
const TOPICS = [
  {
    id: 'database',
    prompt: 'Where should the job queue keep its state between restarts?',
    reply: "Let's go with Postgres. SQLite locks the whole file on every write, and we already run Postgres for the app.",
    en: 'which chat decided on the database',
    hi: 'किस चैट में डेटाबेस का फ़ैसला हुआ था',
    hinglish: 'kis chat mein database ka decision hua tha',
  },
  {
    id: 'auth',
    prompt: 'Move login off localStorage tokens.',
    reply: 'Sessions now live in an httpOnly, SameSite=Lax cookie, so scripts on the page can no longer read them.',
    en: 'where did we stop keeping the JWT where JavaScript can read it',
    hi: 'लॉगिन टोकन को सुरक्षित कहाँ रखा गया',
    hinglish: 'login token ko safe jagah kahan rakha',
  },
  {
    id: 'ratelimit',
    prompt: 'People are hammering the sign-in endpoint with password guesses.',
    reply: 'Added a limiter: five attempts per minute per IP, then 429 with a Retry-After header.',
    en: 'how did we stop brute-force password attempts',
    hi: 'पासवर्ड अनुमान लगाने वालों को कैसे रोका',
    hinglish: 'password guess karne walon ko kaise roka',
  },
  {
    id: 'feed',
    prompt: 'Readers want to follow the blog in their feed reader.',
    reply: 'scripts/build-feed.mjs now writes public/feed.xml from the posts folder at build time.',
    en: 'subscribe to new posts without visiting the site',
    hi: 'ब्लॉग की नई पोस्ट की सदस्यता',
    hinglish: 'blog ke naye posts follow karne ka tarika',
  },
  {
    id: 'flaky',
    prompt: 'The dedupe test fails randomly on CI, usually right after midnight.',
    reply: 'It built timestamps from the wall clock. The test now uses a fixed clock and passed 200 runs in a row.',
    en: 'the test that only broke at certain times of day',
    hi: 'वह टेस्ट जो कभी-कभी फ़ेल होता था',
    hinglish: 'woh test jo kabhi kabhi fail hota tha',
  },
  {
    id: 'deploy',
    prompt: 'Releases take an hour of clicking around in the console.',
    reply: 'GitHub Actions now builds the image, runs migrations, and rolls the service on every tag. Rollback is re-running the previous tag.',
    en: 'automating how we ship to production',
    hi: 'प्रोडक्शन में रिलीज़ को ऑटोमेट करना',
    hinglish: 'production release ko automate karna',
  },
  {
    id: 'offline',
    prompt: 'What should happen when two phones edit the same note on a plane?',
    reply: 'Three-way merge for the body, last-write-wins for the title, and a visible conflict copy if the merge fails.',
    en: 'resolving conflicting edits made without internet',
    hi: 'बिना इंटरनेट के किए गए बदलावों का टकराव',
    hinglish: 'bina internet ke edits ka conflict kaise solve kiya',
  },
  {
    id: 'darkmode',
    prompt: 'The page flashes white before turning dark.',
    reply: 'An inline script in the head sets the theme class before first paint, so there is no flash.',
    en: 'the bright flicker when the site loads at night',
    hi: 'पेज लोड होते समय सफ़ेद चमक',
    hinglish: 'page load hote waqt white flash aata tha',
  },
  {
    id: 'rounding',
    prompt: 'Cart totals are off by one cent on discounted orders.',
    reply: 'Money is now kept in integer paise and rounded once, at the end, using banker’s rounding.',
    en: 'pennies going missing in checkout maths',
    hi: 'चेकआउट में पैसों की गणना में गड़बड़ी',
    hinglish: 'checkout mein paise ka hisaab galat aa raha tha',
  },
  {
    id: 'cache',
    prompt: 'API responses ko 5 minute ke liye cache karo, Redis mat use karna, simple rakhna.',
    reply: 'Added an in-memory LRU cache with a five minute expiry around the product endpoints.',
    en: 'which session made responses faster without adding Redis',
    hi: 'बिना Redis के कैशिंग',
    hinglish: 'bina redis ke caching wala session',
  },
];

const LANGS = [
  ['en', 'English, different words'],
  ['hi', 'Hindi (Devanagari)'],
  ['hinglish', 'Hinglish (Latin letters)'],
];

const saved = loadSettings(v.home ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.contextdeck')).semantic;
const settings = {
  ...saved,
  enabled: true,
  ...(v.api ? { api: v.api } : {}),
  ...(v.url ? { url: v.url } : v.api && v.api !== saved.api ? { url: v.api === 'openai' ? 'http://127.0.0.1:1234' : 'http://127.0.0.1:11434' } : {}),
  ...(v.model ? { model: v.model } : {}),
  ...(v.dims ? { dims: Number(v.dims) } : {}),
  ...(v['allow-remote'] ? { allowRemote: true } : {}),
};

// Check the model answers before doing anything else, and explain how to fix it if not
console.log(`Model: ${settings.model} via ${settings.api} at ${settings.url}${settings.dims ? `, ${settings.dims} dims` : ''}`);
try {
  await createEmbedder(settings).embed(['ContextDeck check'], 'query');
} catch (err) {
  if (!(err instanceof EmbedError)) throw err;
  const ollama = settings.api === 'ollama';
  console.error(`\nCouldn't use the model: ${err.message}\n`);
  if (ollama) {
    console.error(
      [
        'To run this check with Ollama:',
        '  1. Install it: https://ollama.com/download  (on a Mac you can also use: brew install ollama)',
        '  2. Start it: open the Ollama app, or run `ollama serve` in another terminal',
        `  3. Get the model: ollama pull ${settings.model}`,
        '  4. Run this again: npm run eval:meaning',
        '',
        'Check it is running with: curl http://127.0.0.1:11434/api/version',
      ].join('\n'),
    );
  }
  console.error(
    `\nUsing LM Studio, llama.cpp or vLLM instead? npm run eval:meaning -- --api openai --url http://127.0.0.1:1234 --model <name>`,
  );
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'contextdeck-eval-'));
try {
  // One Claude Code-style session per topic
  const claude = join(dir, 'claude');
  TOPICS.forEach((t, i) => {
    const id = `eeeeeeee-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const folder = join(claude, 'projects', `-eval-${t.id}`);
    mkdirSync(folder, { recursive: true });
    const base = { sessionId: id, cwd: `/eval/${t.id}` };
    const at = (s) => new Date(Date.UTC(2026, 9, 1 + i, 10, 0, s)).toISOString();
    writeFileSync(
      join(folder, `${id}.jsonl`),
      [
        { ...base, type: 'user', uuid: 'u1', timestamp: at(0), message: { role: 'user', content: t.prompt } },
        { ...base, type: 'assistant', uuid: 'a1', timestamp: at(5), message: { id: `m${i}`, role: 'assistant', content: [{ type: 'text', text: t.reply }] } },
      ]
        .map((o) => JSON.stringify(o))
        .join('\n') + '\n',
    );
    t.sessionId = `claude-code:${id}`;
  });

  const cfg = loadConfig({ home: join(dir, 'home'), claudeDir: claude, codexDir: join(dir, 'none'), qwenDir: join(dir, 'none') }, {});
  const store = new Store(cfg.dbPath);
  await indexSources(store, cfg.sources);
  const embedder = createEmbedder(settings);
  const t0 = Date.now();
  const r = await catchUp(store, embedder, cfg.home);
  console.log(`Embedded ${r.pieces} pieces in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  const rows = [];
  for (const [lang, label] of LANGS) {
    let words1 = 0;
    let top1 = 0;
    let top3 = 0;
    for (const t of TOPICS) {
      const q = t[lang];
      const words = store.search(q, { limit: 50 });
      const meaning = await searchByMeaning(store, embedder, q, { home: cfg.home });
      const hits = combine(store, words, meaning, 10);
      const rank = hits.findIndex((h) => h.session.id === t.sessionId);
      if (words[0]?.session.id === t.sessionId) words1++;
      if (rank === 0) top1++;
      if (rank >= 0 && rank < 3) top3++;
      if (v.verbose) console.log(`  ${rank === 0 ? '✓' : rank > 0 && rank < 3 ? '~' : '✗'} [${lang}] ${q}  →  ${hits[0] ? TOPICS.find((x) => x.sessionId === hits[0].session.id)?.id : '(nothing)'}${meaning[0] ? ` (${meaning[0].score.toFixed(2)})` : ''}`);
    }
    rows.push([label, words1, top1, top3]);
  }
  const n = TOPICS.length;
  const pad = (s, w) => String(s).padEnd(w);
  console.log(`${pad('Questions', 28)}${pad('words only, 1st', 18)}${pad('with meaning, 1st', 20)}with meaning, top 3`);
  for (const [label, w, t1, t3] of rows) console.log(`${pad(label, 28)}${pad(`${w}/${n}`, 18)}${pad(`${t1}/${n}`, 20)}${t3}/${n}`);
  console.log('\nRun with --verbose to see each question. Try other models with --model.');
  store.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
