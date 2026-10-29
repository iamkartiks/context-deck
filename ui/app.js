// ContextDeck UI: a calm board for chaotic context.
// Plain ES module, no build step, no dependencies. Talks only to the local
// server that served this page.

const TOKEN = document.querySelector('meta[name="contextdeck-token"]')?.getAttribute('content') ?? '';

// ── Helpers ───────────────────────────────────────────────────────────────

const $ = (sel, root = document) => root.querySelector(sel);
const SVG = 'http://www.w3.org/2000/svg';

/** Build an element. Strings become text nodes, so session text can never inject markup. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function s(tag, attrs = {}) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  return el;
}

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** «match» markers from the server become <mark> elements; everything else stays text. */
function marked(snippet) {
  const out = [];
  const re = /«([^»]*)»/g;
  let last = 0;
  let m;
  while ((m = re.exec(snippet))) {
    if (m.index > last) out.push(snippet.slice(last, m.index));
    out.push(h('mark', {}, m[1]));
    last = re.lastIndex;
  }
  if (last < snippet.length) out.push(snippet.slice(last));
  return out;
}

/** The words of a search, roughly stemmed ("decided" → "decid"), for highlighting inside messages. */
function termsOf(q) {
  return (q.match(/"[^"]*"|\S+/g) ?? [])
    .filter((t) => !['OR', 'AND', 'NOT'].includes(t))
    .map((t) => t.replace(/^"|"$/g, '').replace(/\*$/, '').toLowerCase().trim())
    .filter((t) => t.length >= 2)
    .map((t) => (t.length > 4 && !t.includes(' ') ? t.replace(/(ing|ed|es|ion|s|e)$/, '') : t));
}

/** Text with every occurrence of the search words wrapped in <mark>. */
function highlight(text, terms) {
  if (!terms.length) return [text];
  const re = new RegExp(`(?:${terms.map(escapeRe).join('|')})[\\p{L}\\p{N}]*`, 'giu');
  const out = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(h('mark', {}, m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Same rule as the server: every word must appear in the decision or its session's title. */
function decisionMatches(d, q) {
  const words = q.toLowerCase().replace(/["*]/g, ' ').split(/\s+/).filter((w) => w && !['and', 'or', 'not'].includes(w));
  if (!words.length) return true;
  const hay = `${d.text} ${d.session?.title ?? ''}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** The decision mark: a small flag. */
function flag() {
  const svg = s('svg', { class: 'flag', width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': 'true' });
  svg.append(s('path', { d: 'M2.5 11 V1.5 M2.5 2 H9.5 L8 4.4 L9.5 6.8 H2.5' }));
  return svg;
}

const prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`contextdeck.${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`contextdeck.${key}`, JSON.stringify(value));
    } catch {
      /* storage can be unavailable; preferences are optional */
    }
  },
};

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'X-ContextDeck-Token': TOKEN } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

/** Deterministic pseudo-random in [0, 1) for a key, so the mess is the same mess every time. */
function rand(key) {
  let x = 2166136261;
  for (let i = 0; i < key.length; i++) x = Math.imul(x ^ key.charCodeAt(i), 16777619);
  x = Math.imul(x ^ (x >>> 15), x | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function ago(iso) {
  if (!iso) return '';
  const sec = (Date.now() - Date.parse(iso)) / 1000;
  if (sec < 90) return 'now';
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  const hr = Math.round(m / 60);
  if (hr < 48) return `${hr}h`;
  const d = Math.round(hr / 24);
  if (d < 30) return `${d}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function agoLong(iso) {
  if (!iso) return 'unknown';
  const sec = (Date.parse(iso) - Date.now()) / 1000;
  const abs = Math.abs(sec);
  if (abs < 60) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(sec / 60), 'minute');
  if (abs < 86400 * 2) return rtf.format(Math.round(sec / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(sec / 86400), 'day');
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function fullDate(iso) {
  return iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'unknown';
}

function tokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const TIMES = ['never', 'once', 'twice'];
const times = (n) => TIMES[n] ?? `${n} times`;
const uniq = (a) => [...new Set(a)];

/** Shorten long titles at a word boundary, as cards only have room for three lines. */
function shortTitle(t, max = 70) {
  if (t.length <= max) return t;
  return t.slice(0, max - 3).replace(/\s+\S*$/, '') + '…';
}

/**
 * How full a session's context window is.
 * Claude Code doesn't record its window size, so it is estimated (200k, or 1M
 * once a session has gone past 200k) and shown with a "~".
 */
function contextOf(sess) {
  if (!sess.contextTokens) return null;
  let win = sess.contextWindow;
  let estimated = false;
  if (!win && sess.provider === 'claude-code') {
    win = sess.contextTokens > 200_000 ? 1_000_000 : 200_000;
    estimated = true;
  }
  if (!win) return { tokens: sess.contextTokens, window: null, pct: null, estimated };
  return { tokens: sess.contextTokens, window: win, pct: Math.min(1, sess.contextTokens / win), estimated };
}

const pctOf = (c) => Math.round((c?.pct ?? 0) * 100);

/** Show a file relative to the session's folder when it is inside it. */
function shortPath(file, cwd) {
  if (!cwd) return file;
  const base = cwd.replace(/[\\/]+$/, '');
  for (const sep of ['/', '\\']) if (file.startsWith(base + sep)) return file.slice(base.length + 1);
  return file;
}

// ── State ─────────────────────────────────────────────────────────────────

// Geometry from the design
const CW = 208;
const CH = 132;
const GAP = 14;
const PADX = 22;
const HEAD = 78;
const PADB = 24;
const GX = 84;
const GY = 100;
const HOUR = 3_600_000;

const state = {
  board: null,
  byId: new Map(),
  layout: { version: 1, positions: { workstream: {}, project: {}, tool: {}, day: {} } },
  view: prefs.get('view', window.innerWidth < 720 ? 'list' : 'canvas'),
  grouping: prefs.get('grouping', 'workstream'),
  arrangement: prefs.get('arrangement', 'scatter'), // 'scatter' | 'tidy'
  hiddenTools: new Set(prefs.get('hiddenTools', [])),
  showTools: prefs.get('showTools', false),
  selected: null,
  detail: null,
  search: null, // { q, ids:Set, hits:Map(sessionId → best hit), decisionHits:Map(sessionId → decisions) }
  decisions: null, // every decision, for the Decisions view (loaded when needed)
  meaning: null, // search by meaning: { enabled, state, model, url, api, pieces, sessions, progress, error }
  find: null, // { q, matches:[seq], index } for "find in this conversation"
  cam: { x: 32, y: 30, k: 0.7 },
  pos: new Map(),
  groups: [],
  hovered: null,
  loadedAt: null,
  connected: true,
};

const els = {
  board: $('#canvas'),
  world: $('#world'),
  glows: $('#glows'),
  zones: $('#zones'),
  threads: $('#threads'),
  cards: $('#cards'),
  empty: $('#empty'),
  list: $('#list'),
  decisions: $('#decisions'),
  meaningBtn: $('#meaning-btn'),
  meaningPanel: $('#meaning-panel'),
  reader: $('#reader'),
  q: $('#q'),
  count: $('#count'),
  toast: $('#toast'),
  zoomLevel: $('#zoom-reset'),
  layoutToggle: $('#layout-toggle'),
  chips: $('#tool-filters'),
  rescan: $('#rescan'),
  composer: $('#composer'),
};

let toastTimer = 0;
function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 3200);
}

const toolLabel = (id) => state.board?.providers.find((p) => p.id === id)?.label ?? id;
const swatch = (tool) => h('span', { class: 'swatch', dataset: { tool }, 'aria-hidden': 'true' });

function visibleSessions() {
  return (state.board?.sessions ?? []).filter(
    (x) => !state.hiddenTools.has(x.provider) && (!state.search || state.search.ids.has(x.id)),
  );
}

// ── Grouping ──────────────────────────────────────────────────────────────

function dayKey(iso) {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayLabel(iso) {
  if (!iso) return 'Unknown day';
  const d = new Date(iso);
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(new Date()) - start(d)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function buildGroups(sessions) {
  const ids = new Set(sessions.map((x) => x.id));
  const newest = (a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
  const groups = [];

  if (state.grouping === 'workstream') {
    for (const w of state.board.workstreams) {
      const items = w.sessionIds.filter((id) => ids.has(id)).map((id) => state.byId.get(id)).sort(newest);
      if (!items.length) continue;
      const linked = w.kind === 'linked';
      const tools = uniq(items.map((x) => toolLabel(x.provider)));
      groups.push({
        key: w.id,
        title: w.label,
        meta: linked
          ? [w.project, w.branch, tools.join(' + ')].filter(Boolean).join(' · ')
          : items.length === 1
            ? 'Not linked to other sessions'
            : 'Not linked to each other',
        boxed: linked,
        quiet: !linked,
        items,
      });
    }
    return groups;
  }

  const keyOf = { project: (x) => x.cwd ?? '', tool: (x) => x.provider, day: (x) => dayKey(x.updatedAt) }[state.grouping];
  const map = new Map();
  for (const x of sessions) {
    const k = keyOf(x);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(x);
  }
  for (const [k, items] of map) {
    items.sort(newest);
    const n = plural(items.length, 'session');
    const projects = uniq(items.map((x) => x.project ?? 'no project')).length;
    let title;
    let meta;
    if (state.grouping === 'project') {
      const branches = uniq(items.map((x) => x.gitBranch).filter(Boolean)).length;
      title = items[0].project ?? 'No project';
      meta = branches ? `${n} · ${plural(branches, 'branch', 'branches')}` : n;
    } else if (state.grouping === 'tool') {
      title = toolLabel(k);
      meta = `${n} · ${plural(projects, 'project')}`;
    } else {
      title = dayLabel(items[0].updatedAt);
      meta = `${n} · ${plural(projects, 'project')}`;
    }
    groups.push({ key: `${state.grouping}:${k}`, title, meta, boxed: true, quiet: false, items });
  }
  return groups.sort((a, b) => newest(a.items[0], b.items[0]));
}

// ── Canvas layout ─────────────────────────────────────────────────────────

/** Width a group needs for its title (17px caps, tracked) and meta (12px mono). */
function headWidth(g) {
  return Math.max(g.title.length * 12.6, Math.min(g.meta.length * 7.3, 520)) + 2 * PADX;
}

function layout() {
  const sessions = visibleSessions();
  const groups = buildGroups(sessions);
  const scatter = state.arrangement === 'scatter';
  const manual = scatter ? (state.layout.positions[state.grouping] ?? {}) : {};
  const perRow = state.grouping === 'workstream' ? 3 : 4;

  for (const g of groups) {
    const n = g.items.length;
    const cols = Math.min(perRow, n);
    const rows = Math.ceil(n / perRow);
    g.cols = perRow;
    g.w = Math.max(268, cols * CW + (cols - 1) * GAP + 2 * PADX, headWidth(g));
    g.h = HEAD + rows * CH + (rows - 1) * GAP + PADB;
    // Scatter: each group drifts a little, the same way every time
    g.jx = scatter ? Math.round(rand(`${g.key}x`) * 52) : 0;
    g.jy = scatter ? Math.round((rand(`${g.key}y`) - 0.5) * 80) + 40 : 0;
  }

  // Shelf-pack groups into rows. Try many row widths and keep the one whose
  // shape best fits the screen, so the whole board is as large as possible.
  const rect = els.board.getBoundingClientRect();
  const viewW = Math.max(320, (rect.width || 1280) - 64);
  const viewH = Math.max(320, (rect.height || 800) - 110);
  const pack = (rowMax) => {
    let x = 0;
    let y = 0;
    let rowH = 0;
    let width = 0;
    const spots = [];
    for (const g of groups) {
      const w = g.w + g.jx;
      if (x > 0 && x + w > rowMax) {
        x = 0;
        y += rowH + GY;
        rowH = 0;
      }
      spots.push({ x: x + g.jx, y: y + g.jy });
      width = Math.max(width, x + w);
      x += w + GX;
      rowH = Math.max(rowH, g.h + g.jy);
    }
    return { spots, width, height: y + rowH };
  };
  let best = null;
  const widest = groups.reduce((m, g) => Math.max(m, g.w + g.jx), 0);
  for (let rowMax = widest; rowMax <= widest + 8000; rowMax += 120) {
    const p = pack(rowMax);
    const scale = Math.min(viewW / p.width, viewH / p.height);
    if (!best || scale > best.scale + 1e-6) best = { ...p, scale };
  }

  state.pos = new Map();
  groups.forEach((g, gi) => {
    const { x, y } = best?.spots[gi] ?? { x: 0, y: 0 };
    g.x = x;
    g.y = y;
    g.items.forEach((item, i) => {
      const c = i % g.cols;
      const r = Math.floor(i / g.cols);
      const auto = {
        x: x + PADX + c * (CW + GAP),
        y: y + HEAD + r * (CH + GAP) + (scatter ? Math.round((rand(`${item.id}j`) - 0.5) * 12) : 0),
      };
      state.pos.set(item.id, manual[item.id] ?? auto);
    });
  });
  state.groups = groups;
}

/** Groups stretch around wherever their cards actually are, including cards you dragged away. */
function groupRect(g) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const item of g.items) {
    const p = state.pos.get(item.id);
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + CW);
    maxY = Math.max(maxY, p.y + CH);
  }
  const x = minX - PADX;
  const y = minY - HEAD;
  return { x, y, w: Math.max(maxX + PADX - x, headWidth(g), 268), h: maxY + PADB - y };
}

// ── Canvas rendering ──────────────────────────────────────────────────────

const cardEls = new Map();

function cardChildren(item) {
  const ctx = contextOf(item);
  const fillPx = ctx?.pct != null ? Math.round(CH * ctx.pct) : 0;
  const fill = h('span', { class: 'fill', 'aria-hidden': 'true', style: { height: `${fillPx}px` } });
  for (let i = 1; i <= item.compactions && fillPx; i++) {
    fill.append(h('i', { style: { bottom: `${Math.round((fillPx * i) / (item.compactions + 1))}px` } }));
  }
  const helpers = state.board.subagentCounts[item.id];
  const decided = state.board.decisionCounts?.[item.id] ?? 0;
  const age = ago(item.updatedAt);
  const { hit, decision } = matchOf(item.id);
  // While searching, a card shows where it matched instead of its title
  const byMeaning = hit?.via === 'meaning';
  const title = decision
    ? h('span', { class: 'title snip decided' }, flag(), ' ', shortTitle(decision.text, 110))
    : byMeaning
      ? h('span', { class: 'title snip meaning' }, shortTitle(hit.snippet, 120))
      : hit
        ? h('span', { class: 'title snip' }, marked(hit.snippet))
        : h('span', { class: 'title' }, shortTitle(item.title));
  return [
    fill,
    h(
      'span',
      { class: 'inner' },
      h('span', { class: 'top' }, swatch(item.provider), h('span', { class: `age${age === 'now' ? ' now' : ''}` }, age)),
      title,
      h(
        'span',
        { class: 'foot' },
        byMeaning
          ? h('span', { class: 'helpers by-meaning', title: 'Found by meaning: no words matched' }, '≈ by meaning')
          : hit
            ? h('span', { class: 'helpers' }, plural(hit.hits, 'match', 'matches'))
          : helpers
            ? h('span', { class: 'helpers' }, `+${plural(helpers, 'subagent')}`)
            : null,
        decided ? h('span', { class: 'decided-count', title: plural(decided, 'decision') }, flag(), String(decided)) : null,
        ctx ? h('span', { class: 'pct' }, ctx.pct != null ? `${pctOf(ctx)}%` : tokens(ctx.tokens)) : null,
      ),
    ),
  ];
}

/** Where a session matched the current search: its best message, and any matching decision. */
function matchOf(id) {
  if (!state.search) return { hit: null, decision: null };
  return { hit: state.search.hits?.get(id) ?? null, decision: state.search.decisionHits?.get(id)?.[0] ?? null };
}

function cardLabel(item) {
  const ctx = contextOf(item);
  const { hit, decision } = matchOf(item.id);
  const decided = state.board.decisionCounts?.[item.id] ?? 0;
  return [
    item.title,
    decision ? `Matching decision: ${decision.text}` : hit ? `${hit.via === 'meaning' ? 'Found by meaning' : 'Matches'}: ${hit.snippet.replace(/[«»]/g, '')}` : '',
    decided ? plural(decided, 'decision') : '',
    `${toolLabel(item.provider)}, ${item.project ?? 'no project'}`,
    `updated ${agoLong(item.updatedAt)}`,
    ctx?.pct != null ? `context ${pctOf(ctx)}% full${item.compactions ? `, compacted ${times(item.compactions)}` : ''}` : '',
  ]
    .filter(Boolean)
    .join('. ');
}

function renderCanvas() {
  const scatter = state.arrangement === 'scatter';
  const seen = new Set();
  for (const g of state.groups) {
    for (const item of g.items) {
      seen.add(item.id);
      let el = cardEls.get(item.id);
      const sig = `${item.updatedAt}|${item.title}|${item.contextTokens}|${item.compactions}|${state.board.subagentCounts[item.id] ?? 0}|${state.board.decisionCounts?.[item.id] ?? 0}|${state.search?.q ?? ''}`;
      if (!el) {
        el = h('button', { type: 'button', class: 'card', dataset: { id: item.id, tool: item.provider } });
        attachCardEvents(el);
        cardEls.set(item.id, el);
        els.cards.append(el);
      }
      if (el.dataset.sig !== sig) {
        el.replaceChildren(...cardChildren(item));
        el.dataset.sig = sig;
        el.setAttribute('aria-label', cardLabel(item));
      }
      const p = state.pos.get(item.id);
      el.style.translate = `${p.x}px ${p.y}px`;
      el.style.setProperty('--tilt', scatter ? `${((rand(`${item.id}r`) - 0.5) * 3.4).toFixed(2)}deg` : '0deg');
      el.classList.toggle('selected', state.selected === item.id);
      el.setAttribute('aria-pressed', String(state.selected === item.id));
    }
  }
  for (const [id, el] of cardEls) {
    if (!seen.has(id)) {
      el.remove();
      cardEls.delete(id);
    }
  }
  renderGroups();
  renderThreads();
  renderEmpty(els.empty);
  els.layoutToggle.textContent = scatter ? 'Tidy up' : 'Scatter';
  els.layoutToggle.title = scatter ? 'Line every card up in a neat grid' : 'Go back to the loose layout and the cards you placed';
}

function renderGroups() {
  const now = Date.now();
  const glows = [];
  els.zones.replaceChildren(
    ...state.groups.map((g) => {
      const r = groupRect(g);
      const active = g.items.some((x) => x.updatedAt && now - Date.parse(x.updatedAt) < HOUR);
      if (active) glows.push(h('div', { class: 'glow', style: { left: `${r.x + r.w - 300}px`, top: `${r.y - 190}px` } }));
      return h(
        'div',
        {
          class: `zone${g.boxed ? ' boxed' : ''}${g.quiet ? ' quiet' : ''}`,
          style: { transform: `translate(${r.x}px, ${r.y}px)`, width: `${r.w}px`, height: `${r.h}px` },
        },
        h('div', { class: 'zone-head' }, h('h2', { class: 'zone-title', title: g.title }, g.title), h('div', { class: 'zone-meta', title: g.meta }, g.meta)),
      );
    }),
  );
  els.glows.replaceChildren(...glows);
}

/** S-curves between sessions that edited the same files. */
function renderThreads() {
  const focus = state.hovered ?? state.selected;
  const paths = [];
  for (const e of state.board?.edges ?? []) {
    const a = state.pos.get(e.a);
    const b = state.pos.get(e.b);
    if (!a || !b) continue;
    const ax = a.x + CW / 2;
    const ay = a.y + CH / 2;
    const bx = b.x + CW / 2;
    const by = b.y + CH / 2;
    const dx = bx - ax;
    const dy = by - ay;
    const d =
      Math.abs(dx) >= Math.abs(dy)
        ? `M${ax},${ay} C${ax + dx / 2},${ay} ${bx - dx / 2},${by} ${bx},${by}`
        : `M${ax},${ay} C${ax},${ay + dy / 2} ${bx},${by - dy / 2} ${bx},${by}`;
    const cls = [e.kind === 'handoff' ? 'handoff' : '', focus && (e.a === focus || e.b === focus) ? 'on' : ''].filter(Boolean).join(' ');
    paths.push(s('path', { d, class: cls || null }));
  }
  els.threads.replaceChildren(...paths);
}

function renderEmpty(target) {
  const total = state.board?.sessions.length ?? 0;
  if (visibleSessions().length > 0) {
    target.hidden = true;
    return;
  }
  target.hidden = false;
  target.classList.toggle('interactive', total === 0);
  if (total === 0) {
    target.replaceChildren(
      h('h2', {}, 'No sessions yet'),
      h(
        'p',
        {},
        'ContextDeck looked in ',
        (state.board?.sources ?? []).flatMap((src, i, all) => [h('code', {}, src.root), i < all.length - 1 ? ' and ' : '']),
        '. Use Claude Code or Codex, then choose Rescan. ',
        h('code', {}, 'contextdeck doctor'),
        ' shows what was found.',
      ),
    );
  } else {
    target.replaceChildren(h('h2', {}, 'Nothing matches'), h('p', {}, 'Try another word, or turn a tool back on.'));
  }
}

// ── Camera ────────────────────────────────────────────────────────────────

function applyCam() {
  const { x, y, k } = state.cam;
  els.world.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
  els.board.style.backgroundSize = `${22 * k}px ${22 * k}px`;
  els.board.style.backgroundPosition = `${x}px ${y}px`;
  els.board.classList.toggle('far', k < 0.48);
  els.zoomLevel.textContent = `${Math.round(k * 100)}%`;
}

function zoomAt(factor, cx, cy) {
  const { x, y, k } = state.cam;
  const nk = Math.min(1.6, Math.max(0.2, k * factor));
  state.cam = { k: nk, x: cx - ((cx - x) * nk) / k, y: cy - ((cy - y) * nk) / k };
  applyCam();
}

function bounds() {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const g of state.groups) {
    const r = groupRect(g);
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/** Show everything if it fits at a readable size; otherwise start at the top left. */
function fit() {
  const b = bounds();
  const rect = els.board.getBoundingClientRect();
  if (!b || !rect.width) return;
  const right = !els.reader.hidden && rect.width > 900 ? 460 : 32;
  const w = rect.width - 32 - right;
  const hgt = rect.height - 30 - 90;
  const want = Math.min(w / (b.maxX - b.minX), hgt / (b.maxY - b.minY));
  const k = Math.min(1, Math.max(0.42, want));
  const fits = want >= 0.42;
  state.cam = {
    k,
    x: fits ? 32 + (w - (b.maxX - b.minX) * k) / 2 - b.minX * k : 32 - b.minX * k,
    y: fits ? 30 + (hgt - (b.maxY - b.minY) * k) / 2 - b.minY * k : 30 - b.minY * k,
  };
  applyCam();
}

function centerOn(id) {
  const p = state.pos.get(id);
  if (!p) return;
  const rect = els.board.getBoundingClientRect();
  const right = !els.reader.hidden && rect.width > 900 ? 440 : 0;
  const k = Math.max(state.cam.k, 0.7);
  state.cam = { k, x: (rect.width - right) / 2 - (p.x + CW / 2) * k, y: rect.height / 2 - (p.y + CH / 2) * k };
  applyCam();
}

// ── Canvas interaction ────────────────────────────────────────────────────

let saveTimer = 0;
function saveLayoutSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await api('/api/layout', { method: 'PUT', body: state.layout });
    } catch (err) {
      toast(`Couldn’t save where you put that card: ${err.message}`);
    }
  }, 400);
}

let frame = 0;
function redrawSoon() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    renderGroups();
    renderThreads();
  });
}

function setArrangement(next) {
  state.arrangement = next;
  prefs.set('arrangement', next);
}

function attachCardEvents(el) {
  let start = null;
  let dragged = false;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const p = state.pos.get(el.dataset.id);
    start = { px: e.clientX, py: e.clientY, x: p.x, y: p.y, moving: false };
    dragged = false;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dx = (e.clientX - start.px) / state.cam.k;
    const dy = (e.clientY - start.py) / state.cam.k;
    if (!start.moving && Math.hypot(dx, dy) * state.cam.k < 5) return;
    if (!start.moving) {
      start.moving = true;
      // Moving a card by hand means you want the loose layout
      if (state.arrangement === 'tidy') {
        setArrangement('scatter');
        els.layoutToggle.textContent = 'Tidy up';
      }
    }
    el.classList.add('lifted');
    const p = { x: Math.round(start.x + dx), y: Math.round(start.y + dy) };
    state.pos.set(el.dataset.id, p);
    el.style.translate = `${p.x}px ${p.y}px`;
    redrawSoon();
  });
  const end = () => {
    if (!start) return;
    dragged = start.moving;
    start = null;
    el.classList.remove('lifted');
    if (dragged) {
      const id = el.dataset.id;
      state.layout.positions[state.grouping] ??= {};
      state.layout.positions[state.grouping][id] = state.pos.get(id);
      saveLayoutSoon();
      renderCanvas();
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', () => {
    start = null;
    el.classList.remove('lifted');
  });
  el.addEventListener('click', (e) => {
    if (dragged) {
      dragged = false;
      e.preventDefault();
      return;
    }
    select(el.dataset.id);
  });
  el.addEventListener('pointerenter', () => {
    state.hovered = el.dataset.id;
    renderThreads();
  });
  el.addEventListener('pointerleave', () => {
    state.hovered = null;
    renderThreads();
  });
}

(function attachBoardEvents() {
  let pan = null;
  els.board.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.card, .dock, .legend, .empty.interactive')) return;
    pan = { px: e.clientX, py: e.clientY, x: state.cam.x, y: state.cam.y, moved: false };
    els.board.setPointerCapture(e.pointerId);
    els.board.classList.add('panning');
  });
  els.board.addEventListener('pointermove', (e) => {
    if (!pan) return;
    const dx = e.clientX - pan.px;
    const dy = e.clientY - pan.py;
    if (Math.abs(dx) + Math.abs(dy) > 4) pan.moved = true;
    state.cam.x = pan.x + dx;
    state.cam.y = pan.y + dy;
    applyCam();
  });
  const end = () => {
    if (!pan) return;
    const clicked = !pan.moved;
    pan = null;
    els.board.classList.remove('panning');
    if (clicked && state.selected) closeReader();
  };
  els.board.addEventListener('pointerup', end);
  els.board.addEventListener('pointercancel', end);
  els.board.addEventListener(
    'wheel',
    (e) => {
      if (e.target.closest('.legend')) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      if (e.ctrlKey || e.metaKey) {
        const r = els.board.getBoundingClientRect();
        zoomAt(Math.exp(-e.deltaY * unit * 0.0018), e.clientX - r.left, e.clientY - r.top);
      } else {
        state.cam.x -= e.deltaX * unit;
        state.cam.y -= e.deltaY * unit;
        applyCam();
      }
    },
    { passive: false },
  );

  const zoomCenter = (f) => {
    const r = els.board.getBoundingClientRect();
    zoomAt(f, r.width / 2, r.height / 2);
  };
  $('#zoom-in').addEventListener('click', () => zoomCenter(1.15));
  $('#zoom-out').addEventListener('click', () => zoomCenter(1 / 1.15));
  els.zoomLevel.addEventListener('click', fit);
  els.layoutToggle.addEventListener('click', () => {
    setArrangement(state.arrangement === 'scatter' ? 'tidy' : 'scatter');
    relayout();
    fit();
  });
})();

// ── List view ─────────────────────────────────────────────────────────────

function renderList() {
  const sessions = visibleSessions();
  const groups = buildGroups(sessions);
  const inner = h('div', { class: 'list-inner' });
  for (const g of groups) {
    const rows = g.items.map((item) => {
      const ctx = contextOf(item);
      const { hit, decision } = matchOf(item.id);
      const decided = state.board.decisionCounts?.[item.id] ?? 0;
      return h(
        'button',
        {
          type: 'button',
          class: `row${state.selected === item.id ? ' selected' : ''}`,
          dataset: { id: item.id, tool: item.provider },
          'aria-pressed': String(state.selected === item.id),
          onclick: () => select(item.id),
        },
        swatch(item.provider),
        h(
          'span',
          { class: 'r-main' },
          h(
            'span',
            { class: 'r-title', title: item.title },
            decided ? h('span', { class: 'decided-count', title: plural(decided, 'decision') }, flag(), String(decided)) : null,
            item.title,
          ),
          decision
            ? h('span', { class: 'r-snip decided' }, flag(), ' ', decision.text)
            : hit?.via === 'meaning'
              ? h('span', { class: 'r-snip meaning' }, h('span', { class: 'r-hits' }, '≈ by meaning · '), hit.snippet)
              : hit
                ? h('span', { class: 'r-snip' }, marked(hit.snippet), h('span', { class: 'r-hits' }, ` · ${plural(hit.hits, 'match', 'matches')}`))
                : null,
        ),
        h('span', { class: 'r-where' }, [item.project ?? 'no project', item.gitBranch].filter(Boolean).join(' · ')),
        h(
          'span',
          { class: 'meter', title: ctx?.pct != null ? `${tokens(ctx.tokens)} of ${ctx.estimated ? '~' : ''}${tokens(ctx.window)} tokens` : null },
          ctx?.pct != null ? [h('span', { class: 'track' }, h('span', { style: { width: `${pctOf(ctx)}%` } })), `${pctOf(ctx)}%`] : ctx ? tokens(ctx.tokens) : '',
        ),
        h('span', { class: 'r-age', title: fullDate(item.updatedAt) }, ago(item.updatedAt)),
      );
    });
    inner.append(
      h(
        'section',
        { class: 'list-group' },
        h('div', { class: `list-head${g.quiet ? ' quiet' : ''}` }, h('h2', {}, g.title), h('span', { class: 'meta' }, g.meta)),
        h('div', { class: 'rows' }, h('div', { class: 'rows-inner' }, rows)),
      ),
    );
  }
  if (!groups.length) {
    const empty = h('div', { class: 'empty' });
    renderEmpty(empty);
    inner.append(empty);
  }
  els.list.replaceChildren(inner);
}

// ── Decisions view ────────────────────────────────────────────────────────

let decisionsLoading = null;

function renderDecisions() {
  if (!state.decisions) {
    if (!decisionsLoading) {
      decisionsLoading = api('/api/decisions')
        .then((r) => {
          state.decisions = r.decisions;
          if (state.view === 'decisions') renderDecisions();
        })
        .catch((err) => toast(err.message))
        .finally(() => (decisionsLoading = null));
    }
    if (!els.decisions.childElementCount) els.decisions.replaceChildren(h('div', { class: 'list-inner' }, h('p', { class: 'note' }, 'Loading decisions…')));
    return;
  }
  const q = state.search?.q ?? '';
  const shown = state.decisions.filter((d) => !state.hiddenTools.has(d.session?.provider) && (!q || decisionMatches(d, q)));
  const inner = h('div', { class: 'list-inner' });
  if (!state.decisions.length) {
    inner.append(
      h(
        'div',
        { class: 'empty interactive' },
        h('h2', {}, 'No decisions yet'),
        h(
          'p',
          {},
          'Open a session and choose ',
          h('strong', {}, 'Mark as decision'),
          ' on the message that settled something. Select part of a message first to quote just that. Decisions show up here, on cards, in search, and in every handoff brief, so the next session doesn’t reopen them.',
        ),
      ),
    );
  } else if (!shown.length) {
    inner.append(h('div', { class: 'empty interactive' }, h('h2', {}, 'No decisions match'), h('p', {}, 'Try another word, or turn a tool back on.')));
  } else {
    // Group by project, newest decision first
    const groups = new Map();
    for (const d of shown) {
      const key = d.session?.project ?? 'No project';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(d);
    }
    for (const [project, items] of groups) {
      inner.append(
        h(
          'section',
          { class: 'list-group' },
          h('div', { class: 'list-head' }, h('h2', {}, project), h('span', { class: 'meta' }, plural(items.length, 'decision'))),
          h('ul', { class: 'decision-grid' }, items.map((d) => h('li', {}, decisionCard(d)))),
        ),
      );
    }
  }
  els.decisions.replaceChildren(inner);
}

// ── Search by meaning ─────────────────────────────────────────────────────

const MEANING_MODELS = [
  ['qwen3-embedding:0.6b', 'many languages and code (recommended)'],
  ['bge-m3', 'many languages'],
  ['embeddinggemma', 'English, small'],
  ['nomic-embed-text', 'English, small'],
];

function meaningLabel(m) {
  if (!m?.enabled) return 'off';
  if (m.state === 'catching-up') return m.progress?.sessionsTotal ? `catching up, ${m.progress.sessionsDone} of ${m.progress.sessionsTotal} sessions` : 'catching up';
  if (m.state === 'error') return 'can’t reach the model';
  return 'on';
}

function renderMeaningButton() {
  const m = state.meaning;
  const b = els.meaningBtn;
  b.classList.toggle('on', !!m?.enabled);
  b.classList.toggle('busy', m?.state === 'catching-up');
  b.classList.toggle('problem', m?.state === 'error');
  const label = `Search by meaning: ${meaningLabel(m)}`;
  b.setAttribute('aria-label', label);
  b.title = label;
}

function setMeaningPanel(open) {
  els.meaningPanel.hidden = !open;
  els.meaningBtn.setAttribute('aria-expanded', String(open));
  if (open) {
    renderMeaningPanel();
    $('input, button', els.meaningPanel)?.focus();
  }
}

function renderMeaningPanel() {
  if (els.meaningPanel.hidden) return;
  const m = state.meaning ?? { enabled: false, api: 'ollama', url: 'http://127.0.0.1:11434', model: 'qwen3-embedding:0.6b' };
  const alert = h('p', { class: 'warn', role: 'alert', hidden: true });
  const fail = (err) => {
    alert.textContent = err.message;
    alert.hidden = false;
  };
  const head = [
    h('div', { class: 'mp-head' }, h('h2', {}, 'Search by meaning'), h('span', { class: `mp-state ${m.enabled ? m.state : 'off'}` }, meaningLabel(m))),
    h(
      'p',
      { class: 'mp-lead' },
      'Finds sessions by what they’re about, not only the words in them: “which chat decided on the database” finds “let’s go with Postgres”. It uses an embedding model running on your computer, so nothing leaves it.',
    ),
  ];

  if (!m.enabled || m.state === 'error') {
    const model = h('input', { type: 'text', class: 'mp-input', list: 'mp-models', value: m.model, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Model' });
    const url = h('input', { type: 'url', class: 'mp-input', value: m.url, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Model server address' });
    const kind = h(
      'select',
      { class: 'mp-input', 'aria-label': 'Kind of server' },
      h('option', { value: 'ollama', selected: m.api === 'ollama' }, 'Ollama'),
      h('option', { value: 'openai', selected: m.api === 'openai' }, 'OpenAI-compatible (LM Studio, llama.cpp, vLLM)'),
    );
    kind.addEventListener('change', () => {
      // Swap the default address along with the kind, unless it was changed by hand
      if (url.value === 'http://127.0.0.1:11434' || url.value === 'http://127.0.0.1:1234') url.value = kind.value === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:1234';
    });
    const pull = h('code', {}, `ollama pull ${m.model}`);
    model.addEventListener('input', () => (pull.textContent = `ollama pull ${model.value.trim() || 'qwen3-embedding:0.6b'}`));
    const go = h('button', { type: 'submit', class: 'pill solid' }, m.state === 'error' ? 'Try again' : 'Check and turn on');
    const form = h(
      'form',
      {
        class: 'mp-form',
        onsubmit: async (e) => {
          e.preventDefault();
          alert.hidden = true;
          go.disabled = true;
          go.textContent = 'Checking the model…';
          try {
            state.meaning = await api('/api/semantic', { method: 'PUT', body: { enabled: true, model: model.value.trim(), url: url.value.trim(), api: kind.value } });
            renderMeaningButton();
            renderMeaningPanel();
            toast('Search by meaning is on. Your sessions are being embedded in the background.');
          } catch (err) {
            go.disabled = false;
            go.textContent = 'Check and turn on';
            fail(err);
          }
        },
      },
      h('ol', { class: 'mp-steps' },
        h('li', {}, 'Install ', h('a', { href: 'https://ollama.com', target: '_blank', rel: 'noopener noreferrer' }, 'Ollama'), ' (or LM Studio, llama.cpp, vLLM).'),
        h('li', {}, 'Get an embedding model: ', pull, h('button', { type: 'button', class: 'text-button', onclick: async (e) => {
          try {
            await navigator.clipboard.writeText(pull.textContent);
            e.currentTarget.textContent = 'Copied';
          } catch {
            toast('Copy didn’t work here; select the command instead.');
          }
        } }, 'Copy')),
        h('li', {}, 'Check it answers, and turn this on.'),
      ),
      h('label', { class: 'mp-field' }, h('span', {}, 'Model'), model),
      h('datalist', { id: 'mp-models' }, MEANING_MODELS.map(([v, note]) => h('option', { value: v }, note))),
      h('p', { class: 'note' }, 'For prompts in more than one language (Hindi and English, say), use qwen3-embedding or bge-m3. For English only, embeddinggemma is smaller.'),
      h('label', { class: 'mp-field' }, h('span', {}, 'Server'), url),
      h('label', { class: 'mp-field' }, h('span', {}, 'Kind'), kind),
      m.state === 'error' && m.error ? h('p', { class: 'warn' }, m.error) : null,
      alert,
      h('div', { class: 'actions' }, go, m.enabled ? h('button', { type: 'button', class: 'text-button', onclick: () => turnOff(false) }, 'Turn off') : null),
    );
    els.meaningPanel.replaceChildren(...head, form);
    return;
  }

  const p = m.progress;
  const pct = p?.sessionsTotal ? Math.round((p.sessionsDone / p.sessionsTotal) * 100) : null;
  els.meaningPanel.replaceChildren(
    ...head,
    h(
      'dl',
      { class: 'mp-facts' },
      h('dt', {}, 'Model'), h('dd', {}, m.model),
      h('dt', {}, 'Server'), h('dd', {}, m.url),
      h('dt', {}, 'Covered'), h('dd', {}, `${plural(m.sessions, 'session')}, ${plural(m.pieces, 'piece')} of text`),
    ),
    m.state === 'catching-up'
      ? h(
          'div',
          { class: 'mp-progress' },
          h('div', { class: 'bar-big' }, h('span', { style: { width: `${pct ?? 0}%` } })),
          h('p', { class: 'note' }, p?.sessionsTotal ? `Embedding ${p.sessionsDone} of ${p.sessionsTotal} sessions, newest first. Search already uses what’s done.` : 'Getting started…'),
        )
      : h('p', { class: 'note' }, 'New and changed sessions are embedded as they come in. Results found this way are marked “≈ by meaning”.'),
    alert,
    h(
      'div',
      { class: 'actions' },
      h('button', { type: 'button', class: 'pill outline small', onclick: () => turnOff(false) }, 'Turn off'),
      h('button', { type: 'button', class: 'text-button', onclick: () => turnOff(true), title: 'Also delete the stored vectors' }, 'Turn off and delete vectors'),
    ),
  );

  async function turnOff(drop) {
    try {
      state.meaning = await api('/api/semantic', { method: 'PUT', body: { enabled: false, drop } });
      renderMeaningButton();
      renderMeaningPanel();
      if (state.search) runSearch();
    } catch (err) {
      fail(err);
    }
  }
}

els.meaningBtn.addEventListener('click', () => setMeaningPanel(els.meaningPanel.hidden));
document.addEventListener('pointerdown', (e) => {
  if (!els.meaningPanel.hidden && !e.target.closest('.search-wrap')) setMeaningPanel(false);
});

// ── Search ────────────────────────────────────────────────────────────────

let searchTimer = 0;
let searchSeq = 0;
els.q.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 180);
});

async function runSearch() {
  const q = els.q.value.trim();
  if (!q) return clearSearch(false);
  const seq = ++searchSeq;
  const hits = new Map();
  const decisionHits = new Map();
  try {
    const res = await api(`/api/search?q=${encodeURIComponent(q)}`);
    for (const x of res.hits) hits.set(x.session.id, x);
    for (const d of res.decisions ?? []) {
      if (!decisionHits.has(d.sessionId)) decisionHits.set(d.sessionId, []);
      decisionHits.get(d.sessionId).push(d);
    }
  } catch {
    /* an unparseable query just matches nothing */
  }
  const ids = new Set([...hits.keys(), ...decisionHits.keys()]);
  if (seq !== searchSeq) return;
  // Also match titles, projects, branches and group names, so typing what you see always works
  const needle = q.toLowerCase();
  const wsName = new Map();
  for (const w of state.board.workstreams) for (const id of w.sessionIds) wsName.set(id, w.label);
  for (const x of state.board.sessions) {
    const hay = `${x.title} ${x.project ?? ''} ${x.gitBranch ?? ''} ${wsName.get(x.id) ?? ''}`.toLowerCase();
    if (hay.includes(needle)) ids.add(x.id);
  }
  state.search = { q, ids, hits, decisionHits };
  relayout();
  if (state.view === 'canvas') fit();
}

function clearSearch(clearInput = true) {
  searchSeq++;
  if (clearInput) els.q.value = '';
  if (!state.search) return;
  state.search = null;
  relayout();
  if (state.view === 'canvas') fit();
}

// ── Reader ────────────────────────────────────────────────────────────────

let detailSeq = 0;
let returnFocus = null;

/**
 * Open a session in the side panel. `seq` jumps to that message (a search
 * match or a decision); while searching, the best match is used. `keepPlace`
 * refreshes an open panel without moving it (live updates).
 */
async function select(id, { focusReader = true, seq: target = null, keepPlace = false } = {}) {
  const changed = state.selected !== id;
  state.selected = id;
  if (changed) returnFocus = document.activeElement;
  try {
    history.replaceState(null, '', `#${encodeURIComponent(id)}`);
  } catch {
    /* ignore */
  }
  render();
  if (target == null && changed) target = searchTarget(id);
  const around = target ?? (keepPlace && !changed ? middleOfWindow() : null);
  const scroll = els.reader.scrollTop;
  const seq = ++detailSeq;
  try {
    const detail = await api(`/api/session/${encodeURIComponent(id)}${around != null ? `?around=${around}` : ''}`);
    if (seq !== detailSeq) return;
    state.detail = detail;
    if (changed) state.find = state.search ? { q: state.search.q, matches: null, index: -1 } : null;
    renderReader({ keepScroll: keepPlace && !changed ? scroll : null });
    if (focusReader && changed) els.reader.focus({ preventScroll: true });
    if (state.find?.q && !state.find.matches) await loadFind(state.find.q, target);
    else paintFind();
    if (target != null) jumpTo(target, { load: false });
  } catch (err) {
    if (seq === detailSeq) toast(err.message);
  }
}

/** The message to open a session at while searching: a matching decision, else the best match. */
function searchTarget(id) {
  const { hit, decision } = matchOf(id);
  // A session found through its title has no message to jump to (seq -1)
  return decision?.seq ?? (hit && hit.seq >= 0 ? hit.seq : null);
}

/** For long sessions showing an older window: keep showing that window on refresh. */
function middleOfWindow() {
  const d = state.detail;
  if (!d?.truncatedAfter) return null;
  return d.messages[Math.floor(d.messages.length / 2)]?.seq ?? null;
}

// ── Find in this conversation ─────────────────────────────────────────────

let findTimer = 0;
let findRun = 0;

async function loadFind(q, target = null) {
  const id = state.selected;
  const run = ++findRun;
  if (!q) {
    state.find = null;
    paintFind();
    return;
  }
  state.find = { q, matches: null, index: -1 };
  updateFindCount();
  let matches = [];
  try {
    matches = (await api(`/api/matches?id=${encodeURIComponent(id)}&q=${encodeURIComponent(q)}`)).matches.map((x) => x.seq);
  } catch {
    /* an unparseable query just matches nothing */
  }
  if (run !== findRun || state.selected !== id) return;
  let index = matches.length ? 0 : -1;
  if (target != null && matches.length) {
    const i = matches.findIndex((x) => x >= target);
    index = i < 0 ? matches.length - 1 : i;
  }
  state.find = { q, matches, index };
  paintFind();
  if (target == null && index >= 0) await jumpTo(matches[index]);
}

async function stepFind(dir) {
  const f = state.find;
  if (!f?.matches?.length) return;
  f.index = (f.index + dir + f.matches.length) % f.matches.length;
  updateFindCount();
  await jumpTo(f.matches[f.index]);
}

function updateFindCount() {
  const el = $('.find-count', els.reader);
  if (!el) return;
  const f = state.find;
  if (!f?.q) el.textContent = '';
  else if (!f.matches) el.textContent = 'Searching…';
  else if (f.matches.length) el.textContent = `${f.index + 1} of ${f.matches.length}`;
  else {
    // The session can match through one of its decisions rather than a message
    const n = (state.detail?.decisions ?? []).filter((d) => decisionMatches(d, f.q)).length;
    const byMeaning = state.search?.q === f.q && state.search.hits?.get(state.selected)?.via === 'meaning';
    el.textContent = n ? (n === 1 ? 'In a decision' : `In ${n} decisions`) : byMeaning ? 'Matched by meaning' : 'No matches';
  }
}

/** Mark and highlight the matching messages that are on screen. */
function paintFind() {
  const d = state.detail;
  if (!d) return;
  const terms = state.find?.q ? termsOf(state.find.q) : [];
  const hits = new Set(state.find?.matches ?? []);
  const bySeq = new Map(d.messages.map((m) => [m.seq, m]));
  for (const el of els.reader.querySelectorAll('.msg[data-seq]')) {
    const seq = Number(el.dataset.seq);
    const isHit = hits.has(seq);
    if (!isHit && !el.classList.contains('hit')) continue;
    el.classList.toggle('hit', isHit);
    const m = bySeq.get(seq);
    const body = $(':scope > .body', el);
    if (m && body) body.replaceChildren(...bodyOf(m, isHit ? terms : []));
  }
  updateFindCount();
}

/** Scroll to a message, loading the part of a long session it's in if needed. */
async function jumpTo(seq, { load = true } = {}) {
  let el = $(`.msg[data-seq="${seq}"]`, els.reader);
  if (!el && load && state.selected) {
    const id = state.selected;
    const run = ++detailSeq;
    try {
      const detail = await api(`/api/session/${encodeURIComponent(id)}?around=${seq}`);
      if (run !== detailSeq) return;
      state.detail = detail;
      renderReader({ keepScroll: els.reader.scrollTop });
      paintFind();
    } catch (err) {
      toast(err.message);
      return;
    }
    el = $(`.msg[data-seq="${seq}"]`, els.reader);
  }
  if (!el) return;
  for (const x of els.reader.querySelectorAll('.msg.current')) x.classList.remove('current');
  el.classList.add('current');
  el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

// ── Decisions ─────────────────────────────────────────────────────────────

let pendingSelection = '';

/** Text selected inside one message, if any. */
function selectionIn(body) {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !body.contains(sel.anchorNode) || !body.contains(sel.focusNode)) return '';
  return sel.toString().trim();
}

/** A starting point for the decision text: the message's first sentences. */
function firstWords(text, max = 280) {
  const t = text.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > 80 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, '')}…`;
}

function openDecideForm(msgEl, m, body) {
  const quote = pendingSelection || selectionIn(body);
  pendingSelection = '';
  for (const f of els.reader.querySelectorAll('.decide-form')) f.remove();
  const ta = h('textarea', { class: 'decide-text', rows: 3, maxlength: 2000, 'aria-label': 'The decision' });
  ta.value = quote || firstWords(m.text);
  const cancel = () => {
    form.remove();
    $('.mark-btn', msgEl)?.focus();
  };
  const save = h('button', { type: 'submit', class: 'pill solid' }, 'Save decision');
  const form = h(
    'form',
    {
      class: 'decide-form',
      onsubmit: async (e) => {
        e.preventDefault();
        const text = ta.value.trim();
        if (!text) {
          toast('Write the decision first.');
          ta.focus();
          return;
        }
        save.disabled = true;
        try {
          const created = await api('/api/decisions', { method: 'POST', body: { sessionId: state.detail.session.id, seq: m.seq, text } });
          afterDecisionChange({ added: created });
          toast('Marked as a decision.');
        } catch (err) {
          save.disabled = false;
          toast(err.message);
        }
      },
      onkeydown: (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          cancel();
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          form.requestSubmit();
        }
      },
    },
    h('div', { class: 'label' }, 'Decision'),
    ta,
    h(
      'p',
      { class: 'note' },
      quote
        ? 'Quoted from your selection. Edit it so it reads well on its own.'
        : 'Write it the way you’d want to find it later, e.g. “Use Postgres: SQLite can’t take concurrent writes.” Tip: select part of a message first to quote just that.',
    ),
    h('div', { class: 'actions' }, save, h('button', { type: 'button', class: 'text-button', onclick: cancel }, 'Cancel')),
  );
  msgEl.after(form);
  ta.focus();
  ta.select();
}

function editDecision(card, textEl, x) {
  const ta = h('textarea', { class: 'decide-text', rows: 3, maxlength: 2000, 'aria-label': 'The decision' });
  ta.value = x.text;
  const done = () => form.replaceWith(textEl);
  const form = h(
    'form',
    {
      class: 'decide-form inline',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const updated = await api(`/api/decisions/${encodeURIComponent(x.id)}`, { method: 'PUT', body: { text: ta.value } });
          afterDecisionChange({ updated });
        } catch (err) {
          toast(err.message);
        }
      },
      onkeydown: (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          done();
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          form.requestSubmit();
        }
      },
    },
    ta,
    h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'pill solid' }, 'Save'), h('button', { type: 'button', class: 'text-button', onclick: done }, 'Cancel')),
  );
  textEl.replaceWith(form);
  ta.focus();
}

/** Remove needs a second click within a few seconds, instead of a dialog. */
function removeButton(x) {
  let armed = false;
  let timer = 0;
  const btn = h(
    'button',
    {
      type: 'button',
      class: 'text-button danger',
      onclick: async () => {
        if (!armed) {
          armed = true;
          btn.textContent = 'Click again to remove';
          timer = setTimeout(() => {
            armed = false;
            btn.textContent = 'Remove';
          }, 3000);
          return;
        }
        clearTimeout(timer);
        try {
          await api(`/api/decisions/${encodeURIComponent(x.id)}`, { method: 'DELETE' });
          afterDecisionChange({ removed: x });
          toast('Decision removed.');
        } catch (err) {
          toast(err.message);
        }
      },
    },
    'Remove',
  );
  return btn;
}

function decisionCard(x, { inReader = false } = {}) {
  const textEl = h('p', { class: 'd-text' }, x.text);
  const open = () => select(x.sessionId, { seq: x.seq });
  const card = h(
    'div',
    { class: 'decision', dataset: { tool: x.session?.provider ?? '' } },
    h('div', { class: 'd-top' }, flag(), h('span', { class: 'd-when', title: fullDate(x.createdAt) }, `Decided ${agoLong(x.createdAt)}`)),
    textEl,
    !inReader && x.session
      ? h('div', { class: 'd-session' }, swatch(x.session.provider), h('span', { class: 'd-tool' }, toolLabel(x.session.provider)), h('span', { class: 'd-title', title: x.session.title }, x.session.title))
      : null,
    x.anchored ? null : h('p', { class: 'note' }, 'The message it came from is no longer in the session file. Your words are kept.'),
    h(
      'div',
      { class: 'd-actions' },
      inReader
        ? x.anchored
          ? h('button', { type: 'button', class: 'text-button', onclick: () => jumpTo(x.seq) }, 'Show in conversation')
          : null
        : x.session
          ? h(
              'button',
              { type: 'button', class: 'pill outline small', title: x.anchored ? 'Open the session at the message where this was decided' : 'Open the session', onclick: open },
              'Open',
            )
          : null,
      h('button', { type: 'button', class: 'text-button', onclick: () => editDecision(card, textEl, x) }, 'Edit'),
      removeButton(x),
    ),
  );
  return card;
}

/** Keep every view in step after adding, editing or removing a decision. */
function afterDecisionChange({ added, updated, removed }) {
  const changed = added ?? updated ?? removed;
  const sid = changed.sessionId;
  const counts = (state.board.decisionCounts ??= {});
  if (added) counts[sid] = (counts[sid] ?? 0) + 1;
  if (removed) counts[sid] = Math.max(0, (counts[sid] ?? 1) - 1);
  const merge = (list) => {
    const rest = list.filter((d) => d.id !== changed.id);
    return removed ? rest : [...rest, { ...(list.find((d) => d.id === changed.id) ?? {}), ...changed }];
  };
  if (state.decisions) state.decisions = merge(state.decisions).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (state.detail?.session.id === sid) {
    state.detail.decisions = merge(state.detail.decisions ?? []).sort((a, b) => a.seq - b.seq);
    renderReader({ keepScroll: els.reader.scrollTop });
    paintFind();
  }
  render();
}

function closeReader() {
  state.selected = null;
  state.detail = null;
  state.find = null;
  detailSeq++;
  els.reader.hidden = true;
  try {
    history.replaceState(null, '', location.pathname);
  } catch {
    /* ignore */
  }
  render();
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
}

function messageBody(text, terms = []) {
  const parts = [];
  const re = /```[^\n]*\n?([\s\S]*?)```/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(highlight(text.slice(last, m.index), terms));
    parts.push(h('pre', {}, highlight(m[1].replace(/\n$/, ''), terms)));
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(highlight(text.slice(last), terms));
  return parts.flat();
}

function bodyOf(m, terms = []) {
  return m.role === 'tool' ? highlight(m.text, terms) : messageBody(m.text, terms);
}

function messageEl(m, toolName, decisions) {
  const body = h('div', { class: 'body' }, bodyOf(m));
  const el = h(
    'div',
    { class: `msg ${m.role}${decisions?.length ? ' decided' : ''}`, dataset: { seq: String(m.seq) } },
    h(
      'div',
      { class: 'who' },
      m.role === 'user' ? 'You' : m.role === 'assistant' ? toolName : m.toolName ?? 'Tool',
      m.ts ? h('time', { datetime: m.ts, title: fullDate(m.ts) }, ago(m.ts)) : null,
      h(
        'button',
        {
          type: 'button',
          class: 'mark-btn',
          title: 'Mark this message as a decision. Select part of it first to quote just that.',
          onpointerdown: () => (pendingSelection = selectionIn(body)),
          onclick: () => openDecideForm(el, m, body),
        },
        flag(),
        'Mark as decision',
      ),
    ),
    decisions?.map((x) => h('div', { class: 'decision-callout' }, flag(), h('span', {}, x.text))),
    body,
  );
  return el;
}

/** Context over the session from the real per-turn token counts. */
function sparkline(series, windowSize, label) {
  const W = 388;
  const H = 64;
  const pts = series.points;
  const n = pts.length;
  const xAt = (i) => (n === 1 ? W : (i / (n - 1)) * W);
  const yAt = (v) => (H - 3 - Math.min(1, v / windowSize) * (H - 8)).toFixed(1);
  let line = '';
  pts.forEach((v, i) => {
    const x = xAt(i).toFixed(1);
    if (i === 0) {
      line = `M${n === 1 ? '0' : x},${yAt(v)}`;
      if (n === 1) line += ` L${x},${yAt(v)}`;
    } else if (series.compactions.includes(i)) {
      // A compaction is a sudden drop: go straight down, then continue
      line += ` L${x},${yAt(pts[i - 1])} L${x},${yAt(v)}`;
    } else {
      line += ` L${x},${yAt(v)}`;
    }
  });
  const area = `${line} L${W},${H} L0,${H} Z`;
  const ticks = series.compactions.map((i) => `M${xAt(i).toFixed(1)},0 L${xAt(i).toFixed(1)},${H}`).join(' ');
  const svg = s('svg', { class: 'spark', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': label });
  svg.append(s('path', { class: 'area', d: area }), s('path', { class: 'ticks', d: ticks || 'M0,0' }), s('path', { class: 'line', d: line }));
  return svg;
}

function linkCard(sess, why) {
  return h(
    'li',
    {},
    h(
      'button',
      {
        type: 'button',
        class: 'link-card',
        dataset: { tool: sess.provider },
        onclick: () => {
          select(sess.id);
          if (state.view === 'canvas' && state.pos.has(sess.id)) centerOn(sess.id);
        },
      },
      h('span', { class: 'lc-top' }, swatch(sess.provider), toolLabel(sess.provider), h('span', { class: 'lc-age' }, agoLong(sess.updatedAt))),
      h('span', { class: 'lc-title' }, sess.title),
      why ? h('span', { class: 'lc-why' }, why) : null,
    ),
  );
}

function renderReader({ keepScroll = null } = {}) {
  const d = state.detail;
  // Typing in the find box shouldn't lose focus when a jump reloads the panel
  const findFocus = document.activeElement?.classList?.contains('find-input') ? document.activeElement.selectionStart : null;
  if (!d) {
    els.reader.hidden = true;
    return;
  }
  const sess = d.session;
  const ctx = contextOf(sess);
  const caps = state.board?.capabilities ?? {};
  const tool = toolLabel(sess.provider);

  const copy = async (btn) => {
    try {
      await navigator.clipboard.writeText(d.resume.shell);
      btn.textContent = 'Copied';
      setTimeout(() => btn.isConnected && (btn.textContent = 'Copy command'), 1800);
    } catch {
      const code = $('.resume code', els.reader);
      const range = document.createRange();
      range.selectNodeContents(code);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      toast('Press ⌘C to copy the selected command.');
    }
  };
  const openTerminal = async () => {
    try {
      await api('/api/open-terminal', { method: 'POST', body: { id: sess.id } });
      toast('Opened in Terminal.');
    } catch (err) {
      toast(err.message);
    }
  };

  const resume = d.resume
    ? h(
        'div',
        { class: 'resume' },
        h('code', {}, d.resume.shell),
        h(
          'div',
          { class: 'actions' },
          caps.openTerminal ? h('button', { type: 'button', class: 'pill solid', onclick: openTerminal }, 'Open in Terminal') : null,
          h('button', { type: 'button', class: `pill ${caps.openTerminal ? 'outline' : 'solid'}`, onclick: (e) => copy(e.currentTarget) }, 'Copy command'),
          h('span', { class: 'hint' }, sess.isSubagent ? 'Reopens the conversation that started this subagent' : `Resumes in ${tool}`),
        ),
      )
    : null;

  const targets = sess.isSubagent ? [] : (caps.handoffTargets ?? []);
  const others = targets.filter((t) => t.id !== sess.provider);
  const same = targets.find((t) => t.id === sess.provider);
  const nearlyFull = (ctx?.pct ?? 0) >= 0.8;
  const handoff = targets.length
    ? h(
        'section',
        { class: 'section' },
        h('div', { class: 'label' }, 'Continue in a new session'),
        h(
          'div',
          { class: 'handoff-actions' },
          others.map((t) =>
            h('button', { type: 'button', class: 'pill outline', dataset: { tool: t.id }, onclick: () => openHandoff(sess.id, t.id) }, swatch(t.id), `Continue in ${t.label}`),
          ),
          same
            ? h(
                'button',
                { type: 'button', class: `pill ${nearlyFull ? 'solid' : 'outline'}`, dataset: { tool: same.id }, onclick: () => openHandoff(sess.id, same.id) },
                swatch(same.id),
                `Fresh ${same.label} session`,
              )
            : null,
        ),
        h(
          'p',
          { class: 'note' },
          nearlyFull
            ? 'This window is nearly full. A fresh session with a brief from this one gives the next step room to think.'
            : 'Writes a brief from this session so a new agent can pick up where it left off. You read and edit it before anything starts.',
        ),
      )
    : null;

  const compLine = sess.compactions ? `compacted ${times(sess.compactions)}` : 'never compacted';
  let context = null;
  if (ctx) {
    const series = d.contextSeries;
    context = h(
      'section',
      { class: 'section', dataset: { tool: sess.provider } },
      h('div', { class: 'label' }, 'Context window'),
      h(
        'div',
        { class: 'metric' },
        h('span', { class: 'big' }, ctx.pct != null ? `${pctOf(ctx)}%` : tokens(ctx.tokens)),
        h(
          'span',
          { class: 'tok' },
          ctx.pct != null
            ? `${tokens(ctx.tokens)} of ${ctx.estimated ? '~' : ''}${tokens(ctx.window)} tokens · ${compLine}`
            : `tokens in context · ${compLine}`,
        ),
      ),
      ctx.pct != null ? h('div', { class: 'bar-big' }, h('span', { style: { width: `${pctOf(ctx)}%` } })) : null,
      series?.points.length && ctx.window
        ? [sparkline(series, ctx.window, `Context over the session, ${compLine}`), h('div', { class: 'spark-axis' }, h('span', {}, 'start'), h('span', {}, compLine), h('span', {}, 'now'))]
        : null,
      ctx.estimated ? h('p', { class: 'note' }, 'Claude Code doesn’t record its window size, so 200k is assumed.') : null,
      // When handoff is available, its section already says this
      ctx.pct >= 0.8 && !targets.length ? h('p', { class: 'advice' }, 'Nearly full. Consider starting a fresh session for the next task.') : null,
    );
  }

  const facts = [
    ['Project', sess.cwd ?? 'unknown'],
    ['Branch', sess.gitBranch ?? '—'],
    ['Model', sess.model ?? '—'],
    ['Started', fullDate(sess.startedAt)],
    ['Last active', agoLong(sess.updatedAt)],
    ['Activity', `${plural(sess.userTurns, 'prompt')}, ${plural(sess.assistantTurns, 'reply', 'replies')}, ${plural(sess.toolCalls, 'tool call')}`],
    ['Tokens', `${tokens(sess.tokensIn)} read, ${tokens(sess.tokensOut)} written`],
    ['Id', sess.shortId],
  ];

  const related = d.related.map((r) =>
    linkCard(
      r.session,
      r.reason === 'continued-from'
        ? 'The earlier session this one continues'
        : r.reason === 'continued-in'
          ? 'Continues this session'
          : r.reason === 'shared-files'
            ? `Both edited ${shortPath(r.sharedFiles[0], r.session.cwd)}${r.sharedFiles.length > 1 ? ` and ${plural(r.sharedFiles.length - 1, 'other file')}` : ''}`
            : `Same branch: ${r.session.gitBranch}`,
    ),
  );

  const decidedAt = new Map();
  for (const x of d.decisions ?? []) {
    if (!x.anchored) continue;
    if (!decidedAt.has(x.seq)) decidedAt.set(x.seq, []);
    decidedAt.get(x.seq).push(x);
  }
  const convo = h('div', { class: `convo${state.showTools ? '' : ' hide-tools'}` }, d.messages.map((m) => messageEl(m, tool, decidedAt.get(m.seq))));

  const decisions = d.decisions?.length
    ? h(
        'section',
        { class: 'section' },
        h('div', { class: 'label' }, `Decisions · ${d.decisions.length}`),
        h('ul', { class: 'decision-list' }, d.decisions.map((x) => h('li', {}, decisionCard(x, { inReader: true })))),
      )
    : null;

  const find = h(
    'div',
    { class: 'find' },
    h('input', {
      type: 'search',
      class: 'find-input',
      placeholder: 'Find in this conversation',
      'aria-label': 'Find in this conversation',
      autocomplete: 'off',
      spellcheck: 'false',
      value: state.find?.q ?? '',
      oninput: (e) => {
        clearTimeout(findTimer);
        const q = e.target.value.trim();
        findTimer = setTimeout(() => loadFind(q), 200);
      },
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          stepFind(e.shiftKey ? -1 : 1);
        } else if (e.key === 'Escape' && e.target.value) {
          e.preventDefault();
          e.stopPropagation();
          e.target.value = '';
          loadFind('');
        }
      },
    }),
    h('span', { class: 'find-count', 'aria-live': 'polite' }),
    h('button', { type: 'button', class: 'round small', 'aria-label': 'Previous match', title: 'Previous match (Shift+Enter)', onclick: () => stepFind(-1) }, '↑'),
    h('button', { type: 'button', class: 'round small', 'aria-label': 'Next match', title: 'Next match (Enter)', onclick: () => stepFind(1) }, '↓'),
  );

  const total = d.truncatedMessages + d.messages.length + (d.truncatedAfter ?? 0);
  const windowNote =
    d.truncatedMessages || d.truncatedAfter
      ? h(
          'p',
          { class: 'note window-note' },
          `Showing messages ${d.truncatedMessages + 1}–${d.truncatedMessages + d.messages.length} of ${total}. `,
          d.truncatedMessages ? h('button', { type: 'button', class: 'text-button', onclick: () => jumpTo(Math.max(0, d.messages[0].seq - 1)) }, 'Earlier') : null,
          d.truncatedAfter ? h('button', { type: 'button', class: 'text-button', onclick: () => jumpTo(d.messages[d.messages.length - 1].seq + 1) }, 'Later') : null,
        )
      : null;

  els.reader.replaceChildren(
    h('div', { class: 'reader-glow', 'aria-hidden': 'true' }),
    h(
      'div',
      { class: 'reader-inner', dataset: { tool: sess.provider } },
      h(
        'div',
        { class: 'reader-head' },
        h('span', { class: 'tool-tag', title: sess.cliVersion ? `version ${sess.cliVersion}` : null }, swatch(sess.provider), tool),
        h(
          'button',
          { type: 'button', class: 'close', 'aria-label': 'Close details', onclick: closeReader },
          (() => {
            const svg = s('svg', { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': 'true' });
            svg.append(s('path', { d: 'M2 2 L10 10 M10 2 L2 10' }));
            return svg;
          })(),
        ),
      ),
      h('h2', { id: 'reader-title' }, sess.title),
      resume,
      decisions,
      handoff,
      context,
      h('dl', { class: 'facts' }, facts.flatMap(([k, v]) => [h('dt', {}, k), h('dd', { title: k === 'Id' ? sess.id : null }, v)])),
      h(
        'section',
        { class: 'section' },
        h('div', { class: 'label' }, `Files it changed · ${d.filesTouched.length}`),
        d.filesTouched.length
          ? h('ul', { class: 'files' }, d.filesTouched.map((f) => h('li', { title: f }, shortPath(f, sess.cwd))))
          : h('p', { class: 'note' }, 'Read-only session — nothing was edited.'),
      ),
      related.length ? h('section', { class: 'section' }, h('div', { class: 'label' }, 'Related sessions'), h('ul', { class: 'links' }, related)) : null,
      d.subagents.length
        ? h('section', { class: 'section' }, h('div', { class: 'label' }, 'Subagents'), h('ul', { class: 'links' }, d.subagents.map((x) => linkCard(x, null))))
        : null,
      h(
        'section',
        { class: 'section' },
        h(
          'div',
          { class: 'convo-head' },
          h('div', { class: 'label' }, 'Conversation'),
          h(
            'label',
            { class: 'toggle' },
            h('input', {
              type: 'checkbox',
              checked: state.showTools,
              onchange: (e) => {
                state.showTools = e.target.checked;
                prefs.set('showTools', state.showTools);
                convo.classList.toggle('hide-tools', !state.showTools);
              },
            }),
            'Tool calls',
          ),
        ),
        d.messages.length ? find : null,
        windowNote,
        d.messages.length ? convo : h('p', { class: 'note' }, 'No messages were recorded for this session.'),
      ),
    ),
  );
  els.reader.hidden = false;
  els.reader.scrollTop = keepScroll ?? 0;
  updateFindCount();
  if (findFocus != null) {
    const input = $('.find-input', els.reader);
    input?.focus({ preventScroll: true });
    input?.setSelectionRange(findFocus, findFocus);
  }
}

// ── Handoff composer ─────────────────────────────────────────────────────

const COMPANY = { 'claude-code': 'Anthropic', codex: 'OpenAI' };
// Where a brief goes for tools that can run any model
const MODEL_DEPENDENT = new Set(['qwen-code']);
// Step 3 of the brief, in its two forms (must match src/handoff.ts)
const CHECK_IN_STEP = '3. Then reply with a short summary of where things stand and the next step you propose, and wait for my go-ahead before changing any files.';
const CARRY_ON_STEP = '3. Then carry on with the next step.';

let composer = null;
/** Edited briefs survive closing and reopening the composer, per session and target. */
const drafts = new Map();

async function openHandoff(sessionId, to) {
  const key = `${sessionId}→${to}`;
  const draft = drafts.get(key);
  const qs = new URLSearchParams({ id: sessionId, to, checkIn: draft?.checkIn === false ? '0' : '1' });
  if (draft) qs.set('handoffId', draft.handoffId);
  let preview;
  try {
    preview = await api(`/api/handoff/preview?${qs}`);
  } catch (err) {
    toast(err.message);
    return;
  }
  composer = { key, sessionId, to, preview, checkIn: draft?.checkIn ?? true, returnFocus: document.activeElement };
  renderComposer(draft?.text ?? preview.brief);
}

/** While the composer is open, everything behind it is unreachable by keyboard and screen readers. */
function setBackgroundInert(on) {
  for (const el of [$('.bar'), els.board, els.list, els.reader]) el.inert = on;
}

function closeComposer() {
  if (!composer) return;
  const back = composer.returnFocus;
  composer = null;
  setBackgroundInert(false);
  els.composer.hidden = true;
  els.composer.replaceChildren();
  if (back?.isConnected) back.focus({ preventScroll: true });
}

function renderComposer(text) {
  const c = composer;
  const p = c.preview;
  const same = p.from.provider === p.to;

  const ta = h('textarea', { class: 'brief', id: 'brief', spellcheck: 'false', 'aria-describedby': 'brief-meta' });
  ta.value = text;
  const meta = h('span', { class: 'brief-meta', id: 'brief-meta' });
  const saveDraft = () => drafts.set(c.key, { text: ta.value, handoffId: p.handoffId, checkIn: c.checkIn });
  const updateMeta = () => {
    const n = Math.ceil(ta.value.length / 4);
    const pct = p.targetWindow ? (n / p.targetWindow) * 100 : null;
    meta.textContent = `about ${tokens(n)} tokens${pct != null ? ` · ${pct < 1 ? pct.toFixed(1) : Math.round(pct)}% of a new ${p.toLabel} window` : ''}`;
  };
  ta.addEventListener('input', () => {
    saveDraft();
    updateMeta();
  });
  updateMeta();

  const checkIn = h('input', {
    type: 'checkbox',
    checked: c.checkIn,
    onchange: (e) => {
      const on = e.target.checked;
      const [from, to] = on ? [CARRY_ON_STEP, CHECK_IN_STEP] : [CHECK_IN_STEP, CARRY_ON_STEP];
      if (ta.value.includes(from)) {
        ta.value = ta.value.replace(from, to);
        c.checkIn = on;
        saveDraft();
        updateMeta();
      } else {
        e.target.checked = !on;
        toast('That step isn’t in your edited brief any more, so nothing was changed.');
      }
    },
  });

  const busy = (on) => {
    for (const b of els.composer.querySelectorAll('.composer-actions button')) b.disabled = on;
  };
  const launch = async (openTerminal) => {
    busy(true);
    try {
      const res = await api('/api/handoff', {
        method: 'POST',
        body: { id: c.sessionId, to: c.to, handoffId: p.handoffId, brief: ta.value, launch: openTerminal },
      });
      drafts.delete(c.key);
      if (openTerminal) {
        toast(`Started in ${p.toLabel}. The new session shows up here once it begins.`);
        closeComposer();
        return;
      }
      try {
        await navigator.clipboard.writeText(res.command);
        toast('Command copied. Paste it into a terminal to start the new session.');
        closeComposer();
      } catch {
        // No clipboard access: show the command so it can be copied by hand
        cmd.textContent = res.command;
        cmd.hidden = false;
        busy(false);
      }
    } catch (err) {
      toast(err.message);
      busy(false);
    }
  };
  const cmd = h('code', { class: 'composer-cmd', hidden: true });

  const notes = [
    p.crossProvider && MODEL_DEPENDENT.has(p.to)
      ? h('p', { class: 'note' }, `Starting it sends this brief to the model ${p.toLabel} is set up to use. With a local model it stays on this computer; otherwise it goes to that model’s provider. Secrets were removed when the session was indexed, but read it through first.`)
      : p.crossProvider
        ? h('p', { class: 'note' }, `Starting it sends this brief to ${COMPANY[p.to] ?? p.toLabel} (${p.toLabel}). Secrets were removed when the session was indexed, but read it through first.`)
        : null,
    p.cwd && !p.cwdExists
      ? h('p', { class: 'warn' }, `The project folder ${p.cwd} isn’t on this computer any more, so the new session will start in your home folder.`)
      : null,
    !p.cwd ? h('p', { class: 'warn' }, 'This session didn’t record its project folder, so the new session will start in your home folder.') : null,
  ];

  const dialog = h(
    'section',
    { class: 'composer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'composer-title', dataset: { tool: p.to } },
    h(
      'div',
      { class: 'composer-head' },
      h(
        'div',
        {},
        h('div', { class: 'label' }, `Hand off · from ${p.fromLabel}`),
        h('h2', { id: 'composer-title' }, same ? `Start a fresh ${p.toLabel} session` : `Continue in ${p.toLabel}`),
      ),
      h(
        'button',
        { type: 'button', class: 'close', 'aria-label': 'Close', onclick: closeComposer },
        (() => {
          const svg = s('svg', { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': 'true' });
          svg.append(s('path', { d: 'M2 2 L10 10 M10 2 L2 10' }));
          return svg;
        })(),
      ),
    ),
    h(
      'p',
      { class: 'composer-lede' },
      `${p.toLabel} starts a new session${p.cwd && p.cwdExists ? ' in ' : ''}`,
      p.cwd && p.cwdExists ? h('code', {}, p.cwd) : null,
      ' with this brief as its first message. It’s written from this session. Edit anything you like.',
    ),
    notes,
    h('label', { class: 'visually-hidden', for: 'brief' }, 'Brief for the new session'),
    ta,
    h('div', { class: 'composer-meta' }, meta, h('label', { class: 'toggle' }, checkIn, 'Check in before changing files')),
    cmd,
    h(
      'div',
      { class: 'composer-actions' },
      p.canOpenTerminal ? h('button', { type: 'button', class: 'pill solid', onclick: () => launch(true) }, 'Open in Terminal') : null,
      h('button', { type: 'button', class: `pill ${p.canOpenTerminal ? 'outline' : 'solid'}`, onclick: () => launch(false) }, 'Copy command'),
      h(
        'button',
        {
          type: 'button',
          class: 'pill outline',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(ta.value);
              toast('Brief copied.');
            } catch {
              ta.select();
              toast('Press ⌘C to copy the selected brief.');
            }
          },
        },
        'Copy brief',
      ),
      h('button', { type: 'button', class: 'text-button', onclick: closeComposer }, 'Cancel'),
    ),
  );

  els.composer.replaceChildren(dialog);
  els.composer.hidden = false;
  setBackgroundInert(true);
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(0, 0);
  ta.scrollTop = 0;
}

(function attachComposerEvents() {
  // Click outside the dialog closes it
  els.composer.addEventListener('pointerdown', (e) => {
    if (e.target === els.composer) closeComposer();
  });
  // Keep Tab inside the dialog
  els.composer.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const items = [...els.composer.querySelectorAll('button:not([disabled]), textarea, input')].filter((x) => x.offsetParent);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
})();

// ── Header ────────────────────────────────────────────────────────────────

function renderHeader() {
  for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === state.view));
  for (const b of document.querySelectorAll('[data-group]')) b.setAttribute('aria-pressed', String(b.dataset.group === state.grouping));

  const all = state.board?.sessions ?? [];
  const counts = new Map();
  for (const x of all) counts.set(x.provider, (counts.get(x.provider) ?? 0) + 1);
  els.chips.replaceChildren(
    ...(state.board?.providers ?? []).map((p) => {
      const on = !state.hiddenTools.has(p.id);
      return h(
        'button',
        {
          type: 'button',
          class: 'chip',
          dataset: { tool: p.id },
          'aria-pressed': String(on),
          title: on ? `Hide ${p.label} sessions` : `Show ${p.label} sessions`,
          onclick: () => {
            if (on) state.hiddenTools.add(p.id);
            else state.hiddenTools.delete(p.id);
            prefs.set('hiddenTools', [...state.hiddenTools]);
            relayout();
            if (state.view === 'canvas') fit();
          },
        },
        swatch(p.id),
        h('span', { class: 'chip-label' }, p.label),
        h('span', { class: 'n' }, String(counts.get(p.id) ?? 0)),
      );
    }),
  );

  if (!state.connected) {
    els.count.textContent = 'not connected';
    els.count.title = 'Is contextdeck ui still running?';
    return;
  }
  const shown = visibleSessions().length;
  els.count.textContent = shown === all.length ? plural(all.length, 'session') : `${shown} of ${all.length}`;
  els.count.title = state.loadedAt ? `Last checked ${agoLong(state.loadedAt.toISOString())}` : '';
}

for (const b of document.querySelectorAll('[data-view]')) {
  b.addEventListener('click', () => {
    if (state.view === b.dataset.view) return;
    state.view = b.dataset.view;
    prefs.set('view', state.view);
    render();
    if (state.view === 'canvas') fit();
  });
}

for (const b of document.querySelectorAll('[data-group]')) {
  b.addEventListener('click', () => {
    if (state.grouping === b.dataset.group) return;
    state.grouping = b.dataset.group;
    prefs.set('grouping', state.grouping);
    relayout();
    if (state.view === 'canvas') fit();
  });
}

els.rescan.addEventListener('click', async () => {
  const label = $('span', els.rescan);
  els.rescan.disabled = true;
  label.textContent = 'Scanning';
  try {
    const sum = await api('/api/reindex', { method: 'POST' });
    await refresh();
    toast(sum.indexed || sum.removed ? `Found ${plural(sum.indexed, 'new or changed session')}.` : 'Nothing new since the last scan.');
  } catch (err) {
    toast(err.message);
  } finally {
    els.rescan.disabled = false;
    label.textContent = 'Rescan';
  }
});

document.addEventListener('keydown', (e) => {
  const typing = e.target.closest?.('input, textarea, [contenteditable]');
  if (e.key === '/' && !typing) {
    e.preventDefault();
    els.q.focus();
    els.q.select();
    return;
  }
  if (e.key === 'Escape') {
    if (composer) return closeComposer();
    if (!els.meaningPanel.hidden) {
      setMeaningPanel(false);
      return els.meaningBtn.focus();
    }
    if (e.target === els.q && els.q.value) return clearSearch();
    if (state.selected) return closeReader();
    if (state.search) return clearSearch();
  }
  if (composer || typing || state.view !== 'canvas' || e.metaKey || e.ctrlKey || e.altKey) return;
  const r = els.board.getBoundingClientRect();
  if (e.key === '+' || e.key === '=') zoomAt(1.15, r.width / 2, r.height / 2);
  else if (e.key === '-') zoomAt(1 / 1.15, r.width / 2, r.height / 2);
  else if (e.key === '0') fit();
});

// ── Render and data flow ──────────────────────────────────────────────────

function relayout() {
  if (!state.board) return;
  layout();
  render();
}

function render() {
  if (!state.board) return;
  renderHeader();
  els.board.hidden = state.view !== 'canvas';
  els.list.hidden = state.view !== 'list';
  els.decisions.hidden = state.view !== 'decisions';
  if (state.view === 'canvas') renderCanvas();
  else if (state.view === 'list') renderList();
  else renderDecisions();
  if (!state.selected) els.reader.hidden = true;
}

function setBoard(board) {
  const before = state.board ? new Map(state.board.sessions.map((x) => [x.id, x.updatedAt])) : null;
  state.board = board;
  state.byId = new Map(board.sessions.map((x) => [x.id, x]));
  if (board.meaning) {
    state.meaning = board.meaning;
    renderMeaningButton();
  }
  state.loadedAt = new Date();
  layout();
  render();
  if (before) {
    for (const x of board.sessions) {
      if (before.get(x.id) === x.updatedAt) continue;
      const el = cardEls.get(x.id);
      if (!el) continue;
      el.classList.remove('fresh');
      void el.offsetWidth;
      el.classList.add('fresh');
      el.addEventListener('animationend', () => el.classList.remove('fresh'), { once: true });
    }
  }
  return before;
}

async function refresh() {
  const board = await api('/api/board');
  const before = setBoard(board);
  if (state.search) runSearch();
  if (state.selected) {
    const now = state.byId.get(state.selected);
    if (now && before?.get(state.selected) !== now.updatedAt) select(state.selected, { focusReader: false, keepPlace: true });
  }
}

function connectEvents() {
  let failures = 0;
  const es = new EventSource('/api/events');
  es.addEventListener('hello', () => {
    failures = 0;
    if (!state.connected) {
      state.connected = true;
      refresh().catch(() => {});
    }
  });
  es.addEventListener('index', () => refresh().catch(() => {}));
  // Search by meaning: progress while catching up, and when it's turned on or off
  es.addEventListener('semantic', (e) => {
    const was = state.meaning?.state;
    try {
      state.meaning = JSON.parse(e.data);
    } catch {
      return;
    }
    renderMeaningButton();
    renderMeaningPanel();
    // Finished catching up: what's on screen can now be found by meaning too
    if (was === 'catching-up' && state.meaning.state === 'ready' && state.search) runSearch();
  });
  // Decisions changed (here, in another tab, or from the CLI): reload what shows them
  es.addEventListener('decisions', async () => {
    const open = state.selected;
    const before = open ? (state.board?.decisionCounts?.[open] ?? 0) : 0;
    state.decisions = null;
    try {
      await refresh();
    } catch {
      return;
    }
    if (open && state.selected === open && (state.board.decisionCounts?.[open] ?? 0) !== before) {
      select(open, { focusReader: false, keepPlace: true });
    }
  });
  es.onerror = () => {
    failures++;
    if (failures >= 2 && state.connected) {
      state.connected = false;
      renderHeader();
    }
  };
}

async function start() {
  applyCam();
  try {
    const [board, layoutData] = await Promise.all([api('/api/board'), api('/api/layout')]);
    state.layout = layoutData;
    setBoard(board);
    if (state.view === 'canvas') fit();
    const fromHash = decodeURIComponent(location.hash.slice(1));
    if (fromHash && state.byId.has(fromHash)) {
      await select(fromHash);
      if (state.view === 'canvas') centerOn(fromHash);
    }
  } catch (err) {
    els.empty.hidden = false;
    els.empty.replaceChildren(
      h('h2', {}, 'Couldn’t load your sessions'),
      h('p', {}, `${err.message} Check that `, h('code', {}, 'contextdeck ui'), ' is still running, then reload.'),
    );
    return;
  }
  connectEvents();
  setInterval(() => {
    renderHeader();
    if (state.view !== 'canvas') return;
    // Keep ages and glows honest without re-laying anything out
    for (const g of state.groups) {
      for (const item of g.items) {
        const age = cardEls.get(item.id)?.querySelector('.age');
        if (!age) continue;
        const t = ago(item.updatedAt);
        age.textContent = t;
        age.classList.toggle('now', t === 'now');
      }
    }
    renderGroups();
  }, 30_000);
  window.addEventListener('resize', () => state.view === 'canvas' && applyCam());
}

start();
