// ContextDeck UI. Plain ES module, no build step, no dependencies.
// Talks only to the local server that served this page.

const TOKEN = document.querySelector('meta[name="contextdeck-token"]')?.getAttribute('content') ?? '';

// ── Small helpers ─────────────────────────────────────────────────────────

const $ = (sel, root = document) => root.querySelector(sel);

/** Build an element. Strings become text nodes, so session text can never inject markup. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const store = {
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
      /* private mode etc. */
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

function hashString(s) {
  let h1 = 2166136261;
  for (let i = 0; i < s.length; i++) h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619);
  return h1 >>> 0;
}

/** Deterministic pseudo-random in [-1, 1] for a key, so the mess is the same mess every time. */
function wobble(key) {
  let t = hashString(key) + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr}h`;
  const d = Math.round(hr / 24);
  if (d < 7) return `${d}d`;
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

function agoLong(iso) {
  if (!iso) return 'unknown';
  const s = (Date.parse(iso) - Date.now()) / 1000;
  const abs = Math.abs(s);
  if (abs < 60) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(s / 86400), 'day');
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function fullDate(iso) {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

function tokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

const TIMES = ['never', 'once', 'twice'];
const times = (n) => TIMES[n] ?? `${n} times`;

/**
 * How full a session's context window is.
 * Claude Code doesn't record its window size, so it is estimated (200k, or 1M
 * once a session has gone past 200k) and marked as an estimate.
 */
function contextOf(s) {
  if (!s.contextTokens) return null;
  let win = s.contextWindow;
  let estimated = false;
  if (!win && s.provider === 'claude-code') {
    win = s.contextTokens > 200_000 ? 1_000_000 : 200_000;
    estimated = true;
  }
  if (!win) return { tokens: s.contextTokens, window: null, pct: null, estimated, hot: false };
  const pct = Math.min(1, s.contextTokens / win);
  return { tokens: s.contextTokens, window: win, pct, estimated, hot: pct >= 0.8 };
}

const pctText = (c) => `${Math.round(c.pct * 100)}%`;

// ── State ─────────────────────────────────────────────────────────────────

const CARD_W = 240;
const CARD_H = 150;
const GAP = 24;
const PAD = 26;
const LABEL_H = 96;
const ZONE_GAP = 72;

const state = {
  board: null,
  byId: new Map(),
  layout: { version: 1, positions: { workstream: {}, project: {}, tool: {}, day: {} } },
  view: store.get('view', window.innerWidth < 720 ? 'list' : 'canvas'),
  grouping: store.get('grouping', 'workstream'),
  hiddenTools: new Set(store.get('hiddenTools', [])),
  showTools: store.get('showTools', false),
  listSort: 'updated',
  selected: null,
  detail: null,
  search: null,
  cam: { x: 40, y: 40, k: 1 },
  pos: new Map(),
  groups: [],
  hovered: null,
  loadedAt: null,
  connected: true,
};

const els = {
  desk: $('#canvas'),
  world: $('#world'),
  cards: $('#cards'),
  zones: $('#zones'),
  edges: $('#edges'),
  empty: $('#empty'),
  list: $('#list'),
  results: $('#results'),
  reader: $('#reader'),
  q: $('#q'),
  status: $('#status-text'),
  toast: $('#toast'),
  tidy: $('#tidy'),
  zoomLevel: $('#zoom-reset'),
  toolFilters: $('#tool-filters'),
  grouping: $('#grouping'),
};

let toastTimer = 0;
function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 3200);
}

const toolLabel = (id) => state.board?.providers.find((p) => p.id === id)?.label ?? id;
const toolName = (id, extra = {}) => h('span', { class: 'tool-name', dataset: { tool: id }, ...extra }, toolLabel(id));
const visibleSessions = () => (state.board?.sessions ?? []).filter((s) => !state.hiddenTools.has(s.provider));

// ── Grouping and layout ───────────────────────────────────────────────────

function dayLabel(iso) {
  if (!iso) return 'Unknown date';
  const d = new Date(iso);
  const today = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    ...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}

function buildGroups() {
  const visible = visibleSessions();
  const ids = new Set(visible.map((s) => s.id));
  const byUpdated = (a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
  const groups = [];

  if (state.grouping === 'workstream') {
    for (const w of state.board.workstreams) {
      const members = w.sessionIds.filter((id) => ids.has(id)).map((id) => state.byId.get(id));
      if (!members.length) continue;
      const tools = [...new Set(members.map((m) => m.provider))];
      groups.push({
        id: w.id,
        kind: w.kind,
        label: w.kind === 'linked' ? w.label : w.label,
        sub:
          w.kind === 'linked'
            ? [w.project && h('span', {}, w.project), w.branch && h('code', {}, w.branch), tools.length > 1 ? h('span', {}, `${tools.map(toolLabel).join(' and ')}`) : null]
            : [h('span', {}, members.length === 1 ? 'Not linked to other sessions' : 'Not linked to each other')],
        members: members.sort(byUpdated),
      });
    }
  } else {
    const keyOf = {
      project: (s) => s.cwd ?? '',
      tool: (s) => s.provider,
      day: (s) => (s.updatedAt ? new Date(s.updatedAt).toDateString() : ''),
    }[state.grouping];
    const map = new Map();
    for (const s of visible) {
      const k = keyOf(s);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(s);
    }
    for (const [k, members] of map) {
      members.sort(byUpdated);
      const first = members[0];
      let label;
      let sub;
      if (state.grouping === 'project') {
        label = first.project ?? 'No project';
        sub = [k && h('code', {}, k), h('span', {}, plural(members.length, 'session'))];
      } else if (state.grouping === 'tool') {
        label = toolLabel(k);
        sub = [h('span', {}, plural(members.length, 'session'))];
      } else {
        label = dayLabel(first.updatedAt);
        sub = [h('span', {}, plural(members.length, 'session'))];
      }
      groups.push({ id: `${state.grouping}:${k}`, kind: state.grouping === 'project' ? 'loose' : 'loose', label, sub, members });
    }
    groups.sort((a, b) => byUpdated(a.members[0], b.members[0]));
  }
  return groups;
}

/**
 * Rough width a zone needs for its title (40px heavy) and its caption
 * (19px when zoomed out), so zones are never narrower than their labels.
 */
function labelWidth(g) {
  const caption = g.sub
    .filter(Boolean)
    .map((n) => n.textContent)
    .join('    ');
  return Math.min(760, Math.max(g.label.length * 21, caption.length * 9.5) + 2 * PAD);
}

function layout() {
  const groups = buildGroups();
  const manual = state.layout.positions[state.grouping] ?? {};
  const desk = els.desk.getBoundingClientRect();

  // Size each zone
  for (const g of groups) {
    const n = g.members.length;
    const cols = n <= 3 ? n : n <= 8 ? 3 : 4;
    const rows = Math.ceil(n / cols);
    g.cols = cols;
    g.w = Math.max(cols * CARD_W + (cols - 1) * GAP + 2 * PAD, labelWidth(g));
    g.h = LABEL_H + rows * CARD_H + (rows - 1) * GAP + PAD;
  }

  // Shelf-pack zones into rows. Try many row widths and keep the one whose
  // overall shape best matches the screen, so "show everything" is as large as possible.
  const pack = (rowMax) => {
    let x = 0;
    let y = 0;
    let rowH = 0;
    let width = 0;
    const spots = [];
    for (const g of groups) {
      if (x > 0 && x + g.w > rowMax) {
        x = 0;
        y += rowH + ZONE_GAP;
        rowH = 0;
      }
      spots.push({ x, y });
      width = Math.max(width, x + g.w);
      x += g.w + ZONE_GAP;
      rowH = Math.max(rowH, g.h);
    }
    return { spots, width, height: y + rowH };
  };
  const viewW = Math.max(320, (desk.width || 1200) - 48);
  const viewH = Math.max(320, (desk.height || 800) - 100);
  let best = null;
  const widest = groups.reduce((m, g) => Math.max(m, g.w), 0);
  for (let rowMax = widest; rowMax <= widest + 8000; rowMax += 120) {
    const p = pack(rowMax);
    const scale = Math.min(viewW / p.width, viewH / p.height);
    if (!best || scale > best.scale + 1e-6) best = { ...p, scale };
  }

  // Place cards inside their zones with a little wobble
  state.pos = new Map();
  groups.forEach((g, gi) => {
    const { x, y } = best?.spots[gi] ?? { x: 0, y: 0 };
    g.x = x;
    g.y = y;
    g.members.forEach((s, i) => {
      const c = i % g.cols;
      const r = Math.floor(i / g.cols);
      const auto = {
        x: x + PAD + c * (CARD_W + GAP) + wobble(`${s.id}x`) * 7,
        y: y + LABEL_H + r * (CARD_H + GAP) + wobble(`${s.id}y`) * 7,
      };
      state.pos.set(s.id, manual[s.id] ?? auto);
    });
  });
  state.groups = groups;
  els.tidy.disabled = Object.keys(manual).length === 0;
}

/** Zones stretch around wherever their cards actually are, including cards you dragged away. */
function zoneRect(g) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of g.members) {
    const p = state.pos.get(s.id);
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + CARD_W);
    maxY = Math.max(maxY, p.y + CARD_H);
  }
  return {
    x: minX - PAD,
    y: minY - LABEL_H,
    w: Math.max(maxX - minX + 2 * PAD, labelWidth(g)),
    h: maxY - minY + LABEL_H + PAD,
  };
}

// ── Canvas rendering ──────────────────────────────────────────────────────

const cardEls = new Map();

function cardContent(s) {
  const ctx = contextOf(s);
  const fill = h('div', { class: 'fill', 'aria-hidden': 'true' });
  if (ctx?.pct != null) {
    fill.style.height = `${Math.max(3, ctx.pct * 100)}%`;
    if (ctx.estimated) fill.classList.add('estimate');
    if (ctx.hot) fill.classList.add('hot');
    for (let i = 1; i <= s.compactions; i++) {
      fill.append(h('i', { style: { bottom: `${(i / (s.compactions + 1)) * 100}%` } }));
    }
  } else {
    fill.style.display = 'none';
  }
  const helpers = state.board.subagentCounts[s.id];
  const ageText = ago(s.updatedAt);
  return [
    fill,
    h(
      'div',
      { class: 'card-top' },
      toolName(s.provider),
      h('span', { class: `age${ageText === 'now' ? ' live' : ''}`, title: fullDate(s.updatedAt) }, ageText),
    ),
    h('p', { class: 'card-title', title: s.title }, s.title),
    h(
      'div',
      { class: 'card-foot' },
      h('span', { class: 'proj' }, s.project ?? 'No project', helpers ? h('span', { class: 'helpers' }, `  +${plural(helpers, 'subagent')}`) : null),
      ctx
        ? h(
            'span',
            { class: `pct${ctx.hot ? ' hot' : ''}`, title: ctx.pct != null ? `${tokens(ctx.tokens)} of ${tokens(ctx.window)} tokens${ctx.estimated ? ' (window estimated)' : ''}` : `${tokens(ctx.tokens)} tokens` },
            ctx.pct != null ? pctText(ctx) : tokens(ctx.tokens),
          )
        : null,
    ),
  ];
}

function cardLabel(s) {
  const ctx = contextOf(s);
  return [
    s.title,
    `${toolLabel(s.provider)}, ${s.project ?? 'no project'}`,
    `updated ${agoLong(s.updatedAt)}`,
    ctx?.pct != null ? `context ${pctText(ctx)} full` : '',
  ]
    .filter(Boolean)
    .join('. ');
}

function renderCanvas() {
  const sessions = visibleSessions();
  const seen = new Set();
  for (const s of sessions) {
    seen.add(s.id);
    let el = cardEls.get(s.id);
    const sig = `${s.updatedAt}|${s.title}|${s.contextTokens}|${s.compactions}|${state.board.subagentCounts[s.id] ?? 0}`;
    if (!el) {
      el = h('div', {
        class: 'card',
        role: 'button',
        tabindex: '0',
        dataset: { id: s.id, tool: s.provider },
        style: { '--tilt': `${(wobble(s.id) * 1.8).toFixed(2)}deg` },
      });
      attachCardEvents(el);
      cardEls.set(s.id, el);
      els.cards.append(el);
    }
    if (el.dataset.sig !== sig) {
      el.replaceChildren(...cardContent(s));
      el.dataset.sig = sig;
      el.setAttribute('aria-label', cardLabel(s));
    }
    const p = state.pos.get(s.id);
    el.style.transform = `translate(${p.x}px, ${p.y}px)`;
    el.classList.toggle('selected', state.selected === s.id);
    el.classList.toggle('hit', !!state.search?.ids.has(s.id));
  }
  for (const [id, el] of cardEls) {
    if (!seen.has(id)) {
      el.remove();
      cardEls.delete(id);
    }
  }
  els.desk.classList.toggle('searching', !!state.search);
  renderZones();
  renderEdges();
  renderEmpty();
}

function renderZones() {
  els.zones.replaceChildren(
    ...state.groups.map((g) => {
      const r = zoneRect(g);
      return h(
        'div',
        {
          class: `zone ${g.kind}`,
          style: { transform: `translate(${r.x}px, ${r.y}px)`, width: `${r.w}px`, height: `${r.h}px` },
        },
        h(
          'div',
          { class: 'zone-label' },
          h('h2', { class: 'zone-title', title: g.label }, g.label),
          h('div', { class: 'zone-sub' }, g.sub),
        ),
      );
    }),
  );
}

function renderEdges() {
  const ns = 'http://www.w3.org/2000/svg';
  const focus = state.hovered ?? state.selected;
  const paths = [];
  for (const e of state.board?.edges ?? []) {
    const a = state.pos.get(e.a);
    const b = state.pos.get(e.b);
    if (!a || !b) continue;
    const ax = a.x + CARD_W / 2;
    const ay = a.y + CARD_H / 2;
    const bx = b.x + CARD_W / 2;
    const by = b.y + CARD_H / 2;
    const dx = bx - ax;
    const dy = by - ay;
    const bend = 0.18;
    const cx = (ax + bx) / 2 - dy * bend;
    const cy = (ay + by) / 2 + dx * bend;
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', `M${ax.toFixed(1)} ${ay.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${bx.toFixed(1)} ${by.toFixed(1)}`);
    if (focus && (e.a === focus || e.b === focus)) p.classList.add('on');
    paths.push(p);
  }
  els.edges.replaceChildren(...paths);
}

function renderEmpty() {
  const total = state.board?.sessions.length ?? 0;
  const visible = visibleSessions().length;
  if (total > 0 && visible > 0) {
    els.empty.hidden = true;
    return;
  }
  els.empty.hidden = false;
  if (total === 0) {
    const where = (state.board?.sources ?? []).map((src) =>
      h('li', {}, `${src.label}: `, h('code', {}, src.root)),
    );
    els.empty.replaceChildren(
      h('h2', {}, 'No sessions found yet'),
      h('p', {}, 'ContextDeck looked for sessions in these folders:'),
      h('ul', {}, where),
      h('p', {}, 'Use Claude Code or Codex for a bit, then choose Rescan. To see exactly what was found, run ', h('code', {}, 'contextdeck doctor'), ' in your terminal.'),
    );
  } else {
    els.empty.replaceChildren(
      h('h2', {}, 'Every tool is hidden'),
      h('p', {}, 'Turn a tool back on in the bar at the top to see its sessions.'),
    );
  }
}

// ── Camera ────────────────────────────────────────────────────────────────

function applyCam() {
  const { x, y, k } = state.cam;
  els.world.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
  els.desk.style.backgroundSize = `${24 * k}px ${24 * k}px`;
  els.desk.style.backgroundPosition = `${x}px ${y}px`;
  els.desk.classList.toggle('far', k < 0.62);
  els.zoomLevel.textContent = `${Math.round(k * 100)}%`;
}

function zoomAt(factor, cx, cy) {
  const { x, y, k } = state.cam;
  const nk = Math.min(1.8, Math.max(0.15, k * factor));
  state.cam = { k: nk, x: cx - ((cx - x) * nk) / k, y: cy - ((cy - y) * nk) / k };
  applyCam();
}

function worldBounds() {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const g of state.groups) {
    const r = zoneRect(g);
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

function fit() {
  const b = worldBounds();
  const rect = els.desk.getBoundingClientRect();
  if (!b || !rect.width) return;
  const left = state.search && !els.results.hidden ? 392 : 24;
  const right = !els.reader.hidden && rect.width > 900 ? 500 : 24;
  const w = rect.width - left - right;
  const hgt = rect.height - 24 - 76;
  const k = Math.min(1, Math.max(0.15, Math.min(w / (b.maxX - b.minX), hgt / (b.maxY - b.minY))));
  state.cam = {
    k,
    x: left + (w - (b.maxX - b.minX) * k) / 2 - b.minX * k,
    y: 24 + (hgt - (b.maxY - b.minY) * k) / 2 - b.minY * k,
  };
  applyCam();
}

function centerOn(id) {
  const p = state.pos.get(id);
  if (!p) return;
  const rect = els.desk.getBoundingClientRect();
  const right = !els.reader.hidden && rect.width > 900 ? 480 : 0;
  const left = state.search && !els.results.hidden && rect.width > 720 ? 376 : 0;
  const k = Math.max(state.cam.k, 0.75);
  state.cam = {
    k,
    x: left + (rect.width - left - right) / 2 - (p.x + CARD_W / 2) * k,
    y: rect.height / 2 - (p.y + CARD_H / 2) * k,
  };
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
      toast(`Couldn't save where you put that card: ${err.message}`);
    }
  }, 400);
}

let frame = 0;
function redrawSoon() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    renderZones();
    renderEdges();
  });
}

function attachCardEvents(el) {
  let start = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const id = el.dataset.id;
    const p = state.pos.get(id);
    start = { px: e.clientX, py: e.clientY, x: p.x, y: p.y, dragging: false };
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dx = (e.clientX - start.px) / state.cam.k;
    const dy = (e.clientY - start.py) / state.cam.k;
    if (!start.dragging && Math.hypot(dx, dy) * state.cam.k < 5) return;
    start.dragging = true;
    el.classList.add('lifted');
    const p = { x: Math.round(start.x + dx), y: Math.round(start.y + dy) };
    state.pos.set(el.dataset.id, p);
    el.style.transform = `translate(${p.x}px, ${p.y}px)`;
    redrawSoon();
  });
  const end = () => {
    if (!start) return;
    const wasDrag = start.dragging;
    start = null;
    el.classList.remove('lifted');
    const id = el.dataset.id;
    if (wasDrag) {
      state.layout.positions[state.grouping] ??= {};
      state.layout.positions[state.grouping][id] = state.pos.get(id);
      els.tidy.disabled = false;
      saveLayoutSoon();
    } else {
      select(id);
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', () => {
    start = null;
    el.classList.remove('lifted');
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select(el.dataset.id);
    }
  });
  el.addEventListener('pointerenter', () => {
    state.hovered = el.dataset.id;
    renderEdges();
  });
  el.addEventListener('pointerleave', () => {
    state.hovered = null;
    renderEdges();
  });
}

(function attachDeskEvents() {
  let pan = null;
  els.desk.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.card, .dock-left, .legend, .empty, .results')) return;
    pan = { px: e.clientX, py: e.clientY, x: state.cam.x, y: state.cam.y, moved: false };
    els.desk.setPointerCapture(e.pointerId);
    els.desk.classList.add('panning');
  });
  els.desk.addEventListener('pointermove', (e) => {
    if (!pan) return;
    const dx = e.clientX - pan.px;
    const dy = e.clientY - pan.py;
    if (Math.hypot(dx, dy) > 3) pan.moved = true;
    state.cam.x = pan.x + dx;
    state.cam.y = pan.y + dy;
    applyCam();
  });
  const end = () => {
    if (!pan) return;
    const clicked = !pan.moved;
    pan = null;
    els.desk.classList.remove('panning');
    if (clicked && state.selected) closeReader();
  };
  els.desk.addEventListener('pointerup', end);
  els.desk.addEventListener('pointercancel', end);

  els.desk.addEventListener(
    'wheel',
    (e) => {
      if (e.target.closest('.results, .empty')) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      if (e.ctrlKey || e.metaKey) {
        const rect = els.desk.getBoundingClientRect();
        zoomAt(Math.exp(-e.deltaY * unit * 0.0035), e.clientX - rect.left, e.clientY - rect.top);
      } else {
        state.cam.x -= e.deltaX * unit;
        state.cam.y -= e.deltaY * unit;
        applyCam();
      }
    },
    { passive: false },
  );

  const zoomCenter = (f) => {
    const r = els.desk.getBoundingClientRect();
    zoomAt(f, r.width / 2, r.height / 2);
  };
  $('#zoom-in').addEventListener('click', () => zoomCenter(1.25));
  $('#zoom-out').addEventListener('click', () => zoomCenter(0.8));
  els.zoomLevel.addEventListener('click', fit);
  els.tidy.addEventListener('click', () => {
    state.layout.positions[state.grouping] = {};
    saveLayoutSoon();
    layout();
    renderCanvas();
    fit();
    toast('Cards are back in their groups.');
  });
})();

// ── List view ─────────────────────────────────────────────────────────────

function renderList() {
  let rows = visibleSessions();
  if (state.search) {
    const rank = new Map(state.search.hits.map((hit, i) => [hit.session.id, i]));
    rows = rows.filter((s) => rank.has(s.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id));
  } else if (state.listSort === 'context') {
    rows.sort((a, b) => (contextOf(b)?.pct ?? -1) - (contextOf(a)?.pct ?? -1));
  } else {
    rows.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  const sortButton = (key, label) =>
    state.search
      ? label
      : h(
          'button',
          {
            type: 'button',
            'aria-sort': state.listSort === key ? 'descending' : null,
            onclick: () => {
              state.listSort = key;
              renderList();
            },
          },
          label,
        );

  if (!rows.length) {
    els.list.replaceChildren(
      h(
        'div',
        { class: 'sheet' },
        h(
          'p',
          { class: 'list-empty' },
          state.search
            ? `Nothing matches “${state.search.q}”. Try fewer words, or end a word with * to match its start.`
            : (state.board?.sessions.length ?? 0) === 0
              ? 'No sessions found yet. Use Claude Code or Codex, then choose Rescan.'
              : 'Every tool is hidden. Turn one back on in the bar at the top.',
        ),
      ),
    );
    return;
  }

  const body = rows.map((s) => {
    const ctx = contextOf(s);
    const hit = state.search?.hits.find((x) => x.session.id === s.id);
    return h(
      'tr',
      {
        tabindex: '0',
        dataset: { id: s.id, tool: s.provider },
        class: state.selected === s.id ? 'selected' : null,
        onclick: () => select(s.id),
        onkeydown: (e) => {
          if (e.key === 'Enter') select(s.id);
        },
      },
      h(
        'td',
        {},
        h('div', { class: 't-title' }, s.title),
        h('div', { class: 't-sub' }, toolName(s.provider), '  ', s.project ?? 'No project'),
        hit ? h('div', { class: 'snippet' }, snippet(hit.snippet)) : null,
      ),
      h('td', { class: 'c-branch' }, s.gitBranch ? h('code', {}, s.gitBranch) : ''),
      h('td', { class: 'num', title: fullDate(s.updatedAt) }, ago(s.updatedAt)),
      h(
        'td',
        {},
        ctx?.pct != null
          ? h(
              'div',
              { class: 'gauge', title: `${tokens(ctx.tokens)} of ${tokens(ctx.window)} tokens${ctx.estimated ? ' (window estimated)' : ''}` },
              h('span', { class: 'track' }, h('span', { class: ctx.hot ? 'hot' : null, style: { width: `${ctx.pct * 100}%` } })),
              h('span', { class: 'num' }, pctText(ctx)),
            )
          : h('span', { class: 'num' }, ctx ? `${tokens(ctx.tokens)} tokens` : ''),
      ),
      h('td', { class: 'num c-turns' }, String(s.userTurns)),
    );
  });

  els.list.replaceChildren(
    h(
      'div',
      { class: 'sheet' },
      h(
        'table',
        {},
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', { scope: 'col' }, state.search ? `${plural(rows.length, 'session')} mention “${state.search.q}”` : 'Session'),
            h('th', { scope: 'col', class: 'c-branch' }, 'Branch'),
            h('th', { scope: 'col' }, sortButton('updated', 'Updated')),
            h('th', { scope: 'col' }, sortButton('context', 'Context')),
            h('th', { scope: 'col', class: 'c-turns' }, 'Prompts'),
          ),
        ),
        h('tbody', {}, body),
      ),
    ),
  );
}

// ── Search ────────────────────────────────────────────────────────────────

/** Server snippets mark matches with «…». Turn those into <mark> without parsing HTML. */
function snippet(text) {
  const out = [];
  const re = /«([^»]*)»/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(h('mark', {}, m[1]));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

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
  try {
    const { hits } = await api(`/api/search?q=${encodeURIComponent(q)}`);
    if (seq !== searchSeq) return;
    const visibleHits = hits.filter((x) => !state.hiddenTools.has(x.session.provider));
    state.search = { q, hits: visibleHits, ids: new Set(visibleHits.map((x) => x.session.id)) };
  } catch (err) {
    if (seq !== searchSeq) return;
    state.search = { q, hits: [], ids: new Set(), error: err.message };
  }
  render();
}

function clearSearch(clearInput = true) {
  searchSeq++;
  if (clearInput) els.q.value = '';
  state.search = null;
  render();
}

function renderResults() {
  const show = state.view === 'canvas' && !!state.search;
  els.results.hidden = !show;
  if (!show) return;
  const { q, hits, error } = state.search;
  const head = h(
    'header',
    {},
    error
      ? error
      : hits.length
        ? `${plural(hits.length, 'session')} mention “${q}”`
        : `Nothing matches “${q}”. Try fewer words, or end a word with * to match its start.`,
  );
  const items = hits.map((hit) =>
    h(
      'li',
      {},
      h(
        'button',
        {
          type: 'button',
          class: state.selected === hit.session.id ? 'selected' : null,
          dataset: { tool: hit.session.provider },
          onclick: () => {
            select(hit.session.id);
            centerOn(hit.session.id);
          },
        },
        h('span', { class: 'r-meta' }, toolName(hit.session.provider), h('span', {}, hit.session.project ?? 'No project'), h('span', {}, ago(hit.session.updatedAt))),
        h('span', { class: 'r-title' }, hit.session.title),
        h('span', { class: 'r-snip' }, snippet(hit.snippet)),
      ),
    ),
  );
  els.results.replaceChildren(head, h('ol', {}, items));
}

// ── Reader ────────────────────────────────────────────────────────────────

let detailSeq = 0;
let returnFocus = null;

async function select(id, { focusReader = true } = {}) {
  const changed = state.selected !== id;
  state.selected = id;
  if (changed) returnFocus = document.activeElement;
  try {
    history.replaceState(null, '', `#${encodeURIComponent(id)}`);
  } catch {
    /* ignore */
  }
  render();
  const seq = ++detailSeq;
  try {
    const detail = await api(`/api/session/${encodeURIComponent(id)}`);
    if (seq !== detailSeq) return;
    state.detail = detail;
    renderReader();
    if (focusReader && changed) els.reader.focus({ preventScroll: true });
  } catch (err) {
    if (seq !== detailSeq) return;
    toast(err.message);
  }
}

function closeReader() {
  state.selected = null;
  state.detail = null;
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

function messageBody(text) {
  const parts = [];
  const re = /```[^\n]*\n?([\s\S]*?)```/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(h('pre', {}, m[1].replace(/\n$/, '')));
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** Show a file relative to the session's folder when it is inside it. */
function shortPath(file, cwd) {
  if (!cwd) return file;
  const base = cwd.replace(/[\\/]+$/, '');
  for (const sep of ['/', '\\']) {
    if (file.startsWith(base + sep)) return file.slice(base.length + 1);
  }
  return file;
}

function miniSession(s, why) {
  return h(
    'li',
    {},
    h(
      'button',
      { type: 'button', dataset: { tool: s.provider }, onclick: () => (select(s.id), state.view === 'canvas' && centerOn(s.id)) },
      h('span', { class: 'r-meta' }, toolName(s.provider), h('span', { class: 'note' }, `  ${agoLong(s.updatedAt)}`)),
      h('span', { class: 'm-title' }, s.title),
      why ? h('span', { class: 'm-why' }, why) : null,
    ),
  );
}

function renderReader() {
  const d = state.detail;
  if (!d) {
    els.reader.hidden = true;
    return;
  }
  const s = d.session;
  const ctx = contextOf(s);
  const caps = state.board?.capabilities ?? {};

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(d.resume.shell);
      toast('Command copied. Paste it into your terminal.');
    } catch {
      const code = $('.resume code', els.reader);
      const range = document.createRange();
      range.selectNodeContents(code);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      toast('Press ⌘C to copy the selected command.');
    }
  };
  const openTerminal = async () => {
    try {
      await api('/api/open-terminal', { method: 'POST', body: { id: s.id } });
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
          caps.openTerminal ? h('button', { type: 'button', class: 'btn', onclick: openTerminal }, 'Open in Terminal') : null,
          h('button', { type: 'button', class: caps.openTerminal ? 'btn secondary' : 'btn', onclick: copy }, 'Copy command'),
        ),
        s.isSubagent ? h('p', { class: 'note' }, 'Subagents can’t be resumed on their own, so this reopens the conversation that started it.') : null,
      )
    : null;

  let contextBlock = null;
  if (ctx?.pct != null) {
    const ticks = [];
    for (let i = 1; i <= s.compactions; i++) ticks.push(h('i', { style: { left: `${(i / (s.compactions + 1)) * ctx.pct * 100}%` } }));
    contextBlock = h(
      'div',
      { class: 'context', dataset: { tool: s.provider } },
      h('div', { class: 'bar-big', role: 'img', 'aria-label': `Context ${pctText(ctx)} full` }, h('span', { class: ctx.hot ? 'hot' : null, style: { width: `${ctx.pct * 100}%` } }), ticks),
      h(
        'p',
        {},
        `${pctText(ctx)} full: ${tokens(ctx.tokens)} of ${tokens(ctx.window)} tokens${ctx.estimated ? ' (window size estimated; Claude Code doesn’t record it)' : ''}. `,
        s.compactions ? `Compacted ${times(s.compactions)}.` : 'Never compacted.',
        ctx.hot ? ' Nearly full: consider starting a fresh session.' : '',
      ),
    );
  } else if (ctx) {
    contextBlock = h('div', { class: 'context' }, h('p', {}, `Context: ${tokens(ctx.tokens)} tokens. ${s.compactions ? `Compacted ${times(s.compactions)}.` : ''}`));
  }

  const facts = [
    ['Project', s.cwd ? h('code', {}, s.cwd) : 'Unknown'],
    s.gitBranch && ['Branch', h('code', {}, s.gitBranch)],
    s.model && ['Model', s.model],
    ['Started', h('span', { title: fullDate(s.startedAt) }, fullDate(s.startedAt) || 'Unknown')],
    ['Last active', h('span', { title: fullDate(s.updatedAt) }, agoLong(s.updatedAt))],
    ['Activity', `${plural(s.userTurns, 'prompt')}, ${plural(s.assistantTurns, 'reply', 'replies')}, ${plural(s.toolCalls, 'tool call')}`],
    ['Tokens', `${tokens(s.tokensIn)} read, ${tokens(s.tokensOut)} written`],
    ['Id', h('code', { title: s.id }, s.shortId)],
  ].filter(Boolean);

  const convo = h(
    'div',
    { class: `convo${state.showTools ? '' : ' hide-tools'}`, dataset: { tool: s.provider } },
    d.messages.map((m) =>
      h(
        'div',
        { class: `msg ${m.role}` },
        h(
          'div',
          { class: 'who' },
          m.role === 'user' ? 'You' : m.role === 'assistant' ? toolLabel(s.provider) : m.toolName ?? 'Tool',
          m.ts ? h('time', { datetime: m.ts, title: fullDate(m.ts) }, ago(m.ts)) : null,
        ),
        h('div', { class: 'body' }, m.role === 'tool' ? m.text : messageBody(m.text)),
      ),
    ),
  );

  const related = d.related.map((r) =>
    miniSession(
      r.session,
      r.reason === 'shared-files'
        ? `Both edited ${shortPath(r.sharedFiles[0], r.session.cwd)}${r.sharedFiles.length > 1 ? ` and ${plural(r.sharedFiles.length - 1, 'other file')}` : ''}`
        : `Same branch: ${r.session.gitBranch}`,
    ),
  );

  els.reader.replaceChildren(
    h(
      'div',
      { class: 'reader-inner', dataset: { tool: s.provider } },
      h(
        'div',
        { class: 'reader-head' },
        toolName(s.provider, { title: s.cliVersion ? `version ${s.cliVersion}` : null }),
        h('button', { type: 'button', class: 'close', 'aria-label': 'Close session', onclick: closeReader }, '×'),
      ),
      h('h2', { id: 'reader-title' }, s.title),
      resume,
      contextBlock,
      h('dl', { class: 'facts' }, facts.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      d.filesTouched.length ? [h('h3', {}, `Files it changed (${d.filesTouched.length})`), h('ul', { class: 'files' }, d.filesTouched.map((f) => h('li', { title: f }, shortPath(f, s.cwd))))] : null,
      related.length ? [h('h3', {}, 'Related sessions'), h('ul', { class: 'mini' }, related)] : null,
      d.subagents.length ? [h('h3', {}, 'Subagents'), h('ul', { class: 'mini' }, d.subagents.map((x) => miniSession(x)))] : null,
      h(
        'div',
        { class: 'convo-head' },
        h('h3', {}, 'Conversation'),
        h(
          'label',
          {},
          h('input', {
            type: 'checkbox',
            checked: state.showTools,
            onchange: (e) => {
              state.showTools = e.target.checked;
              store.set('showTools', state.showTools);
              convo.classList.toggle('hide-tools', !state.showTools);
            },
          }),
          'Show tool calls',
        ),
      ),
      d.truncatedMessages ? h('p', { class: 'note' }, `Showing the last ${d.messages.length} messages. ${plural(d.truncatedMessages, 'earlier message')} not shown.`) : null,
      d.messages.length ? convo : h('p', { class: 'note' }, 'No messages were recorded for this session.'),
    ),
  );
  els.reader.hidden = false;
  els.reader.scrollTop = 0;
}

// ── Top bar ───────────────────────────────────────────────────────────────

function renderToolbar() {
  for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === state.view));
  for (const b of document.querySelectorAll('[data-group]')) b.setAttribute('aria-pressed', String(b.dataset.group === state.grouping));
  els.grouping.hidden = state.view !== 'canvas';

  const counts = new Map();
  for (const s of state.board?.sessions ?? []) counts.set(s.provider, (counts.get(s.provider) ?? 0) + 1);
  els.toolFilters.replaceChildren(
    ...(state.board?.providers ?? []).map((p) =>
      h(
        'button',
        {
          type: 'button',
          class: 'tool-toggle',
          dataset: { tool: p.id },
          'aria-pressed': String(!state.hiddenTools.has(p.id)),
          title: state.hiddenTools.has(p.id) ? `Show ${p.label} sessions` : `Hide ${p.label} sessions`,
          onclick: () => {
            if (state.hiddenTools.has(p.id)) state.hiddenTools.delete(p.id);
            else state.hiddenTools.add(p.id);
            store.set('hiddenTools', [...state.hiddenTools]);
            if (state.search) runSearch();
            relayout();
          },
        },
        h('span', { class: 'swatch', 'aria-hidden': 'true' }),
        p.label,
        h('span', { class: 'count' }, String(counts.get(p.id) ?? 0)),
      ),
    ),
  );
  renderStatus();
}

function renderStatus() {
  if (!state.connected) {
    els.status.textContent = 'Not connected. Is contextdeck ui still running?';
    return;
  }
  const n = state.board?.sessions.length ?? 0;
  els.status.textContent = plural(n, 'session');
  els.status.title = state.loadedAt ? `Last checked ${agoLong(state.loadedAt.toISOString())}` : '';
}

for (const b of document.querySelectorAll('[data-view]')) {
  b.addEventListener('click', () => {
    if (state.view === b.dataset.view) return;
    state.view = b.dataset.view;
    store.set('view', state.view);
    render();
    if (state.view === 'canvas') fit();
  });
}

for (const b of document.querySelectorAll('[data-group]')) {
  b.addEventListener('click', () => {
    if (state.grouping === b.dataset.group) return;
    state.grouping = b.dataset.group;
    store.set('grouping', state.grouping);
    relayout();
    fit();
  });
}

$('#rescan').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  try {
    const sum = await api('/api/reindex', { method: 'POST' });
    await refresh();
    toast(sum.indexed || sum.removed ? `Found ${plural(sum.indexed, 'new or changed session')}.` : 'Nothing new since the last scan.');
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Rescan';
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
    if (e.target === els.q && els.q.value) return clearSearch();
    if (state.selected) return closeReader();
    if (state.search) return clearSearch();
  }
  if (typing || state.view !== 'canvas' || e.metaKey || e.ctrlKey || e.altKey) return;
  const r = els.desk.getBoundingClientRect();
  if (e.key === '+' || e.key === '=') zoomAt(1.25, r.width / 2, r.height / 2);
  else if (e.key === '-') zoomAt(0.8, r.width / 2, r.height / 2);
  else if (e.key === '0') fit();
});

// ── Render and data flow ──────────────────────────────────────────────────

function relayout() {
  layout();
  render();
}

function render() {
  if (!state.board) return;
  renderToolbar();
  els.desk.hidden = state.view !== 'canvas';
  els.list.hidden = state.view !== 'list';
  if (state.view === 'canvas') renderCanvas();
  else renderList();
  renderResults();
  if (!state.selected) els.reader.hidden = true;
}

function setBoard(board) {
  const before = state.board ? new Map(state.board.sessions.map((s) => [s.id, s.updatedAt])) : null;
  state.board = board;
  state.byId = new Map(board.sessions.map((s) => [s.id, s]));
  state.loadedAt = new Date();
  layout();
  render();
  if (before) {
    for (const s of board.sessions) {
      if (before.get(s.id) !== s.updatedAt) {
        const el = cardEls.get(s.id);
        if (!el) continue;
        el.classList.remove('fresh');
        void el.offsetWidth;
        el.classList.add('fresh');
        el.addEventListener('animationend', () => el.classList.remove('fresh'), { once: true });
      }
    }
  }
  return before;
}

async function refresh() {
  const board = await api('/api/board');
  const before = setBoard(board);
  if (state.selected) {
    const prev = before?.get(state.selected);
    const now = state.byId.get(state.selected);
    if (!now && !board.sessions.length) closeReader();
    else if (prev !== now?.updatedAt) select(state.selected, { focusReader: false });
  }
  if (state.search) runSearch();
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
  es.onerror = () => {
    failures++;
    if (failures >= 2 && state.connected) {
      state.connected = false;
      renderStatus();
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
      h('p', {}, err.message),
      h('p', {}, 'Check that ', h('code', {}, 'contextdeck ui'), ' is still running in your terminal, then reload this page.'),
    );
    return;
  }
  connectEvents();
  setInterval(() => {
    renderStatus();
    if (state.view === 'canvas') {
      // Keep "5m" style ages honest without re-laying anything out
      for (const s of visibleSessions()) {
        const age = cardEls.get(s.id)?.querySelector('.age');
        if (age) {
          const t = ago(s.updatedAt);
          age.textContent = t;
          age.classList.toggle('live', t === 'now');
        }
      }
    }
  }, 30_000);
  window.addEventListener('resize', () => {
    if (state.view === 'canvas') applyCam();
  });
}

start();
