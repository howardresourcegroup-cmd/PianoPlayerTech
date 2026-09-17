// Private lead dashboard at /leads. Replaces Airtable.
//
// One file on purpose: Pages routes every file under functions/ as an
// endpoint, so a shared auth helper would become its own public route.
// Login, rendering and updates all live here behind one door.
//
// Cloudflare Pages -> pianoplayertech -> Settings:
//   Bindings:   DB (D1) -> pianoplayertech-leads
//   Secrets:    ADMIN_PASSWORD
//
// Fails closed: with no ADMIN_PASSWORD set, nobody gets in. That is
// deliberate — this page holds customer names, numbers and addresses, so a
// half-finished setup must never leave it open.

const SESSION_HOURS = 12;
const COOKIE = 'ppt_admin';
const PIPELINES = { repair: 'Repair & Pneumatic', tuning: 'Tuning' };
const STATUSES = ['new', 'called', 'booked', 'closed'];

// ------------------------------------------------------------------ auth

const enc = new TextEncoder();

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Length-independent comparison, so timing never leaks how much was right.
function safeEqual(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

async function mintToken(secret) {
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  return `${exp}.${await hmac(secret, String(exp))}`;
}

async function tokenValid(secret, token) {
  if (!token || token.indexOf('.') < 0) return false;
  const [exp, sig] = token.split('.');
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmac(secret, exp));
}

function cookieValue(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

async function authed(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  return tokenValid(env.ADMIN_PASSWORD, cookieValue(request, COOKIE));
}

// Never cached, never indexed, never framed.
const PRIVATE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store, private',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer'
};

// ----------------------------------------------------------------- routes

export async function onRequestGet(context) {
  const { request, env } = context;

  if (!env.ADMIN_PASSWORD) {
    return new Response(page('Not set up yet', `
      <div class="card"><h1>Dashboard not configured</h1>
      <p class="muted">Add an <code>ADMIN_PASSWORD</code> secret in Cloudflare Pages
      &rarr; Settings &rarr; Variables and secrets, then redeploy. Until then nobody
      can open this page, including you.</p></div>`), { status: 503, headers: PRIVATE_HEADERS });
  }

  if (!(await authed(request, env))) {
    const bad = new URL(request.url).searchParams.get('e') === '1';
    return new Response(loginPage(bad), { status: bad ? 401 : 200, headers: PRIVATE_HEADERS });
  }

  const url = new URL(request.url);
  const pipeline = url.searchParams.get('p') === 'tuning' ? 'tuning' : 'repair';

  if (!env.DB) {
    return new Response(page('Leads', `
      <div class="card"><h1>No database connected</h1>
      <p class="muted">Bind a D1 database named <code>DB</code> in Cloudflare Pages
      &rarr; Settings &rarr; Bindings, then redeploy. New leads are still being
      emailed to you in the meantime &mdash; nothing is being lost.</p></div>`),
      { headers: PRIVATE_HEADERS });
  }

  let rows = [];
  let counts = { repair: 0, tuning: 0, newRepair: 0, newTuning: 0 };
  try {
    const list = await env.DB.prepare(
      `SELECT * FROM leads WHERE pipeline = ? ORDER BY
         CASE status WHEN 'new' THEN 0 ELSE 1 END, created_at DESC
       LIMIT 300`
    ).bind(pipeline).all();
    rows = list.results || [];

    const c = await env.DB.prepare(
      `SELECT pipeline, SUM(status = 'new') AS n, COUNT(*) AS total
         FROM leads GROUP BY pipeline`
    ).all();
    for (const r of (c.results || [])) {
      if (r.pipeline === 'tuning') { counts.tuning = r.total; counts.newTuning = r.n; }
      if (r.pipeline === 'repair') { counts.repair = r.total; counts.newRepair = r.n; }
    }
  } catch (err) {
    return new Response(page('Leads', `
      <div class="card"><h1>Could not read the database</h1>
      <p class="muted">${escape_(err && err.message)}</p>
      <p class="muted">If this says "no such table", the schema hasn't been applied yet:
      <code>npx wrangler d1 execute pianoplayertech-leads --remote --file=db/schema.sql</code></p></div>`),
      { status: 500, headers: PRIVATE_HEADERS });
  }

  return new Response(dashboard(pipeline, rows, counts), { headers: PRIVATE_HEADERS });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const type = request.headers.get('Content-Type') || '';

  // Login / logout arrive as a normal form post.
  if (type.includes('form')) {
    const form = await request.formData();
    const action = form.get('action');

    if (action === 'logout') {
      return new Response(null, {
        status: 303,
        headers: { Location: '/leads', 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` }
      });
    }

    if (!env.ADMIN_PASSWORD) return new Response('not configured', { status: 503 });

    if (safeEqual(form.get('password') || '', env.ADMIN_PASSWORD)) {
      const token = await mintToken(env.ADMIN_PASSWORD);
      return new Response(null, {
        status: 303,
        headers: {
          Location: '/leads',
          'Set-Cookie': `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_HOURS * 3600}; HttpOnly; Secure; SameSite=Strict`
        }
      });
    }
    // Slow down guessing without making a real typo feel broken.
    await new Promise((r) => setTimeout(r, 1000));
    return new Response(null, { status: 303, headers: { Location: '/leads?e=1' } });
  }

  // Everything else is a dashboard action and needs a valid session.
  if (!(await authed(request, env))) return new Response('unauthorized', { status: 401 });
  if (!env.DB) return new Response('no database', { status: 503 });

  let body;
  try { body = await request.json(); } catch { return new Response('bad request', { status: 400 }); }

  const id = parseInt(body.id, 10);
  if (!Number.isInteger(id)) return new Response('bad id', { status: 400 });

  const now = new Date().toISOString();
  try {
    if (body.action === 'status') {
      if (!STATUSES.includes(body.status)) return new Response('bad status', { status: 400 });
      await env.DB.prepare('UPDATE leads SET status = ?, updated_at = ? WHERE id = ?')
        .bind(body.status, now, id).run();
    } else if (body.action === 'note') {
      await env.DB.prepare('UPDATE leads SET notes = ?, updated_at = ? WHERE id = ?')
        .bind(String(body.notes || '').slice(0, 4000), now, id).run();
    } else {
      return new Response('unknown action', { status: 400 });
    }
  } catch (err) {
    console.error('dashboard update failed', err && err.message);
    return new Response('update failed', { status: 500 });
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

// ------------------------------------------------------------------ views

function escape_(s) {
  return String(s == null ? '' : s)
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const CSS = `
:root{--ground:#17120e;--surface:#211a14;--raised:#2b221a;--text:#f0e6d8;
--soft:#cabbaa;--muted:#9d8f7f;--gold:#d4b25a;--border:#3a2f24;--new:#d4b25a;--ok:#8fb583}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--text);font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:780px;margin:0 auto;padding:1.5rem 1.1rem 4rem}
h1{font-size:1.35rem;margin:0}
.muted{color:var(--muted);font-size:.9rem}
code{background:var(--raised);padding:.1em .4em;border-radius:4px;font-size:.85em}
.top{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:1.1rem;flex-wrap:wrap}
.top form{margin:0}
.linkbtn{background:none;border:0;color:var(--muted);font:inherit;font-size:.85rem;text-decoration:underline;cursor:pointer;padding:0}
.linkbtn:hover{color:var(--gold)}
.tabs{display:flex;gap:.5rem;margin-bottom:1.4rem}
.tab{flex:1;text-align:center;padding:.65rem .5rem;border-radius:8px;border:1px solid var(--border);
background:var(--surface);color:var(--soft);text-decoration:none;font-size:.92rem;font-weight:500}
.tab.on{background:var(--raised);color:var(--text);border-color:var(--gold)}
.pill{display:inline-block;min-width:1.35rem;margin-left:.4rem;padding:0 .35rem;border-radius:9px;
background:var(--new);color:#17120e;font-size:.75rem;font-weight:700;line-height:1.35rem}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:1rem 1.1rem;margin-bottom:.7rem}
.card.is-new{border-left:3px solid var(--new)}
.card.done{opacity:.55}
.hd{display:flex;justify-content:space-between;align-items:baseline;gap:.7rem}
.who{font-weight:600;font-size:1.05rem}
.when{color:var(--muted);font-size:.8rem;white-space:nowrap}
.meta{color:var(--gold);font-size:.88rem;margin:.15rem 0 .5rem}
.msg{color:var(--soft);font-size:.92rem;white-space:pre-wrap;margin:.5rem 0}
.contact{margin:.6rem 0 .2rem;font-size:.95rem}
.contact a{color:var(--gold);text-decoration:none;font-weight:600}
.contact a:hover{text-decoration:underline}
.row{display:flex;flex-wrap:wrap;gap:.4rem;align-items:center;margin-top:.7rem}
.sbtn{font:inherit;font-size:.82rem;padding:.3rem .7rem;border-radius:999px;cursor:pointer;
border:1px solid var(--border);background:var(--raised);color:var(--soft)}
.sbtn:hover{border-color:var(--gold);color:var(--text)}
.sbtn.on{background:var(--ok);border-color:var(--ok);color:#17120e;font-weight:600}
textarea{width:100%;margin-top:.6rem;background:var(--ground);color:var(--text);border:1px solid var(--border);
border-radius:6px;padding:.55rem .7rem;font:inherit;font-size:.88rem;resize:vertical;min-height:2.6rem}
textarea:focus{outline:none;border-color:var(--gold)}
details{margin-top:.6rem}
summary{cursor:pointer;color:var(--muted);font-size:.82rem}
dl{display:grid;grid-template-columns:auto 1fr;gap:.25rem .9rem;margin:.6rem 0 0;font-size:.85rem}
dt{color:var(--muted);white-space:nowrap}
dd{margin:0;color:var(--soft);word-break:break-word}
.empty{text-align:center;color:var(--muted);padding:3rem 1rem}
input[type=password]{width:100%;padding:.7rem .8rem;border-radius:7px;border:1px solid var(--border);
background:var(--ground);color:var(--text);font:inherit;margin:.7rem 0}
input[type=password]:focus{outline:none;border-color:var(--gold)}
.go{width:100%;padding:.7rem;border:0;border-radius:7px;background:var(--gold);color:#17120e;
font:inherit;font-weight:600;cursor:pointer}
.err{color:#e8927c;font-size:.87rem;margin:0}
.saved{color:var(--ok);font-size:.78rem;margin-left:.5rem;opacity:0;transition:opacity .2s}
.saved.show{opacity:1}
`;

function page(title, inner, extraJs) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escape_(title)} · PianoPlayerTech</title><style>${CSS}</style></head>
<body><div class="wrap">${inner}</div>${extraJs ? `<script>${extraJs}</script>` : ''}</body></html>`;
}

function loginPage(bad) {
  return page('Leads', `
    <div class="card" style="max-width:340px;margin:12vh auto 0">
      <h1>Leads</h1>
      <p class="muted">PianoPlayerTech</p>
      <form method="post">
        <input type="hidden" name="action" value="login">
        <input type="password" name="password" placeholder="Password" autofocus required
               autocomplete="current-password">
        ${bad ? '<p class="err">Wrong password.</p>' : ''}
        <button class="go" type="submit">Open</button>
      </form>
    </div>`);
}

function dashboard(pipeline, rows, counts) {
  const tab = (key) => {
    const n = key === 'tuning' ? counts.newTuning : counts.newRepair;
    return `<a class="tab${key === pipeline ? ' on' : ''}" href="/leads?p=${key}">${PIPELINES[key]}${
      n ? `<span class="pill">${n}</span>` : ''}</a>`;
  };

  const cards = rows.length ? rows.map(card).join('') :
    `<div class="empty"><p>No ${PIPELINES[pipeline].toLowerCase()} leads yet.</p>
     <p class="muted">They land here the moment someone submits a form.</p></div>`;

  return page('Leads', `
    <div class="top">
      <div><h1>Leads</h1><p class="muted">${counts.repair + counts.tuning} total</p></div>
      <form method="post"><input type="hidden" name="action" value="logout">
        <button class="linkbtn" type="submit">Sign out</button></form>
    </div>
    <div class="tabs">${tab('repair')}${tab('tuning')}</div>
    ${cards}`, DASH_JS);
}

function card(r) {
  const fields = (() => { try { return JSON.parse(r.fields || '{}'); } catch { return {}; } })();
  const meta = [r.service, r.system, r.city].filter(Boolean).map(escape_).join(' · ');
  const tel = String(r.phone || '').replace(/[^0-9+]/g, '');

  const detail = Object.keys(fields).length
    ? `<details><summary>Everything they submitted</summary><dl>${
        Object.keys(fields).map((k) =>
          `<dt>${escape_(k.replace(/[_-]+/g, ' '))}</dt><dd>${escape_(fields[k])}</dd>`).join('')
      }</dl></details>`
    : '';

  const buttons = STATUSES.map((s) =>
    `<button class="sbtn${r.status === s ? ' on' : ''}" data-id="${r.id}" data-status="${s}">${s}</button>`
  ).join('');

  return `<div class="card${r.status === 'new' ? ' is-new' : ''}${
      r.status === 'closed' ? ' done' : ''}" id="lead-${r.id}">
    <div class="hd">
      <span class="who">${escape_(r.name || 'No name given')}</span>
      <span class="when" data-ts="${escape_(r.created_at)}">${escape_(r.created_at)}</span>
    </div>
    ${meta ? `<div class="meta">${meta}</div>` : ''}
    <div class="contact">
      ${tel ? `<a href="tel:${escape_(tel)}">${escape_(r.phone)}</a>` : '<span class="muted">no phone</span>'}
      ${r.email ? ` &nbsp;·&nbsp; <a href="mailto:${escape_(r.email)}">${escape_(r.email)}</a>` : ''}
    </div>
    ${r.message ? `<div class="msg">${escape_(r.message)}</div>` : ''}
    ${detail}
    <div class="row">${buttons}<span class="saved" id="saved-${r.id}">saved</span></div>
    <textarea data-note="${r.id}" placeholder="Notes — quoted price, callback time, what they decided…"
      rows="1">${escape_(r.notes || '')}</textarea>
  </div>`;
}

const DASH_JS = `
(function(){
  // Timestamps are stored UTC; show them in the phone's own timezone.
  document.querySelectorAll('[data-ts]').forEach(function(el){
    var d = new Date(el.dataset.ts); if (isNaN(d)) return;
    var mins = Math.round((Date.now() - d) / 60000);
    var s = mins < 1 ? 'just now'
          : mins < 60 ? mins + ' min ago'
          : mins < 1440 ? Math.round(mins/60) + ' hr ago'
          : Math.round(mins/1440) + ' d ago';
    el.textContent = s;
    el.title = d.toLocaleString();
  });

  function post(payload, id){
    return fetch('/leads', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    }).then(function(r){
      if (!r.ok) throw new Error(r.status);
      var f = document.getElementById('saved-' + id);
      if (f){ f.classList.add('show'); setTimeout(function(){ f.classList.remove('show'); }, 1200); }
    }).catch(function(){ alert('Could not save — check your connection and try again.'); });
  }

  document.querySelectorAll('.sbtn').forEach(function(b){
    b.addEventListener('click', function(){
      var id = b.dataset.id, status = b.dataset.status;
      var card = document.getElementById('lead-' + id);
      card.querySelectorAll('.sbtn').forEach(function(x){ x.classList.remove('on'); });
      b.classList.add('on');
      card.classList.toggle('is-new', status === 'new');
      card.classList.toggle('done', status === 'closed');
      post({action:'status', id:Number(id), status:status}, id);
    });
  });

  // Notes save on blur — no save button to forget.
  document.querySelectorAll('[data-note]').forEach(function(t){
    t.style.height = 'auto'; t.style.height = (t.scrollHeight + 2) + 'px';
    var last = t.value;
    t.addEventListener('input', function(){
      t.style.height = 'auto'; t.style.height = (t.scrollHeight + 2) + 'px';
    });
    t.addEventListener('blur', function(){
      if (t.value === last) return;
      last = t.value;
      post({action:'note', id:Number(t.dataset.note), notes:t.value}, t.dataset.note);
    });
  });
})();
`;
