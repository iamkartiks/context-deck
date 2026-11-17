// Pairing page: the only page an unpaired device can load. It holds no token
// and no data. The one-time code arrives in the URL fragment, which browsers
// never send to the server, and is removed from the address bar straight away.

const $ = (id) => document.getElementById(id);

const code = location.hash.slice(1);
if (location.hash) history.replaceState(null, '', location.pathname);

function show(id) {
  for (const s of ['no-code', 'ask', 'waiting']) $(s).hidden = s !== id;
}

function say(text, bad = false) {
  const m = $('message');
  m.textContent = text;
  m.className = bad ? 'bad' : '';
  m.hidden = !text;
}

function guessName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  return 'Phone';
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
  return data;
}

async function poll() {
  try {
    const s = await api('GET', '/api/pair/status');
    if (s.state === 'approved') {
      say('Paired. Opening ContextDeck…');
      location.replace('/');
      return;
    }
    if (s.state === 'denied') {
      show(null);
      say('Your computer said no. To try again, make a new code on your computer.', true);
      return;
    }
    if (s.state === 'expired') {
      show(null);
      say('This request has expired. Make a new code on your computer and scan it again.', true);
      return;
    }
  } catch (err) {
    say(err.message, true);
  }
  setTimeout(poll, 2000);
}

if (/^[A-Za-z0-9_-]{16,64}$/.test(code)) {
  show('ask');
  $('name').value = guessName();
  $('ask').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('send').disabled = true;
    say('');
    try {
      const p = await api('POST', '/api/pair', { code, name: $('name').value });
      $('w-name').textContent = p.name;
      $('w-login').textContent = p.tailscaleLogin;
      show('waiting');
      setTimeout(poll, 1500);
    } catch (err) {
      $('send').disabled = false;
      say(err.message, true);
    }
  });
} else {
  show('no-code');
}
