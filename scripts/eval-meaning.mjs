#!/usr/bin/env node
/**
 * How well does search by meaning work with your model, and what cutoff suits it?
 *
 *   npm run eval:meaning                         (uses your saved settings, or the defaults)
 *   npm run eval:meaning -- --model bge-m3       (try another model)
 *   npm run eval:meaning -- --api openai --url http://127.0.0.1:1234 --model <name>
 *   npm run eval:meaning -- --verbose            (every question and its scores)
 *   npm run eval:meaning -- --json               (everything, to paste into an issue)
 *
 * Builds made-up sessions in a temporary folder and embeds them with your local
 * model. Ten topics each have one session that settled something, plus two
 * look-alike sessions on a similar subject that didn't. Then it asks:
 *
 *   - questions with one right answer, sharing few or no words with it, in
 *     English, Hindi (Devanagari) and Hinglish (Latin letters): does the right
 *     session come first, ahead of its look-alikes?
 *   - questions whose answer isn't in any session: search by meaning should
 *     add nothing, rather than its closest guesses.
 *
 * The cutoff (the lowest score a match by meaning needs) trades those two off.
 * The script tries every cutoff and suggests the one that gets the most of
 * both right.
 *
 * Nothing here touches your real sessions or index, and nothing leaves your
 * computer unless you point --url elsewhere.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../dist/src/config.js';
import { createEmbedder, EmbedError } from '../dist/src/embedder.js';
import { indexSources } from '../dist/src/indexer.js';
import { catchUp, combine, defaultMinScore, searchByMeaning } from '../dist/src/semantic.js';
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
    json: { type: 'boolean' },
  },
});

/**
 * Each topic: the session that settled something, two look-alikes on a
 * similar subject that didn't, and a question in each language whose answer
 * is the first session.
 */
const TOPICS = [
  {
    id: 'database',
    prompt: 'Where should the job queue keep its state between restarts?',
    reply: "Let's go with Postgres. SQLite locks the whole file on every write, and we already run Postgres for the app.",
    lookalikes: [
      ['The reporting dashboard query on orders takes 12 seconds.', 'Added an index on orders(created_at, status); it now takes 80 ms.'],
      ['Can we upgrade MySQL on the analytics box this weekend?', 'Yes, but take a snapshot first; the upgrade needs about 20 minutes in read-only mode.'],
    ],
    en: 'which chat decided what database the job queue uses',
    hi: 'जॉब क्यू के लिए कौन सा डेटाबेस चुना गया था',
    hinglish: 'job queue ke liye kaunsa database choose kiya tha',
  },
  {
    id: 'auth',
    prompt: 'Move login off localStorage tokens.',
    reply: 'Sessions now live in an httpOnly, SameSite=Lax cookie, so scripts on the page can no longer read them.',
    lookalikes: [
      ['Add a forgot-password email.', 'The reset link expires after 30 minutes and works only once.'],
      ['Users get logged out every hour.', "The refresh token wasn't being rotated; it now renews on every request."],
    ],
    en: 'where did we stop keeping the login token where JavaScript can read it',
    hi: 'लॉगिन टोकन को पेज की स्क्रिप्ट से कहाँ छिपाया गया',
    hinglish: 'login token ko javascript se chhupane wala session',
  },
  {
    id: 'ratelimit',
    prompt: 'People are hammering the sign-in endpoint with password guesses.',
    reply: 'Added a limiter: five attempts per minute per IP, then 429 with a Retry-After header.',
    lookalikes: [
      ['Our OpenAI bill doubled this month.', 'Completions are cached now, and each user is capped at 50 requests a day.'],
      ['The sign-up form is getting spam bots.', 'Added a honeypot field and a captcha on sign-up.'],
    ],
    en: 'how did we stop brute-force password attempts',
    hi: 'पासवर्ड अनुमान लगाने वालों को कैसे रोका',
    hinglish: 'password guess karne walon ko kaise roka',
  },
  {
    id: 'feed',
    prompt: 'Readers want to follow the blog in their feed reader.',
    reply: 'scripts/build-feed.mjs now writes public/feed.xml from the posts folder at build time.',
    lookalikes: [
      ['Add a sitemap for search engines.', 'scripts/build-sitemap.mjs writes public/sitemap.xml on every build.'],
      ['Send new posts to the newsletter automatically.', 'Each new post is now sent to Buttondown through its API when it is published.'],
    ],
    en: 'letting people follow the blog in a feed reader',
    hi: 'ब्लॉग को फ़ीड रीडर में फ़ॉलो करना',
    hinglish: 'blog ko feed reader mein follow karne ka tarika',
  },
  {
    id: 'flaky',
    prompt: 'The dedupe test fails randomly on CI, usually right after midnight.',
    reply: 'It built timestamps from the wall clock. The test now uses a fixed clock and passed 200 runs in a row.',
    lookalikes: [
      ['CI takes 25 minutes.', 'Split the test suite across 4 runners; CI now takes 7 minutes.'],
      ['The end-to-end login test fails on Safari only.', 'Safari blocks the third-party cookie in the iframe; the test now logs in directly.'],
    ],
    en: 'the test that only broke at certain times of day',
    hi: 'वह टेस्ट जो आधी रात के आसपास फ़ेल होता था',
    hinglish: 'woh test jo raat ke 12 baje ke aas paas fail hota tha',
  },
  {
    id: 'deploy',
    prompt: 'Releases take an hour of clicking around in the console.',
    reply: 'GitHub Actions now builds the image, runs migrations, and rolls the service on every tag. Rollback is re-running the previous tag.',
    lookalikes: [
      ['Set up a staging environment.', 'Staging is a copy of production on a smaller instance, refreshed every night.'],
      ['Our Docker image is 2 GB.', 'A multi-stage build brings the image down to 180 MB.'],
    ],
    en: 'automating how we ship to production',
    hi: 'प्रोडक्शन में रिलीज़ को ऑटोमेट करना',
    hinglish: 'production release ko automate karna',
  },
  {
    id: 'offline',
    prompt: 'What should happen when two phones edit the same note on a plane?',
    reply: 'Three-way merge for the body, last-write-wins for the title, and a visible conflict copy if the merge fails.',
    lookalikes: [
      ['Sync is draining the battery.', 'Background sync now runs every 15 minutes instead of every minute.'],
      ['Attachments fail to upload on slow networks.', 'Uploads are sent in chunks and resume where they stopped.'],
    ],
    en: 'resolving conflicting edits made without internet',
    hi: 'बिना इंटरनेट के किए गए बदलावों का टकराव कैसे सुलझाया',
    hinglish: 'bina internet ke edits ka conflict kaise solve kiya',
  },
  {
    id: 'darkmode',
    prompt: 'The page flashes white before turning dark.',
    reply: 'An inline script in the head sets the theme class before first paint, so there is no flash.',
    lookalikes: [
      ['Add a dark theme to the docs site.', 'The docs now follow the system setting through prefers-color-scheme.'],
      ['Text flashes in the wrong font on first load.', 'Fonts are preloaded and use font-display: optional.'],
    ],
    en: 'the bright flicker when the site loads at night',
    hi: 'डार्क मोड में पेज लोड होते समय सफ़ेद चमक',
    hinglish: 'dark mode mein page load hote waqt white flash aata tha',
  },
  {
    id: 'rounding',
    prompt: 'Cart totals are off by one cent on discounted orders.',
    reply: 'Money is now kept in integer paise and rounded once, at the end, using banker’s rounding.',
    lookalikes: [
      ['Show prices in euros too.', 'Prices are converted at checkout using the daily ECB rate.'],
      ['Invoices need GST.', 'Invoices now add 18% GST per line and show it separately.'],
    ],
    en: 'pennies going missing in checkout maths',
    hi: 'चेकआउट में पैसों की गणना में गड़बड़ी',
    hinglish: 'checkout mein paise ka hisaab galat aa raha tha',
  },
  {
    id: 'cache',
    prompt: 'API responses ko 5 minute ke liye cache karo, Redis mat use karna, simple rakhna.',
    reply: 'Added an in-memory LRU cache with a five minute expiry around the product endpoints.',
    lookalikes: [
      ['Product images load slowly.', 'Images are served through the CDN with a one-year cache header.'],
      ['Redis keeps running out of memory on the sessions box.', 'Set maxmemory with the allkeys-lru policy.'],
    ],
    en: 'which session made responses faster without adding Redis',
    hi: 'बिना Redis के API को तेज़ करना',
    hinglish: 'bina redis ke API fast karne wala session',
  },
];

/** Questions about things no session covers. Search by meaning should add nothing. */
const NO_ANSWER = [
  { en: 'setting up Kubernetes autoscaling', hi: 'कुबेरनेट्स ऑटोस्केलिंग सेट करना', hinglish: 'kubernetes autoscaling setup karna' },
  { en: 'translating the app into French', hi: 'ऐप का फ़्रेंच में अनुवाद करना', hinglish: 'app ko french mein translate karna' },
  { en: 'sending push notifications on iOS', hi: 'iOS पर पुश नोटिफ़िकेशन भेजना', hinglish: 'iphone pe push notification bhejna' },
  { en: 'designing the GraphQL schema', hi: 'GraphQL स्कीमा डिज़ाइन करना', hinglish: 'graphql schema design karna' },
  { en: 'choosing a logo and brand colours', hi: 'लोगो और ब्रांड के रंग चुनना', hinglish: 'logo aur brand colours choose karna' },
  { en: 'a machine learning model for product recommendations', hi: 'उत्पाद सुझाव के लिए मशीन लर्निंग', hinglish: 'product recommendation ke liye ML model' },
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
// Trying a different model than the saved one: use that model's default cutoff, not yours
const current = v.model && v.model !== saved.model ? defaultMinScore(settings.model) : (saved.minScore ?? defaultMinScore(settings.model));
const say = (...a) => !v.json && console.log(...a);

// Check the model answers before doing anything else, and explain how to fix it if not
say(`Model: ${settings.model} via ${settings.api} at ${settings.url}${settings.dims ? `, ${settings.dims} dims` : ''}`);
try {
  await createEmbedder(settings).embed(['ContextDeck check'], 'query');
} catch (err) {
  if (!(err instanceof EmbedError)) throw err;
  console.error(`\nCouldn't use the model: ${err.message}\n`);
  if (settings.api === 'ollama') {
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
  console.error(`\nUsing LM Studio, llama.cpp or vLLM instead? npm run eval:meaning -- --api openai --url http://127.0.0.1:1234 --model <name>`);
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'contextdeck-eval-'));
try {
  // One Claude Code-style session per conversation
  const claude = join(dir, 'claude');
  let n = 0;
  const writeSession = (slug, prompt, reply) => {
    const i = n++;
    const id = `eeeeeeee-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const folder = join(claude, 'projects', `-eval-${slug}`);
    mkdirSync(folder, { recursive: true });
    const base = { sessionId: id, cwd: `/eval/${slug}` };
    const at = (s) => new Date(Date.UTC(2026, 8, 1, 10, i, s)).toISOString();
    writeFileSync(
      join(folder, `${id}.jsonl`),
      [
        { ...base, type: 'user', uuid: 'u1', timestamp: at(0), message: { role: 'user', content: prompt } },
        { ...base, type: 'assistant', uuid: 'a1', timestamp: at(5), message: { id: `m${i}`, role: 'assistant', content: [{ type: 'text', text: reply }] } },
      ]
        .map((o) => JSON.stringify(o))
        .join('\n') + '\n',
    );
    return `claude-code:${id}`;
  };
  for (const t of TOPICS) {
    t.sessionId = writeSession(t.id, t.prompt, t.reply);
    t.lookalikes.forEach(([p, r], k) => writeSession(`${t.id}-lookalike-${k + 1}`, p, r));
  }

  const cfg = loadConfig({ home: join(dir, 'home'), claudeDir: claude, codexDir: join(dir, 'none'), qwenDir: join(dir, 'none') }, {});
  const store = new Store(cfg.dbPath);
  await indexSources(store, cfg.sources);
  const embedder = createEmbedder(settings);
  const t0 = Date.now();
  const r = await catchUp(store, embedder, cfg.home);
  say(`Embedded ${r.pieces} pieces from ${n} sessions in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  // Ask every question once; cutoffs are tried afterwards on the same results
  const asked = [];
  for (const [lang] of LANGS) {
    for (const t of TOPICS) asked.push({ lang, q: t[lang], answer: t.sessionId, topic: t.id });
    for (const x of NO_ANSWER) asked.push({ lang, q: x[lang], answer: null, topic: null });
  }
  for (const a of asked) {
    a.words = store.search(a.q, { limit: 50 });
    a.meaning = await searchByMeaning(store, embedder, a.q, { home: cfg.home, limit: 60 });
    a.rightScore = a.answer ? (a.meaning.find((m) => m.sessionId === a.answer)?.score ?? null) : null;
    a.bestWrong = a.meaning.find((m) => m.sessionId !== a.answer)?.score ?? null;
  }

  /** What search shows at a given cutoff: is the right session first / in the top 3; did meaning add anything to a no-answer question? */
  const judge = (a, minScore) => {
    const hits = combine(store, a.words, a.meaning, 10, { minScore });
    const rank = a.answer ? hits.findIndex((h) => h.session.id === a.answer) : -1;
    return { rank, added: hits.filter((h) => h.via === 'meaning').length, top: hits[0]?.session.id ?? null };
  };

  const answerable = asked.filter((a) => a.answer);
  const noAnswer = asked.filter((a) => !a.answer);
  const tally = (minScore) => ({
    first: answerable.filter((a) => judge(a, minScore).rank === 0).length,
    clean: noAnswer.filter((a) => judge(a, minScore).added === 0).length,
  });

  // Try every cutoff; the best ones get the most right first plus the most no-answer questions clean.
  // Of equally good cutoffs, take the middle one: it's the least sensitive to small score changes.
  const sweep = [];
  for (let c = 0; c <= 0.9001; c += 0.01) sweep.push({ cutoff: Math.round(c * 100) / 100, ...tally(c) });
  const bestTotal = Math.max(...sweep.map((s) => s.first + s.clean));
  const best = sweep.filter((s) => s.first + s.clean === bestTotal);
  const suggested = best[Math.floor((best.length - 1) / 2)];
  const now = { cutoff: current, ...tally(current) };

  const rows = LANGS.map(([lang, label]) => {
    const qs = answerable.filter((a) => a.lang === lang);
    const nq = noAnswer.filter((a) => a.lang === lang);
    const at = (c) => ({
      first: qs.filter((a) => judge(a, c).rank === 0).length,
      top3: qs.filter((a) => {
        const k = judge(a, c).rank;
        return k >= 0 && k < 3;
      }).length,
      clean: nq.filter((a) => judge(a, c).added === 0).length,
    });
    return { lang, label, words: qs.filter((a) => a.words[0]?.session.id === a.answer).length, total: qs.length, noAnswer: nq.length, now: at(current), suggested: at(suggested.cutoff) };
  });

  const scores = (xs) => {
    const s = xs.filter((x) => x != null).sort((a, b) => a - b);
    if (!s.length) return null;
    const r2 = (x) => Math.round(x * 100) / 100;
    return { lowest: r2(s[0]), median: r2(s[Math.floor(s.length / 2)]), highest: r2(s[s.length - 1]) };
  };
  const summary = {
    model: settings.model,
    api: settings.api,
    dims: settings.dims,
    sessions: n,
    pieces: r.pieces,
    rows,
    scores: {
      right: scores(answerable.map((a) => a.rightScore)),
      bestWrongOnAnswerable: scores(answerable.map((a) => a.bestWrong)),
      bestOnNoAnswer: scores(noAnswer.map((a) => a.meaning[0]?.score ?? null)),
    },
    cutoff: { current: now, suggested },
    questions: asked.map((a) => ({
      lang: a.lang,
      q: a.q,
      expected: a.topic,
      right: a.rightScore == null ? null : Math.round(a.rightScore * 1000) / 1000,
      bestWrong: a.bestWrong == null ? null : Math.round(a.bestWrong * 1000) / 1000,
    })),
  };

  if (v.json) {
    console.log(JSON.stringify(summary, null, 1));
  } else {
    const pad = (s, w) => String(s).padEnd(w);
    const total = answerable.length;
    say(`Finding the right session among look-alikes (${total} questions), at your current cutoff (${current})`);
    say(`  ${pad('', 28)}${pad('words only, 1st', 18)}${pad('meaning, 1st', 15)}meaning, top 3`);
    for (const row of rows) say(`  ${pad(row.label, 28)}${pad(`${row.words}/${row.total}`, 18)}${pad(`${row.now.first}/${row.total}`, 15)}${row.now.top3}/${row.total}`);
    say(`\nQuestions with no answer (${noAnswer.length}): meaning should add nothing`);
    for (const row of rows) say(`  ${pad(row.label, 28)}added nothing for ${row.now.clean}/${row.noAnswer}`);

    const sc = summary.scores;
    say(`\nScores`);
    say(`  right answer:                  lowest ${sc.right?.lowest}, median ${sc.right?.median}`);
    say(`  best wrong one (look-alikes):  median ${sc.bestWrongOnAnswerable?.median}, highest ${sc.bestWrongOnAnswerable?.highest}`);
    say(`  best match, no-answer:         median ${sc.bestOnNoAnswer?.median}, highest ${sc.bestOnNoAnswer?.highest}`);

    say(`\nCutoffs (right first out of ${total}; no-answer questions with nothing added, out of ${noAnswer.length})`);
    const show = [...new Set([current, ...[-0.1, -0.05, -0.02, 0, 0.02, 0.05, 0.1].map((d) => Math.round((suggested.cutoff + d) * 100) / 100)])]
      .filter((c) => c >= 0 && c <= 0.9)
      .sort((a, b) => a - b);
    for (const c of show) {
      const t = sweep.find((s) => Math.abs(s.cutoff - c) < 0.001) ?? { cutoff: c, ...tally(c) };
      const tag = [c === current ? 'current' : '', c === suggested.cutoff ? 'suggested' : ''].filter(Boolean).join(', ');
      say(`  ${pad(c.toFixed(2), 6)} ${pad(`${t.first}/${total}`, 8)} ${pad(`${t.clean}/${noAnswer.length}`, 8)} ${tag ? `← ${tag}` : ''}`);
    }
    if (suggested.cutoff !== current) {
      say(`\nTo use the suggested cutoff:  contextdeck semantic enable --min-score ${suggested.cutoff}`);
    } else {
      say('\nThe current cutoff is already the best one for this model.');
    }

    if (v.verbose) {
      say('\nEvery question (score of the right session; best wrong one):');
      for (const a of asked) {
        const j = judge(a, suggested.cutoff);
        const mark = a.answer ? (j.rank === 0 ? '✓' : j.rank > 0 && j.rank < 3 ? '~' : '✗') : j.added === 0 ? '✓' : '✗';
        const detail = a.answer
          ? `right ${a.rightScore?.toFixed(2) ?? '—'}, best wrong ${a.bestWrong?.toFixed(2) ?? '—'}`
          : `best match ${a.meaning[0]?.score.toFixed(2) ?? '—'}${j.added ? `, adds ${j.added}` : ''}`;
        say(`  ${mark} [${a.lang}] ${a.q}  (${detail})`);
      }
    }
    say('\nShare the results with: npm run eval:meaning -- --json');
  }
  store.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
