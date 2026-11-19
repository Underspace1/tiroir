// Tiroir — web UI. Plain DOM, virtualized views, talks to the local server (server.js).
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
// Inline onerror="" is blocked by our CSP; images marked data-drop just disappear when they fail.
document.addEventListener('error', (e) => { if (e.target.matches?.('img[data-drop]')) e.target.remove(); }, true);

// ---------- server bridge ----------
const api = new Proxy({}, {
  get: (_, name) => async (...args) => {
    const r = await fetch('/api/' + name, { method: 'POST', headers: { 'x-tiroir': '1', 'content-type': 'application/json' }, body: JSON.stringify(args) });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(r.status === 401 && !j?.error ? 'NO_SESSION' : j?.error || 'Erreur ' + r.status);
    return j;
  },
});
const listeners = {};
const on = (type, fn) => ((listeners[type] ||= []).push(fn));
function events() {
  const es = new EventSource('/events');
  es.onmessage = (e) => { const m = JSON.parse(e.data); (listeners[m.type] || []).forEach((fn) => fn(m.data)); };
}

const ICON = {};
const ic = (n) => (ICON[n] ??= lucide.createElement(lucide[n] || lucide.File, { class: 'lucide' }).outerHTML);
$$('[data-i]').forEach((el) => el.insertAdjacentHTML('afterbegin', ic(el.dataset.i)));

// ---------- file kinds ----------
const FOLDER = 'application/vnd.google-apps.folder';
const GAPPS = { 'application/vnd.google-apps.document': ['doc', 'Google Docs', '#9a9aa2', '.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], 'application/vnd.google-apps.spreadsheet': ['sheet', 'Google Sheets', '#9a9aa2', '.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], 'application/vnd.google-apps.presentation': ['slide', 'Google Slides', '#9a9aa2', '.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'], 'application/vnd.google-apps.form': ['form', 'Google Forms', '#9a9aa2'], 'application/vnd.google-apps.drawing': ['image', 'Google Drawings', '#9a9aa2', '.png', 'image/png'] };
function kind(f) {
  const m = f.mimeType || '';
  if (m === FOLDER) return 'folder';
  if (m === 'application/vnd.google-apps.shortcut') return f.shortcutDetails?.targetMimeType === FOLDER ? 'folder' : 'shortcut';
  if (GAPPS[m]) return GAPPS[m][0];
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf') return 'pdf';
  if (/zip|rar|7z|tar|gzip/.test(m)) return 'archive';
  if (/spreadsheet|excel|csv/.test(m)) return 'sheet';
  if (/presentation|powerpoint/.test(m)) return 'slide';
  if (/wordprocessing|msword|rtf/.test(m) || m === 'text/plain') return 'doc';
  if (/^text\/|json|javascript|xml|x-sh|x-python/.test(m)) return 'code';
  return 'other';
}
const KIND_ICON = { folder: 'Folder', image: 'FileImage', video: 'FileVideo', audio: 'FileAudio', pdf: 'FileText', doc: 'FileText', sheet: 'Sheet', slide: 'Presentation', archive: 'FileArchive', code: 'FileCode', form: 'File', shortcut: 'Link', other: 'File' };
const KIND_LABEL = { folder: 'Dossier', image: 'Image', video: 'Vidéo', audio: 'Audio', pdf: 'PDF', doc: 'Document', sheet: 'Tableur', slide: 'Présentation', archive: 'Archive', code: 'Texte / code', form: 'Formulaire', shortcut: 'Raccourci', other: 'Fichier' };
const typeLabel = (f) => GAPPS[f.mimeType]?.[1] || (f.fileExtension ? f.fileExtension.toUpperCase() + ' · ' : '') + KIND_LABEL[kind(f)];
const isFolder = (f) => kind(f) === 'folder';
const isMedia = (f) => ['image', 'video'].includes(kind(f));
const folderId = (f) => (f.mimeType === FOLDER ? f.id : f.shortcutDetails?.targetId);
const downloadable = (f) => f.mimeType === FOLDER || !f.mimeType.startsWith('application/vnd.google-apps.') || !!GAPPS[f.mimeType]?.[3];
const CHIPS = [['all', 'Tout'], ['folder', 'Dossiers'], ['image', 'Photos'], ['video', 'Vidéos'], ['docs', 'Documents'], ['audio', 'Audio'], ['other', 'Autres']];
const chipOf = (f) => { const k = kind(f); return ['folder', 'image', 'video', 'audio'].includes(k) ? k : ['pdf', 'doc', 'sheet', 'slide', 'code', 'form'].includes(k) ? 'docs' : 'other'; };
function aspect(f) {
  const m = f.imageMediaMetadata || f.videoMediaMetadata;
  if (!m?.width || !m?.height) return kind(f) === 'video' ? 16 / 9 : 1;
  const a = m.rotation % 2 ? m.height / m.width : m.width / m.height;
  return Math.min(2.6, Math.max(0.45, a));
}

// ---------- formatting ----------
const nf = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
function bytes(n) { n = Number(n); if (!n && n !== 0) return '—'; const u = ['o', 'Ko', 'Mo', 'Go', 'To']; let i = 0; while (n >= 1000 && i < 4) { n /= 1024; i++; } return nf.format(n) + ' ' + u[i]; }
const dShort = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
const dTime = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
function when(s) { if (!s) return '—'; const d = new Date(s); return d.toDateString() === new Date().toDateString() ? "aujourd'hui " + dTime.format(d) : dShort.format(d); }
const coll = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });
const dur = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const plural = (n, w) => `${nf.format(n)} ${w}${n > 1 ? 's' : ''}`;
const cleanErr = (e) => String(e?.message || e);

// ---------- URLs served by server.js ----------
let KEY = '';
const thumbUrl = (f, s) => `/thumb/${encodeURIComponent(f.id)}?s=${s}&v=${encodeURIComponent(f.modifiedTime || '')}`;
const mediaUrl = (f) => `/media/${encodeURIComponent(f.id)}`;
const dlUrl = (f) => `${location.origin}/dl/${encodeURIComponent(f.id)}?k=${KEY}`;
const selfThumb = (f) => /^image\/(jpeg|png|webp|gif)$/.test(f.mimeType) && Number(f.size) < 8e6;
const hasThumb = (f) => (f.thumbnailLink || selfThumb(f)) && f.mimeType !== 'application/vnd.google-apps.form';
const localName = (f) => { const ext = GAPPS[f.mimeType]?.[3]; return (ext && !f.name.toLowerCase().endsWith(ext) ? f.name + ext : f.name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_'); };

// ---------- state ----------
const S = {
  view: { kind: 'folder', id: 'root' }, path: [], files: [], sorted: [], nFolders: 0, filter: 'all',
  sel: new Set(), anchor: -1, focus: -1, hist: [], fwd: [],
  mode: 'grid', zoom: store.get('zoom', 190), sort: store.get('sort', { key: 'name', dir: 1 }),
  clip: null, loading: false, seq: 0, chat: [], attach: [], jobs: new Map(), dragIds: null,
};
const cache = new Map();
// Same folder = same key, however it was reached (sidebar, breadcrumbs, double-click carry different extra fields).
// "Mes fichiers" (only what this account owns) applies to the views that search the whole Drive.
const MINE_KINDS = new Set(['recent', 'starred', 'type', 'search']);
const mineOn = (v) => MINE_KINDS.has(v.kind) && store.get('onlyMine', false);
const withMine = (v) => (mineOn(v) ? { ...v, mine: true } : v);
const vkey = (v) => JSON.stringify([v.kind, v.id ?? v.type ?? v.text ?? '', mineOn(v) ? 1 : 0]);
// Lists are kept in memory only, for this session: Tiroir leaves nothing on disk when it closes (by choice).
// The sidebar menus are preloaded in the background right after start-up, so they still open instantly.
// (An old on-disk copy from earlier versions is deleted once.)
try { indexedDB.deleteDatabase('tiroir'); } catch {}
const idb = { get: async () => undefined, set: async () => {}, clear: async () => {} };
const diskKey = (key) => (S.me || '') + '|' + key;
const remember = (key, files) => { cache.set(key, files); idb.set(diskKey(key), files.slice(0, 4000)); };
const sameList = (a, b) => a?.length === b.length && a.every((f, i) => { const g = b[i]; return f.id === g.id && f.modifiedTime === g.modifiedTime && f.name === g.name && f.starred === g.starred && f.trashed === g.trashed; });
// Warm the cache in the background: the sidebar menus after start-up, a folder as soon as the mouse rests on it.
const warming = new Set();
async function warm(view) {
  const key = vkey(view);
  if (cache.has(key) || warming.has(key)) return;
  warming.add(key);
  try {
    const disk = await idb.get(diskKey(key));
    if (disk?.length && !cache.has(key)) cache.set(key, disk);
    if (!disk?.length) { const r = await api.driveList(withMine(view), null, 300); if (!cache.has(key) && r.files.length) remember(key, r.files); } // an empty first page proves nothing
  } catch {} finally { warming.delete(key); }
}
async function warmSidebar() {
  const views = [{ kind: 'folder', id: 'root' }, { kind: 'recent' }, { kind: 'starred' }, { kind: 'shared' }, ...Object.keys(TYPE_NAME).map((type) => ({ kind: 'type', type }))];
  for (const v of views) { await warm(v); await new Promise((r) => setTimeout(r, 60)); }
}
const byId = (id) => S.sorted.find((f) => f.id === id);
const selected = () => S.sorted.filter((f) => S.sel.has(f.id));
const currentFolder = () => (S.view.kind === 'folder' ? S.view.id : 'root');
const modeKey = (v) => (v.kind === 'type' ? 'type:' + v.type : v.kind === 'folder' ? 'folder:' + v.id : v.kind);

// ---------- "gluant" motion: gooey blobs + blurred page transitions ----------
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
function gooLayer(container) {
  const g = document.createElement('div'); g.className = 'goo';
  g.innerHTML = '<i class="lead"></i><i class="trail"></i>';
  container.prepend(g); return g;
}
// Both blobs travel to the target; the trail is slower, so they stretch apart and melt back together.
function gooTo(layer, el, instant) {
  if (!layer) return;
  if (!el || !el.offsetParent) { layer.style.opacity = 0; layer.dataset.ready = ''; return; }
  const c = layer.parentElement, r = el.getBoundingClientRect(), p = c.getBoundingClientRect();
  const x = r.left - p.left + c.scrollLeft, y = r.top - p.top + c.scrollTop;
  layer.style.height = c.scrollHeight + 'px'; // the filter clips to the layer: cover the whole scrollable sidebar
  const jump = instant || calm || !layer.dataset.ready;
  for (const b of layer.children) {
    if (jump) b.style.transition = 'none';
    b.style.transform = `translate(${x}px, ${y}px)`; b.style.width = r.width + 'px'; b.style.height = r.height + 'px';
    if (jump) { b.getBoundingClientRect(); b.style.transition = ''; }
  }
  layer.style.opacity = 1; layer.dataset.ready = '1';
}
const GOO = { side: gooLayer($('.side')), chips: gooLayer($('#chips')), mode: gooLayer($('#mode')) };
const moveSideGoo = (animate) => gooTo(GOO.side, $('.side a.on'), !animate);
addEventListener('resize', () => { moveSideGoo(false); gooTo(GOO.chips, $('#chips .on'), true); gooTo(GOO.mode, $('#mode .on'), true); });

const PAGE = () => [$('.head'), $('#scroller')];
function pageOut() {
  if (calm) return;
  S.entering = true; S.enterAt = performance.now() + 60; // short: switching menus must feel instant
  for (const el of PAGE()) el.animate([{ opacity: 1, filter: 'blur(0)' }, { opacity: 0, filter: 'blur(6px)', translate: '0 4px' }], { duration: 60, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' });
  clearTimeout(pageOut.safe); pageOut.safe = setTimeout(() => { if (S.entering) pageIn(); }, 1500); // whatever happens next, the view comes back
}
function pageIn() {
  S.entering = false;
  setTimeout(() => {
    for (const el of PAGE()) {
      el.getAnimations().forEach((a) => a.cancel());
      el.animate([{ opacity: 0, filter: 'blur(8px)', translate: '0 8px', scale: '.995' }, { opacity: 1, filter: 'blur(0)', translate: '0 0', scale: '1' }], { duration: 260, easing: 'cubic-bezier(.2,.9,.25,1)' });
    }
    canvas.classList.remove('enter'); void canvas.offsetWidth; canvas.classList.add('enter');
    clearTimeout(pageIn.t); pageIn.t = setTimeout(() => canvas.classList.remove('enter'), 520);
    // The content must never depend on an animation finishing (a stalled one would leave the page invisible).
    clearTimeout(pageIn.safe); pageIn.safe = setTimeout(() => { if (!S.entering) for (const el of PAGE()) el.getAnimations().forEach((a) => a.cancel()); }, 600);
  }, Math.max(0, S.enterAt - performance.now()));
}

// Links to Google pages: in the app window, Windows opens them in the default browser; in a browser, a new tab.
function openOut(url) {
  if (!/^https:\/\//.test(url)) return;
  if (window.tiroirWin?.openExternal) window.tiroirWin.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}

// ---------- boot ----------
let state;
async function boot() {
  try { KEY = await api.session(); } catch (e) { return noSession(); }
  state = await api.state();
  if (state.lock?.locked) return showLock();
  if (!state.configured || !state.signedIn) return showSetup();
  $('.setup')?.remove();
  S.accounts = await api.accounts().catch(() => []); // never block the files on the account list
  S.me = S.accounts.find((a) => a.active)?.email || '';
  paintAccounts();
  api.driveAbout().then((a) => {
    const used = Number(a.storageQuota.usage), lim = Number(a.storageQuota.limit);
    $('#quota').innerHTML = lim ? `${bytes(used)} / ${bytes(lim)}<div class="bar2"><i style="width:${Math.min(100, (used / lim) * 100)}%"></i></div>` : `${bytes(used)} utilisés`;
  }).catch(fail);
  $('#drives').hidden = true; $$('#drives a').forEach((a) => a.remove());
  api.driveDrives().then((ds) => {
    if (!ds.length) return;
    const g = $('#drives'); g.hidden = false;
    g.insertAdjacentHTML('beforeend', ds.map((d) => `<a data-view="drive:${esc(d.id)}">${ic('HardDrive')}${esc(d.name)}</a>`).join(''));
    moveSideGoo(false);
  }).catch(() => {});
  go(store.get('lastView:' + S.me, { kind: 'folder', id: 'root' }), { push: false });
  clearTimeout(boot.warm); boot.warm = setTimeout(warmSidebar, 1200); // once the first view is up
}
// Resting the mouse on a folder (tile or sidebar) loads it in advance: the double-click then opens instantly.
let warmT = 0;
document.addEventListener('mouseover', (e) => {
  const t = e.target.closest?.('.tile.folder, .row, .side a[data-view]'); if (!t) return;
  clearTimeout(warmT);
  warmT = setTimeout(() => {
    if (t.dataset.view) { const [k, arg] = t.dataset.view.split(':'); if (SVC_VIEWS.has(k)) return; return warm(k === 'folder' || k === 'drive' ? { kind: 'folder', id: arg } : k === 'type' ? { kind: 'type', type: arg } : { kind: k }); }
    const f = byId(t.dataset.id); if (f && isFolder(f)) warm({ kind: 'folder', id: folderId(f) });
  }, 120);
});

// ---------- several Google accounts ----------
const initials = (a) => (a.name || a.email || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
function paintAccounts() {
  $('#accts').innerHTML = S.accounts.map((a) => `<button class="acc ${a.active ? 'on' : ''}" data-acct="${esc(a.email)}" title="${a.active ? 'Drive affiché' : 'Afficher ce Drive'}">
    <span class="av">${esc(initials(a))}</span><span class="who"><b>${esc(a.name || a.email.split('@')[0])}</b><small>${esc(a.email)}</small></span></button>`).join('');
}
$('#accts').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-acct]'); if (!b || b.classList.contains('on')) return;
  try {
    await api.accountSwitch(b.dataset.acct);
    cache.clear(); S.hist = []; S.fwd = []; S.path = []; S.clip = null; S.chat = [];
    await boot();
    toast(`Drive de ${b.dataset.acct}`);
  } catch (x) { fail(x); }
});
$('#addDrive').onclick = () => modal(`<form><h4>Ajouter un autre Drive</h4>
  <p>Tu peux relier autant de comptes Google que tu veux et passer de l'un à l'autre en un clic.</p>
  <ol class="steps"><li>Ajoute d'abord l'adresse Gmail de ce compte dans la liste des <b>utilisateurs tests</b> de ton projet Google (comme à l'étape 4 de la connexion).</li>
  <li>Clique sur <b>Continuer</b>, puis choisis ce compte dans la page Google qui s'ouvre.</li></ol>
  <div class="btns"><button type="button" class="btn left" data-aud>Ouvrir la liste des testeurs</button><button type="button" class="btn" data-x>Annuler</button><button class="btn primary">Continuer</button></div></form>`, (m, done) => {
  $('[data-aud]', m).onclick = () => openOut('https://console.cloud.google.com/auth/audience');
  $('form', m).onsubmit = async (e) => {
    e.preventDefault();
    const tab = window.tiroirWin ? null : window.open('about:blank', '_blank');
    done(true);
    try {
      const url = await api.authStart();
      if (tab) tab.location = url; else openOut(url);
      toast('Termine la connexion dans ton navigateur…', 60000);
      const email = await api.authWait();
      cache.clear(); S.hist = []; S.fwd = []; S.path = [];
      await boot(); toast(`Drive de ${email} ajouté`);
    } catch (x) { tab?.close(); toast(oauthMsg(x), 8000); }
  };
});
// ---------- passcode lock ----------
// The server holds no usable Google sign-in while locked; the page also drops everything it was showing.
function wipePage() {
  cache.clear(); S.files = []; S.sorted = []; S.nFolders = 0; S.sel.clear(); S.chat = []; S.attach = []; S.hist = []; S.fwd = []; S.clip = null;
  SV.mail = { label: 'INBOX', q: '', list: [], next: null, open: null }; SV.cal.events = null; SV.tasks = { lists: null, list: null };
  try { layout(); } catch {}
  svcEl.innerHTML = ''; $('#info').innerHTML = ''; $('#msgs').innerHTML = ''; $('#q').value = '';
  if (V) closeV();
  if (!$('#modal').hidden) { $('#modal').hidden = true; $('#modal').innerHTML = ''; }
  $('#drawer').hidden = true; $('#menu').hidden = true;
}
function showLock() {
  if ($('.setup.lock')) return;
  wipePage(); $('.setup')?.remove();
  document.body.insertAdjacentHTML('beforeend', `<div class="setup lock"><form class="in" autocomplete="off">
    <div class="brand"><span class="mark"></span>Tiroir</div>
    <span class="lockic">${ic('LockKeyhole')}</span>
    <h1>Tiroir est verrouillé</h1>
    <p>Entre ton code pour accéder à ton Drive, tes mails et ton agenda.</p>
    <input type="password" id="lockCode" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="Code" maxlength="64">
    <div class="err" id="lockErr"></div>
    <button class="btn primary big" id="lockGo">${ic('LockOpen')}Déverrouiller</button>
    <button type="button" class="lnk" id="lockForgot">Code oublié ?</button></form></div>`);
  keepWinctlOnTop();
  const root = $('.setup.lock'); const inp = $('#lockCode', root); setTimeout(() => inp.focus(), 50);
  $('form', root).onsubmit = async (e) => {
    e.preventDefault(); const b = $('#lockGo', root); b.disabled = true; $('#lockErr', root).textContent = '';
    try { await api.unlock(inp.value); root.remove(); await boot(); }
    catch (x) { $('#lockErr', root).textContent = cleanErr(x); inp.select(); }
    finally { b.disabled = false; }
  };
  $('#lockForgot', root).onclick = async () => {
    if (!(await confirmBox('Réinitialiser le verrou ?', 'Sans le code, tes connexions Google chiffrées ne peuvent pas être récupérées : Tiroir les oublie et le verrou est retiré. Tu reconnectes ensuite ton compte Google (tes fichiers restent intacts dans Google Drive).', 'Réinitialiser'))) return;
    await api.lockReset().catch(fail); root.remove(); state = await api.state(); store.set('setupStep', SETUP_STEPS.length - 1); showSetup();
  };
}
on('locked', showLock);
// Activity without requests (reading a long mail) still counts, so auto-lock only triggers when you are really away.
let lastPing = 0;
for (const ev of ['mousemove', 'keydown', 'wheel', 'mousedown']) addEventListener(ev, () => {
  if (!state?.lock?.enabled || $('.setup.lock') || Date.now() - lastPing < 60_000) return;
  lastPing = Date.now(); api.ping().catch(() => {});
}, { passive: true });
async function lockSettings(m) {
  const L = state.lock || {};
  const mins = [[5, '5 min'], [15, '15 min'], [30, '30 min'], [60, '1 heure'], [0, 'Jamais (seulement à la fermeture)']];
  const opts = (sel) => mins.map(([v, n]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${n}</option>`).join('');
  if (!L.enabled) {
    return modal(`<form><h4>Activer le verrou</h4>
      <p>Tiroir demandera ce code à chaque ouverture et après une absence. Tes connexions Google seront chiffrées avec : sans le code, personne ne peut s'en servir, même en copiant tes fichiers.</p>
      <label>Code (6 caractères minimum)<input type="password" name="a" inputmode="numeric" autocomplete="new-password"></label>
      <label>Confirme le code<input type="password" name="b" inputmode="numeric" autocomplete="new-password"></label>
      <label>Verrouiller après une absence de<select name="m">${opts(15)}</select></label>
      <div class="err" id="lkErr"></div>
      <div class="btns"><button type="button" class="btn" data-x>Annuler</button><button class="btn primary">${ic('Lock')}Activer</button></div></form>`, (mm, done) => {
      $('[name=a]', mm).focus();
      $('form', mm).onsubmit = async (e) => {
        e.preventDefault(); const v = Object.fromEntries(new FormData(e.target));
        if (v.a !== v.b) return ($('#lkErr', mm).textContent = 'Les deux codes ne sont pas identiques.');
        try { await api.lockSetup(v.a, Number(v.m)); state = await api.state(); done(true); toast('Verrou activé · Ctrl+L pour verrouiller tout de suite'); }
        catch (x) { $('#lkErr', mm).textContent = cleanErr(x); }
      };
    });
  }
  return modal(`<form><h4>Verrou</h4>
    <label>Verrouiller après une absence de<select name="m">${opts(L.minutes)}</select></label>
    <details class="manual"><summary>Changer le code</summary>
      <label>Code actuel<input type="password" name="old" inputmode="numeric" autocomplete="current-password"></label>
      <label>Nouveau code<input type="password" name="nw" inputmode="numeric" autocomplete="new-password"></label>
      <button type="button" class="btn" data-change>Changer le code</button></details>
    <details class="manual"><summary>Désactiver le verrou</summary>
      <label>Code actuel<input type="password" name="off" inputmode="numeric" autocomplete="current-password"></label>
      <button type="button" class="btn danger" data-off>Désactiver</button></details>
    <div class="err" id="lkErr"></div>
    <div class="btns"><button type="button" class="btn left" data-now>${ic('Lock')}Verrouiller maintenant</button><button type="button" class="btn" data-x>Fermer</button></div></form>`, (mm, done) => {
    const err = (x) => ($('#lkErr', mm).textContent = cleanErr(x));
    $('[name=m]', mm).onchange = (e) => api.lockMinutes(Number(e.target.value)).then(async () => { state = await api.state(); toast('Délai enregistré'); }).catch(err);
    $('[data-change]', mm).onclick = () => api.lockChange($('[name=old]', mm).value, $('[name=nw]', mm).value).then(() => { done(true); toast('Code changé'); }).catch(err);
    $('[data-off]', mm).onclick = () => api.lockDisable($('[name=off]', mm).value).then(async () => { state = await api.state(); done(true); toast('Verrou désactivé'); }).catch(err);
    $('[data-now]', mm).onclick = () => { done(true); api.lockNow().then(showLock).catch(fail); };
  });
}

let expiredOpen = false;
function expired() {
  if (expiredOpen || !$('#modal').hidden) return;
  expiredOpen = true;
  modal(`<form><h4>Ta connexion Google a expiré</h4>
    <p>Google a coupé l'accès de Tiroir à ${esc(S.me)}. Reconnecte-toi en un clic, tes réglages sont gardés.</p>
    <p>Si ça revient <b>chaque semaine</b>, c'est que ton app Google est encore « en test » : ouvre la page Audience et clique sur <b>Publier l'application</b>. Ensuite, la connexion ne s'arrête plus.</p>
    <div class="btns"><button type="button" class="btn left" data-aud>${ic('ExternalLink')}Page Audience</button><button type="button" class="btn" data-x>Plus tard</button><button class="btn primary">Se reconnecter</button></div></form>`, (m, done) => {
    $('[data-aud]', m).onclick = () => openOut('https://console.cloud.google.com/auth/audience');
    $('form', m).onsubmit = (e) => { e.preventDefault(); done(true); authorizeServices().then(() => { cache.clear(); boot(); }); };
  }).finally(() => { expiredOpen = false; });
}
function noSession() {
  document.body.insertAdjacentHTML('beforeend', `<div class="setup"><div class="in"><div class="brand"><span class="mark"></span>Tiroir</div><h1>Ouvre Tiroir depuis son lanceur</h1><p>Pour protéger ton Drive, cette page n'accepte que le navigateur ouvert par Tiroir. Lance Tiroir depuis son raccourci sur le Bureau.</p></div></div>`);
  keepWinctlOnTop();
}
function fail(e) {
  const m = cleanErr(e);
  if (m === 'LOCKED') return showLock();
  if (m.includes('invalid_grant') && state?.configured && S.me) return expired(); // the sign-in just ran out: one click, not the whole setup again
  if (m.includes('NOT_SIGNED_IN') || m.includes('invalid_grant')) return showSetup();
  if (m === 'NO_SESSION') return noSession();
  toast(m);
}

// ---------- navigation ----------
const VIEW_NAME = { recent: 'Récents', starred: 'Favoris', shared: 'Partagés avec moi', trash: 'Corbeille', gmail: 'Gmail', calendar: 'Agenda', tasks: 'Tâches' };
const TYPE_NAME = { image: 'Photos', video: 'Vidéos', audio: 'Audio', pdf: 'PDF', doc: 'Textes', sheet: 'Tableurs', slide: 'Présentations', archive: 'Archives' };
const viewTitle = (v) => v.kind === 'folder' ? S.path.at(-1)?.name || v.name || 'Mon Drive' : v.kind === 'type' ? TYPE_NAME[v.type] : v.kind === 'search' ? `« ${v.text} »` : VIEW_NAME[v.kind];

function go(view, { push = true } = {}) {
  if (push) { S.hist.push({ view: S.view, path: S.path }); S.fwd = []; }
  S.view = view; S.sel.clear(); S.anchor = S.focus = -1; S.filter = 'all';
  S.mode = store.get('modes', {})[modeKey(view)] || (view.kind === 'type' && (view.type === 'image' || view.type === 'video') ? 'gallery' : store.get('mode', 'grid'));
  store.set('lastView:' + (S.me || ''), view);
  $('#scroller').scrollTop = 0;
  $$('.side a').forEach((a) => a.classList.toggle('on', a.dataset.view === sideKey(view)));
  moveSideGoo(true);
  pageOut();
  $('#back').disabled = !S.hist.length; $('#fwd').disabled = !S.fwd.length;
  crumbs();
  const svc = isSvc(view);
  document.body.classList.toggle('insvc', svc); svcEl.hidden = !svc;
  if (svc) {
    S.seq++; S.files = []; S.sorted = []; S.nFolders = 0; layout(); // nothing selectable behind the Google view: Suppr, Ctrl+A… can't touch hidden files
    if (view.kind !== 'gmail') $('#q').value = '';
    svcRender(); S.entering = false; pageIn(); return;
  }
  svcEl.innerHTML = ''; $('#q').placeholder = 'Rechercher dans Drive';
  load();
}
const sideKey = (v) => (v.kind === 'folder' ? (v.id === 'root' ? 'folder:root' : v.driveId && v.id === v.driveId ? 'drive:' + v.id : '') : v.kind === 'type' ? 'type:' + v.type : v.kind);

function crumbs() {
  const v = S.view;
  if (v.kind !== 'folder') { S.path = []; paintCrumbs(); return; }
  const known = S.path.findIndex((p) => p.id === v.id);
  if (known >= 0) S.path = S.path.slice(0, known + 1);
  else if (S.path.length && v.parent === S.path.at(-1).id) S.path = [...S.path, { id: v.id, name: v.name, driveId: v.driveId }];
  else {
    S.path = v.id === 'root' ? [{ id: 'root', name: 'Mon Drive' }] : [{ id: v.id, name: v.name || '…', driveId: v.driveId }];
    if (v.id !== 'root') api.drivePath(v.id).then((p) => { if (S.view === v) { S.path = p; paintCrumbs(); } }).catch(() => {});
  }
  paintCrumbs();
}
function paintCrumbs() {
  $('#crumbs').innerHTML = S.view.kind === 'folder'
    ? S.path.map((p, i) => `${i ? '<i>/</i>' : ''}<button data-id="${esc(p.id)}" data-drive="${esc(p.driveId || '')}">${esc(p.name)}</button>`).join('')
    : `<button>${esc(viewTitle(S.view))}</button>`;
  $('#title').textContent = viewTitle(S.view);
  document.title = viewTitle(S.view) + ' · Tiroir';
}
$('#crumbs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-id]'); if (!b || b.dataset.id === S.view.id) return;
  go({ kind: 'folder', id: b.dataset.id, name: b.textContent, driveId: b.dataset.drive || undefined });
});
function goUp() { if (S.view.kind === 'folder' && S.path.length > 1) { const p = S.path.at(-2); go({ kind: 'folder', id: p.id, name: p.name, driveId: p.driveId }); } }
function back() { const h = S.hist.pop(); if (!h) return; S.fwd.push({ view: S.view, path: S.path }); const f = S.fwd; S.path = h.path; go(h.view, { push: false }); S.fwd = f; $('#fwd').disabled = !S.fwd.length; }
function fwd() { const h = S.fwd.pop(); if (!h) return; S.hist.push({ view: S.view, path: S.path }); const f = S.fwd; S.path = h.path; go(h.view, { push: false }); S.fwd = f; $('#fwd').disabled = !S.fwd.length; }
$('#back').onclick = back; $('#fwd').onclick = fwd;

$('.side').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-view]'); if (!a) return;
  const [k, arg] = a.dataset.view.split(':');
  if (k === 'folder') go({ kind: 'folder', id: arg });
  else if (k === 'drive') go({ kind: 'folder', id: arg, name: a.textContent, driveId: arg });
  else if (k === 'type') go({ kind: 'type', type: arg });
  else go({ kind: k });
});

// ---------- loading (cache first, refresh behind) ----------
async function load({ keepScroll = false, placeholder } = {}) {
  const seq = ++S.seq; const key = vkey(S.view);
  const top = $('#scroller').scrollTop;
  S.error = null;
  // An empty list is never trusted as a cache: Drive answers heavy searches with empty pages first.
  let hit = cache.get(key)?.length ? cache.get(key) : placeholder;
  try {
    if (!hit) { const d = await idb.get(diskKey(key)); if (seq !== S.seq) return; if (d?.length) { hit = d; cache.set(key, d); } }
    S.loading = true; S.found = 0;
    setFiles(hit || []);
    if (keepScroll) $('#scroller').scrollTop = top;
    let all = []; let next; let shown = hit; let pages = 0;
    do {
      const r = await api.driveList(withMine(S.view), next, next || hit ? 1000 : 200); // nothing to show yet: a small first page arrives sooner
      if (seq !== S.seq) return;
      all = all.concat(r.files); next = r.next; pages++;
      S.found = all.length; S.pages = pages;
      // nothing on screen yet: show the first page at once, then refresh only every few pages (each refresh re-sorts the grid)
      if (!hit && (pages === 1 || !shown?.length || pages % 4 === 0)) { setFiles(all); shown = all; } else head(); // head() shows the progress while Drive keeps searching
    } while (next);
    remember(key, all);
    S.loading = false;
    if (shown === all || sameList(shown, all)) { head(); empty(); if (S.entering) pageIn(); } // nothing changed: keep the tiles (no flicker, no image reload)
    else setFiles(all);
  } catch (e) {
    api.clientLog(`vue ${key} : ${e?.stack || cleanErr(e)}`).catch(() => {});
    if (seq === S.seq) { S.loading = false; S.error = cleanErr(e); try { head(); empty(); } catch {} pageIn(); fail(e); }
  }
}
// Any display error lands in %APPDATA%\Tiroir\tiroir.log (the app window has no developer tools).
addEventListener('error', (e) => { if (e.message) api.clientLog(`${e.message} @ ${e.filename?.split('/').pop()}:${e.lineno}`).catch(() => {}); });
addEventListener('unhandledrejection', (e) => api.clientLog('promesse : ' + (e.reason?.stack || e.reason)).catch(() => {}));
function refresh() { cache.clear(); if (isSvc(S.view)) return; load({ keepScroll: true, placeholder: S.files }); }

function setFiles(files) {
  S.files = files;
  const { key, dir } = S.sort;
  const val = { name: (f) => f.name, modifiedTime: (f) => f.modifiedTime || '', size: (f) => Number(f.size || 0) }[key];
  const cmp = key === 'size' ? (a, b) => (val(a) - val(b)) * dir || coll.compare(a.name, b.name) : (a, b) => coll.compare(val(a), val(b)) * dir;
  const keepOrder = S.view.kind === 'recent' && key === 'name' && dir === 1;
  const shown = S.filter === 'all' ? files : files.filter((f) => chipOf(f) === S.filter);
  const folders = shown.filter(isFolder); let rest = shown.filter((f) => !isFolder(f));
  if (!keepOrder) { folders.sort(key === 'size' ? (a, b) => coll.compare(a.name, b.name) : cmp); rest.sort(cmp); }
  if (S.view.kind === 'folder' && !store.get('modes', {})[modeKey(S.view)] && rest.length >= 6 && rest.filter(isMedia).length / rest.length > 0.7) S.mode = 'gallery';
  if (S.mode === 'gallery') rest = rest.filter(isMedia).concat(rest.filter((f) => !isMedia(f)));
  S.sorted = folders.concat(rest); S.nFolders = folders.length;
  const ids = new Set(S.sorted.map((f) => f.id));
  for (const id of S.sel) if (!ids.has(id)) S.sel.delete(id);
  layout(); empty(); head(); info(); selbar(); // tiles are only rebuilt when the mode or thumbnail size changes (see layout)
  if (S.entering) {
    if (S.files.length || !S.loading) pageIn();
    else { clearTimeout(S.enterT); S.enterT = setTimeout(() => { if (S.entering) pageIn(); }, 150); } // still searching: show the view and its loader, never a blank page
  }
}

function head() {
  const total = S.files.reduce((s, f) => s + Number(f.size || 0), 0);
  const nf_ = S.files.filter(isFolder).length;
  $('#meta').textContent = S.loading && !S.files.length ? (S.pages > 1 ? `Google Drive cherche… (${S.pages} pages parcourues)` : 'chargement…')
    : `${plural(S.files.length - nf_, 'fichier')}${nf_ ? ' · ' + plural(nf_, 'dossier') : ''}${total ? ' · ' + bytes(total) : ''}${S.loading ? ' · chargement…' : ''}`;
  const counts = {}; for (const f of S.files) { const c = chipOf(f); counts[c] = (counts[c] || 0) + 1; }
  const chips = CHIPS.filter(([k]) => k === 'all' || counts[k]);
  $('#chips .cb').innerHTML = chips.length > 2 ? chips.map(([k, l]) => `<button data-f="${k}" class="${S.filter === k ? 'on' : ''}">${l}<span>${k === 'all' ? S.files.length : counts[k]}</span></button>`).join('') : '';
  gooTo(GOO.chips, $('#chips .on'));
  $('#mine').hidden = !MINE_KINDS.has(S.view.kind);
  $('#mine').classList.toggle('on', mineOn(S.view));
  $('#sort').value = `${S.sort.key}:${S.sort.dir}`;
  $$('#mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === S.mode));
  gooTo(GOO.mode, $('#mode .on'));
  $('#zoom').hidden = S.mode === 'list'; $('#zoom').value = S.zoom;
}
$('#chips').onclick = (e) => { const b = e.target.closest('[data-f]'); if (!b) return; S.filter = b.dataset.f; S.sel.clear(); $('#scroller').scrollTop = 0; setFiles(S.files); };
$('#mine').onclick = () => {
  store.set('onlyMine', !store.get('onlyMine', false));
  S.sel.clear(); $('#scroller').scrollTop = 0; load();
  toast(store.get('onlyMine') ? 'Seulement tes fichiers (ce que d’autres t’ont partagé est masqué)' : 'Tous les fichiers visibles par ton compte, partages compris');
};
$('#sort').onchange = (e) => { const [k, d] = e.target.value.split(':'); S.sort = { key: k, dir: Number(d) }; store.set('sort', S.sort); setFiles(S.files); };

$('#empty').addEventListener('click', (e) => { if (e.target.closest('#retryLoad')) load(); if (e.target.closest('#openLog')) api.showLog().catch(fail); });
function empty() {
  const el = $('#empty');
  if (S.sorted.length) { el.hidden = true; return; }
  if (S.loading) { el.hidden = false; el.innerHTML = '<div class="gload"><i></i><i></i><i></i></div>'; return; }
  el.hidden = false;
  el.innerHTML = S.error ? `${ic('CloudOff')}<b>Impossible de charger cette vue</b><span>${esc(S.error)}</span><span class="btns"><button class="btn" id="retryLoad">${ic('RotateCw')}Réessayer</button><button class="btn" id="openLog">${ic('FileText')}Journal</button></span>`
    : S.view.kind === 'search' ? `${ic('Search')}<b>Aucun résultat</b><span>Essaie un autre mot.</span>`
    : S.view.kind === 'trash' ? `${ic('Trash2')}<b>Corbeille vide</b>`
    : S.filter !== 'all' ? `${ic('Folder')}<b>Rien de ce type ici</b>`
    : S.view.kind === 'folder' ? `${ic('Upload')}<b>Dossier vide</b><span>Glisse des fichiers ici ou clique sur Importer.</span>` : `${ic('Folder')}<b>Rien ici pour l’instant</b>`;
}

// ---------- virtualized layout ----------
const scroller = $('#scroller'); const canvas = $('#canvas');
const pool = new Map();
let L = {};
const GAP = 12, PAD = 24, ROW = 38, CHIP = 48, CHIP_MIN = 220, NAME_H = 46;

function layout() {
  const W = scroller.clientWidth - PAD * 2;
  scroller.querySelector('.lhead')?.remove();
  if (S.mode === 'list') {
    scroller.insertAdjacentHTML('afterbegin', '<div class="lhead"><span>Nom</span><span>Modifié</span><span>Taille</span><span>Type</span></div>');
    L = { list: true, height: S.sorted.length * ROW + 80 };
  } else {
    const fc = Math.max(1, Math.floor((W + GAP) / (CHIP_MIN + GAP)));
    const fw = (W - GAP * (fc - 1)) / fc;
    const fr = Math.ceil(S.nFolders / fc);
    const filesTop = 4 + (fr ? fr * (CHIP + GAP) + 14 : 0);
    const cols = Math.max(1, Math.floor((W + GAP) / (S.zoom + GAP)));
    const tw = (W - GAP * (cols - 1)) / cols;
    const th = Math.round(tw * 0.78 + NAME_H);
    const n = S.sorted.length - S.nFolders;
    L = { fc, fw, cols, tw, th, filesTop, height: filesTop + Math.ceil(n / cols) * (th + GAP) + 90, thumb: [240, 400, 640, 960].find((s) => s >= tw * devicePixelRatio) || 960 };
    if (S.mode === 'gallery') {
      // Justified rows: each photo keeps its real proportions and rows fill the width.
      const H = S.zoom * 1.2; const items = S.sorted.slice(S.nFolders); const P = new Array(items.length);
      let y = filesTop, start = 0, sum = 0;
      for (let j = 0; j < items.length; j++) {
        sum += aspect(items[j]);
        const w = sum * H + GAP * (j - start);
        if (w >= W || j === items.length - 1) {
          const h = w >= W ? (W - GAP * (j - start)) / sum : H;
          let x = PAD;
          for (let k = start; k <= j; k++) { const wk = aspect(items[k]) * h; P[k] = { x, y, w: wk, h }; x += wk + GAP; }
          y += h + GAP; start = j + 1; sum = 0;
        }
      }
      L.gallery = P; L.height = y + 90;
      L.thumb = [400, 640, 960].find((s) => s >= H * 1.7 * devicePixelRatio) || 960;
    }
  }
  canvas.style.height = L.height + 'px';
  const sig = `${S.mode}|${L.thumb}`;
  if (sig !== layout.sig) { layout.sig = sig; for (const el of pool.values()) el.remove(); pool.clear(); }
  paint();
}

function pos(i) {
  if (L.list) return { x: 0, y: 4 + i * ROW };
  if (i < S.nFolders) return { x: PAD + (i % L.fc) * (L.fw + GAP), y: 4 + Math.floor(i / L.fc) * (CHIP + GAP), w: L.fw, h: CHIP };
  const j = i - S.nFolders;
  if (L.gallery) return L.gallery[j];
  return { x: PAD + (j % L.cols) * (L.tw + GAP), y: L.filesTop + Math.floor(j / L.cols) * (L.th + GAP), w: L.tw, h: L.th };
}

function visibleRange() {
  const off = L.list ? 30 : 0;
  const top = scroller.scrollTop - 400 - off, bot = scroller.scrollTop + scroller.clientHeight + 400;
  if (L.list) return [[Math.max(0, Math.floor(top / ROW)), Math.min(S.sorted.length, Math.ceil(bot / ROW))]];
  const r = [];
  const fRows = [Math.max(0, Math.floor(top / (CHIP + GAP))), Math.ceil(bot / (CHIP + GAP))];
  r.push([Math.min(S.nFolders, fRows[0] * L.fc), Math.min(S.nFolders, fRows[1] * L.fc)]);
  if (L.gallery) {
    const P = L.gallery; let lo = 0, hi = P.length;
    while (lo < hi) { const m = (lo + hi) >> 1; P[m].y + P[m].h < top ? (lo = m + 1) : (hi = m); }
    let end = lo; while (end < P.length && P[end].y <= bot) end++;
    r.push([S.nFolders + lo, S.nFolders + end]);
    return r;
  }
  const rows = [Math.max(0, Math.floor((top - L.filesTop) / (L.th + GAP))), Math.max(0, Math.ceil((bot - L.filesTop) / (L.th + GAP)))];
  const n = S.sorted.length - S.nFolders;
  r.push([S.nFolders + Math.min(n, rows[0] * L.cols), S.nFolders + Math.min(n, rows[1] * L.cols)]);
  return r;
}

let raf = 0;
scroller.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(); }); }, { passive: true });
new ResizeObserver(() => layout()).observe(scroller);

// A tile is reused as long as what it shows is unchanged: list updates (new Drive pages, refresh) move tiles
// instead of rebuilding them, so thumbnails don't reload and the grid doesn't flash.
const tileKey = (f) => `${f.id}|${f.modifiedTime || ''}|${f.name}|${f.starred ? 1 : 0}|${f.size || ''}`;
function paint() {
  const want = new Set();
  for (const [a, b] of visibleRange()) {
    for (let i = a; i < b; i++) {
      const f = S.sorted[i]; const key = tileKey(f); want.add(key);
      let el = pool.get(key);
      if (!el) { el = L.list ? buildRow(f) : buildTile(f, i < S.nFolders); el.dataset.k = key; pool.set(key, el); }
      el.dataset.i = i;
      const p = pos(i);
      el.style.transform = `translate(${p.x}px, ${p.y}px)`;
      if (p.w) { el.style.width = p.w + 'px'; el.style.height = p.h + 'px'; }
      el.classList.toggle('sel', S.sel.has(f.id));
      el.classList.toggle('cut', S.clip?.mode === 'cut' && S.clip.ids.has(f.id));
      if (!el.isConnected) { el.style.setProperty('--n', Math.min(want.size, 30)); canvas.append(el); }
    }
  }
  for (const [, el] of pool) if (!want.has(el.dataset.k) && el.isConnected) { if (el === hoverEl) stopHover(); el.remove(); }
  if (pool.size > 3000) for (const [k, el] of pool) if (!el.isConnected) pool.delete(k);
}

function buildTile(f, folder) {
  const el = document.createElement('div');
  const k = kind(f);
  el.className = 'tile' + (folder ? ' folder' : '') + (L.gallery && !folder ? ' gal' : '');
  el.dataset.id = f.id; el.draggable = true;
  if (folder) { el.innerHTML = `<div class="th"><span class="ico">${ic(f.mimeType === FOLDER ? 'Folder' : 'Link')}</span><span class="fn">${esc(f.name)}</span></div>`; return el; }
  const tag = GAPPS[f.mimeType] ? `<span class="gt" style="background:${GAPPS[f.mimeType][2]}"></span>` : '';
  const badge = k === 'video' ? `<span class="badge">${ic('Play')}${f.videoMediaMetadata?.durationMillis ? dur(f.videoMediaMetadata.durationMillis) : 'Vidéo'}</span>` : '';
  el.innerHTML = `<div class="th${isMedia(f) ? '' : ' fit'}"><span class="ico">${ic(KIND_ICON[k])}<span class="ext">${esc((f.fileExtension || '').slice(0, 5))}</span></span>${
    hasThumb(f) ? `<img decoding="async" draggable="false" alt="" src="${thumbUrl(f, L.thumb)}">` : ''}${badge}${f.starred ? `<span class="star">${ic('Star')}</span>` : ''}${
    L.gallery ? `<span class="cap">${esc(f.name)}</span>` : ''}</div>${
    L.gallery ? '' : `<div class="nm">${tag}${esc(f.name)}</div><div class="sub">${esc(f.size ? bytes(f.size) + ' · ' : '')}${when(f.modifiedTime)}</div>`}`;
  const img = el.querySelector('img');
  if (img) { img.onload = () => img.classList.add('ok'); img.onerror = () => img.remove(); }
  return el;
}

function buildRow(f) {
  const el = document.createElement('div');
  const k = kind(f);
  el.className = 'row'; el.dataset.id = f.id; el.draggable = true;
  const lead = hasThumb(f) && isMedia(f) ? `<img class="mini" decoding="async" draggable="false" alt="" src="${thumbUrl(f, 240)}">`
    : GAPPS[f.mimeType] ? `<span class="gt" style="background:${GAPPS[f.mimeType][2]};width:10px;height:10px;border-radius:2px;margin:0 8px"></span>` : ic(KIND_ICON[k]);
  el.innerHTML = `<span>${lead}<span style="overflow:hidden;text-overflow:ellipsis">${esc(f.name)}</span>${f.starred ? `<span style="color:#f4f4f5;display:flex">${ic('Star')}</span>` : ''}</span><span class="m">${when(f.modifiedTime)}</span><span class="m">${isFolder(f) ? '—' : bytes(f.size)}</span><span>${esc(typeLabel(f))}</span>`;
  const img = el.querySelector('img.mini'); if (img) img.onerror = () => img.replaceWith(document.createRange().createContextualFragment(ic(KIND_ICON[k])));
  return el;
}

function repaintSel() { for (const el of pool.values()) { el.classList.toggle('sel', S.sel.has(el.dataset.id)); el.classList.toggle('cut', S.clip?.mode === 'cut' && S.clip.ids.has(el.dataset.id)); } info(); selbar(); }
function scrollTo(i) {
  const p = pos(i); const h = L.list ? ROW : p.h; const off = L.list ? 30 : 0;
  if (p.y + off < scroller.scrollTop) scroller.scrollTop = p.y - 8;
  else if (p.y + h + off > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = p.y + h + off - scroller.clientHeight + 8;
}

$('#mode').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  S.mode = b.dataset.mode;
  const m = store.get('modes', {}); m[modeKey(S.view)] = S.mode; store.set('modes', m); store.set('mode', S.mode);
  setFiles(S.files);
};
$('#zoom').oninput = (e) => { S.zoom = Number(e.target.value); store.set('zoom', S.zoom); layout(); };

// ---------- selection & opening ----------
const itemAt = (t) => t.closest?.('.tile, .row');
let downOn = null;
canvas.addEventListener('mousedown', (e) => {
  const it = itemAt(e.target);
  if (!it) { if (e.button === 0 && !e.ctrlKey && !e.shiftKey) { S.sel.clear(); S.anchor = S.focus = -1; repaintSel(); } return; }
  const i = +it.dataset.i;
  if (e.button === 2) { if (!S.sel.has(it.dataset.id)) select(i, {}); return; }
  if (e.shiftKey || e.ctrlKey || e.metaKey || !S.sel.has(it.dataset.id)) select(i, e);
  else downOn = i; // already selected: wait for mouseup so a drag keeps the whole selection
});
canvas.addEventListener('mouseup', (e) => { if (downOn !== null && e.button === 0) select(downOn, {}); downOn = null; });
scroller.addEventListener('mousedown', (e) => { if (e.target === scroller || e.target === canvas) { S.sel.clear(); repaintSel(); } });

function select(i, e) {
  const f = S.sorted[i]; if (!f) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.shiftKey && S.anchor >= 0) {
    if (!ctrl) S.sel.clear();
    const [a, b] = [Math.min(S.anchor, i), Math.max(S.anchor, i)];
    for (let k = a; k <= b; k++) S.sel.add(S.sorted[k].id);
  } else if (ctrl) { S.sel.has(f.id) ? S.sel.delete(f.id) : S.sel.add(f.id); S.anchor = i; }
  else { S.sel = new Set([f.id]); S.anchor = i; }
  S.focus = i; repaintSel();
}

canvas.addEventListener('dblclick', (e) => { const it = itemAt(e.target); if (it) open(byId(it.dataset.id)); });

function open(f) {
  if (!f) return;
  if (isFolder(f)) return go({ kind: 'folder', id: folderId(f), name: f.name, parent: S.view.kind === 'folder' ? S.view.id : undefined, driveId: f.driveId });
  if (f.mimeType === 'application/vnd.google-apps.shortcut') f = { ...f, id: f.shortcutDetails.targetId, mimeType: f.shortcutDetails.targetMimeType };
  if (previewable(f)) return viewer(f);
  openLocal(f);
}
function openLocal(f) {
  const name = f?.name || byId(f?.id)?.name;
  if (!f?.id) return;
  toast(name ? `Ouverture de « ${name} »…` : 'Ouverture du fichier…', 1800);
  api.driveOpenLocal({ id: f.id }).then((r) => { if (r?.revealed) toast('Fichier exécutable : par sécurité, Tiroir l’affiche dans son dossier au lieu de le lancer.', 6000); }).catch(fail);
}

// Video tiles play a muted preview while hovered.
let hoverT = 0, hoverEl = null;
canvas.addEventListener('mouseover', (e) => {
  const it = e.target.closest('.tile'); if (it === hoverEl) return;
  stopHover(); if (!it) return;
  const f = byId(it.dataset.id); if (!f || kind(f) !== 'video') return;
  hoverEl = it;
  hoverT = setTimeout(() => {
    const v = document.createElement('video');
    Object.assign(v, { muted: true, autoplay: true, loop: true, playsInline: true, className: 'hov', src: mediaUrl(f) });
    v.onerror = () => v.remove();
    $('.th', it)?.append(v);
  }, 450);
});
canvas.addEventListener('mouseleave', stopHover);
function stopHover() { clearTimeout(hoverT); hoverEl?.querySelector('video.hov')?.remove(); hoverEl = null; }

// ---------- drag & drop ----------
// Inside Tiroir: drop on a folder to move (Ctrl = copy). Outside (Explorer, Discord…): Chromium's DownloadURL hands over the file.
canvas.addEventListener('dragstart', (e) => {
  const it = itemAt(e.target); if (!it) return;
  if (!S.sel.has(it.dataset.id)) select(+it.dataset.i, {});
  downOn = null; stopHover();
  const files = selected();
  S.dragIds = files.map((f) => f.id);
  e.dataTransfer.effectAllowed = 'copyMove';
  e.dataTransfer.setData('application/x-tiroir', JSON.stringify(S.dragIds));
  const f = files.find((x) => !isFolder(x) && downloadable(x));
  if (f) e.dataTransfer.setData('DownloadURL', `${GAPPS[f.mimeType]?.[4] || f.mimeType}:${localName(f)}:${dlUrl(f)}`);
  const ghost = document.createElement('div');
  ghost.className = 'btn primary'; ghost.style.cssText = 'position:fixed;top:-100px;left:0';
  ghost.textContent = files.length === 1 ? files[0].name : `${files.length} éléments`;
  document.body.append(ghost); e.dataTransfer.setDragImage(ghost, 12, 16); setTimeout(() => ghost.remove());
});
canvas.addEventListener('dragend', () => { S.dragIds = null; clearDrop(); });

function dropTarget(el) {
  if (!el?.closest) return null;
  const it = el.closest('.tile, .row');
  if (it) { const f = byId(it.dataset.id); return f && isFolder(f) ? { el: it, id: folderId(f), name: f.name } : null; }
  const s = el.closest('.side a[data-view^="folder:"], .side a[data-view^="drive:"]');
  if (s) return { el: s, id: s.dataset.view.split(':')[1], name: s.textContent };
  const c = el.closest('#crumbs button[data-id]');
  if (c && c.dataset.id !== S.view.id) return { el: c, id: c.dataset.id, name: c.textContent };
  return null;
}
const clearDrop = () => $$('.drop').forEach((x) => x.classList.remove('drop'));
const isInternal = (e) => [...e.dataTransfer.types].includes('application/x-tiroir');
const isExternal = (e) => !isInternal(e) && [...e.dataTransfer.types].includes('Files');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (isExternal(e)) { dragDepth++; $('#dropzone').hidden = false; } });
window.addEventListener('dragleave', (e) => { if (isExternal(e) && --dragDepth <= 0) { dragDepth = 0; $('#dropzone').hidden = true; clearDrop(); } });
window.addEventListener('dragover', (e) => {
  const internal = isInternal(e), external = isExternal(e);
  if (!internal && !external) return;
  const t = dropTarget(e.target);
  clearDrop();
  if (internal) {
    if (!t || S.dragIds?.includes(t.id)) { e.dataTransfer.dropEffect = 'none'; return; }
    e.preventDefault(); e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move'; t.el.classList.add('drop'); return;
  }
  e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; t?.el.classList.add('drop');
  $('#dropLabel').textContent = `Envoyer dans « ${t ? t.name : S.view.kind === 'folder' ? viewTitle(S.view) : 'Mon Drive'} »`;
});
window.addEventListener('drop', async (e) => {
  const internal = isInternal(e), external = isExternal(e);
  if (!internal && !external) return;
  e.preventDefault(); dragDepth = 0; $('#dropzone').hidden = true;
  const t = dropTarget(e.target); clearDrop();
  if (internal) {
    const ids = JSON.parse(e.dataTransfer.getData('application/x-tiroir') || '[]');
    const files = ids.map(byId).filter(Boolean);
    if (t && files.length && !ids.includes(t.id)) (e.ctrlKey ? copyTo : moveTo)(files, t.id, t.name);
    return;
  }
  uploadItems(await collectDropped(e.dataTransfer), t ? t.id : currentFolder());
});

async function collectDropped(dt) {
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) { const file = await new Promise((r, j) => entry.file(r, j)); out.push({ file, path: prefix + file.name }); return; }
    const reader = entry.createReader();
    for (;;) { const batch = await new Promise((r, j) => reader.readEntries(r, j)); if (!batch.length) break; for (const c of batch) await walk(c, prefix + entry.name + '/'); }
  };
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) for (const en of entries) await walk(en, '');
  else for (const file of dt.files) out.push({ file, path: file.name });
  return out;
}

// ---------- uploads (browser → local server → Drive), with progress ----------
let upSeq = 0;
async function uploadItems(items, parent) {
  if (!items.length) return;
  const id = 'u' + ++upSeq; const batch = crypto.randomUUID();
  const total = items.reduce((s, x) => s + x.file.size, 0);
  const j = { id, label: items.length === 1 ? 'Envoi · ' + items[0].file.name : `Envoi · ${items.length} fichiers`, total, done: 0, state: 'run' };
  const loaded = new Array(items.length).fill(0);
  const tick = () => { j.done = loaded.reduce((a, b) => a + b, 0); setJob(j); };
  setJob(j);
  let next = 0; let error = null;
  const worker = async () => {
    while (next < items.length && !error) {
      const k = next++; const { file, path } = items[k];
      try {
        await new Promise((res, rej) => {
          const x = new XMLHttpRequest();
          x.open('POST', `/upload?parent=${encodeURIComponent(parent)}&batch=${batch}&path=${encodeURIComponent(path)}`);
          x.setRequestHeader('x-tiroir', '1');
          x.upload.onprogress = (ev) => { loaded[k] = ev.loaded; tick(); };
          x.onload = () => (x.status < 300 ? res() : rej(new Error(JSON.parse(x.responseText || '{}').error || 'Envoi refusé')));
          x.onerror = () => rej(new Error('Connexion perdue'));
          x.send(file);
        });
        loaded[k] = file.size; tick();
      } catch (e) { error = e; }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  j.state = error ? 'err' : 'ok'; j.error = error?.message; setJob(j);
  if (error) toast('Envoi interrompu : ' + error.message); else toast(items.length === 1 ? `« ${items[0].file.name} » envoyé` : `${items.length} fichiers envoyés`);
  refresh();
}
function pickUpload(dirs) { const inp = dirs ? $('#dirPick') : $('#filePick'); inp.value = ''; inp.click(); }
$('#filePick').onchange = (e) => uploadItems([...e.target.files].map((file) => ({ file, path: file.name })), currentFolder());
$('#dirPick').onchange = (e) => uploadItems([...e.target.files].map((file) => ({ file, path: file.webkitRelativePath || file.name })), currentFolder());
$('#importBtn').onclick = (e) => menu(e.clientX, e.clientY + 10, [
  { label: 'Importer des fichiers', icon: 'Upload', kbd: 'Ctrl+U', run: () => pickUpload(false) },
  { label: 'Importer un dossier', icon: 'FolderInput', run: () => pickUpload(true) },
  '-', { label: 'Nouveau dossier', icon: 'FolderPlus', kbd: 'Ctrl+Maj+N', run: newFolder },
]);

// ---------- viewer ----------
const NATIVE_IMG = /^image\/(jpeg|png|gif|webp|bmp|avif|x-icon)$/;
function previewable(f) { const k = kind(f); return ['image', 'video', 'audio', 'pdf'].includes(k) || (GAPPS[f.mimeType] && k !== 'form') || (k === 'code' && Number(f.size) < 3e6) || f.mimeType === 'text/plain'; }
let V = null;
function viewer(f) {
  const list = S.sorted.filter((x) => !isFolder(x) && previewable(x));
  V = { list: list.length ? list : [f], i: Math.max(0, list.findIndex((x) => x.id === f.id)) };
  showV();
}
function showV() {
  const f = V.list[V.i]; const k = kind(f); const el = $('#viewer'); const m = mediaUrl(f);
  let stage;
  if (k === 'image' && NATIVE_IMG.test(f.mimeType)) stage = `<span class="loading">chargement…</span><img src="${m}" alt="" draggable="false">`;
  else if (k === 'image') stage = `<img src="${thumbUrl(f, 1600)}" alt="" draggable="false">`;
  else if (k === 'video') stage = `<video src="${m}" ${hasThumb(f) ? `poster="${thumbUrl(f, 960)}"` : ''} controls autoplay></video>`;
  else if (k === 'audio') stage = `<div class="nomedia">${ic('Music')}<b>${esc(f.name)}</b><audio src="${m}" controls autoplay></audio></div>`;
  else if (k === 'pdf' || GAPPS[f.mimeType]) stage = `<iframe src="/pdf/${encodeURIComponent(f.id)}"></iframe>`;
  else stage = `<pre>chargement…</pre>`;
  el.innerHTML = `<div class="vbar"><button class="ib" data-a="close" title="Fermer (Échap)">${ic('X')}</button><b>${esc(f.name)}</b><span>${V.i + 1} / ${V.list.length} · ${bytes(f.size)}</span>
    <button class="ib" data-a="dl" title="Télécharger">${ic('Download')}</button><button class="ib" data-a="local" title="Ouvrir avec l'application">${ic('Monitor')}</button><button class="ib" data-a="web" title="Ouvrir dans Google Drive">${ic('ExternalLink')}</button></div>
    <div class="stage">${stage}${V.list.length > 1 ? `<button class="nav prev" data-a="prev" title="Précédent (←)">${ic('ChevronLeft')}</button><button class="nav next" data-a="next" title="Suivant (→)">${ic('ChevronRight')}</button>` : ''}</div>
    <div class="strip">${V.list.map((x, j) => Math.abs(j - V.i) > 40 ? '' : `<button data-j="${j}" class="${j === V.i ? 'on' : ''}" title="${esc(x.name)}">${ic(KIND_ICON[kind(x)])}${hasThumb(x) ? `<img src="${thumbUrl(x, 240)}" alt="" draggable="false" data-drop>` : ''}</button>`).join('')}</div>`;
  el.hidden = false;
  $('.strip .on', el)?.scrollIntoView({ inline: 'center', block: 'nearest' });
  const img = $('.stage > img', el);
  if (img) { img.onload = () => $('.loading', el)?.remove(); img.onerror = () => { $('.loading', el)?.remove(); if (hasThumb(f) && !img.dataset.fb) { img.dataset.fb = 1; img.src = thumbUrl(f, 1600); } }; }
  const vid = $('video', el);
  if (vid) vid.onerror = async () => {
    vid.remove();
    // Drive refusing the file and a codec the player lacks (HEVC .mov from a phone, .mkv, .avi…) look the same to <video>: ask the server which it is.
    const probe = await fetch(m, { headers: { Range: 'bytes=0-0' } }).catch(() => null);
    if (V?.list[V.i] !== f) return;
    const why = !probe?.ok ? `Google Drive n'a pas envoyé la vidéo (${probe ? 'erreur ' + probe.status : 'pas de connexion'}).`
      : `Ce format vidéo (${esc((f.fileExtension || f.mimeType.split('/')[1] || '?').toUpperCase())}) ne se lit pas dans Tiroir.`;
    $('.stage', el)?.insertAdjacentHTML('afterbegin', `<div class="nomedia">${hasThumb(f) ? `<img src="${thumbUrl(f, 960)}" alt="">` : ''}<span>${why}</span>
      <span class="btns"><button class="btn" data-a="web">${ic('ExternalLink')}Lire dans Google Drive</button><button class="btn" data-a="local">${ic('Monitor')}Ouvrir avec l'application</button>${!probe?.ok ? `<button class="btn" data-a="retry">${ic('RotateCw')}Réessayer</button>` : ''}</span></div>`);
  };
  const pre = $('pre', el);
  if (pre) fetch(m).then((r) => r.text()).then((t) => { pre.textContent = t.slice(0, 500_000); }).catch(() => { pre.textContent = 'Lecture impossible.'; });
  for (const d of [-1, 1]) { const n = V.list[V.i + d]; if (n && kind(n) === 'image') new Image().src = NATIVE_IMG.test(n.mimeType) ? mediaUrl(n) : thumbUrl(n, 1600); }
}
function closeV() { $('#viewer').hidden = true; $('#viewer').innerHTML = ''; V = null; scroller.focus(); }
function stepV(d) { if (!V) return; V.i = (V.i + d + V.list.length) % V.list.length; showV(); const idx = S.sorted.findIndex((x) => x.id === V.list[V.i].id); if (idx >= 0) { S.sel = new Set([S.sorted[idx].id]); S.focus = S.anchor = idx; repaintSel(); scrollTo(idx); } }
$('#viewer').addEventListener('click', (e) => {
  const j = e.target.closest('[data-j]')?.dataset.j;
  if (j !== undefined) return stepV(+j - V.i);
  if (e.target.matches('.stage > img')) return e.target.parentElement.classList.toggle('zoom');
  const a = e.target.closest('[data-a]')?.dataset.a; const f = V?.list[V.i];
  if (a === 'close') closeV();
  else if (a === 'prev' || a === 'next') stepV(a === 'prev' ? -1 : 1);
  else if (a === 'dl') download([f]);
  else if (a === 'local') openLocal(f);
  else if (a === 'web') openWeb(f);
  else if (a === 'retry') showV();
  else if (e.target.classList.contains('stage')) closeV();
});

// ---------- actions ----------
async function act(p, ok) { try { const r = await p; if (ok) toast(ok); refresh(); return r; } catch (e) { fail(e); refresh(); } }
const moveTo = (files, to, name) => act(api.driveMove(files.map(({ id }) => ({ id })), to), `${plural(files.length, 'élément')} déplacé${files.length > 1 ? 's' : ''} vers « ${name} »`);
const copyTo = (files, to, name) => act(api.driveCopy(files.map(({ id, mimeType, name: n }) => ({ id, mimeType, name: n })), to), `${plural(files.length, 'élément')} copié${files.length > 1 ? 's' : ''} vers « ${name} »`);
const openWeb = (f) => f?.webViewLink && openOut(f.webViewLink);
function download(files) {
  files = files.filter(downloadable);
  if (!files.length) return toast('Ce type de fichier Google ne se télécharge pas.');
  if (files.length === 1 && !isFolder(files[0])) { const a = document.createElement('a'); a.href = dlUrl(files[0]); a.download = ''; a.click(); return; }
  toast('Téléchargement vers ton dossier Téléchargements…');
  api.driveDownload(files.map(({ id }) => ({ id }))).catch(fail);
}
async function trash(files) {
  if (!files.length) return;
  if (S.view.kind === 'trash') {
    if (!(await confirmBox(`Supprimer définitivement ${plural(files.length, 'élément')} ?`, 'Ils ne pourront pas être récupérés.', 'Supprimer'))) return;
    return act(api.driveDelete(files.map(({ id }) => ({ id }))), 'Supprimé définitivement');
  }
  act(api.driveTrash(files.map(({ id }) => ({ id }))), files.length === 1 ? `« ${files[0].name} » mis à la corbeille` : `${files.length} éléments mis à la corbeille`);
}
async function rename(f) { const n = await ask('Renommer', f.name, true); if (n && n !== f.name) act(api.driveRename(f.id, n), 'Renommé'); }
async function newFolder() { const n = await ask('Nouveau dossier', 'Nouveau dossier'); if (n) act(api.driveMkdir(n, currentFolder()), `Dossier « ${n} » créé`); }
function setClip(mode) { const files = selected(); if (!files.length) return; S.clip = { mode, files, ids: new Set(files.map((f) => f.id)) }; repaintSel(); toast(`${plural(files.length, 'élément')} ${mode === 'cut' ? 'coupé' : 'copié'}${files.length > 1 ? 's' : ''} · Ctrl+V pour coller`); }
function paste() {
  if (!S.clip) return;
  if (S.view.kind !== 'folder') return toast('Ouvre un dossier pour coller.');
  const { mode, files } = S.clip;
  if (mode === 'cut') { S.clip = null; moveTo(files, currentFolder(), viewTitle(S.view)); } else copyTo(files, currentFolder(), viewTitle(S.view));
}
const star = (files, v) => act(api.driveStar(files.map(({ id }) => ({ id })), v), v ? 'Ajouté aux favoris' : 'Retiré des favoris');
const copyLink = (f) => navigator.clipboard.writeText(f.webViewLink).then(() => toast('Lien copié'), () => toast('Copie impossible'));
async function moveOrCopyDialog(kind_) {
  const files = selected(); if (!files.length) return;
  const t = await pickFolder(kind_ === 'move' ? 'Déplacer vers…' : 'Copier vers…', kind_ === 'move' ? 'Déplacer ici' : 'Copier ici', new Set(files.map((f) => f.id)));
  if (t) (kind_ === 'move' ? moveTo : copyTo)(files, t.id, t.name);
}

// ---------- selection bar ----------
function selbar() {
  const bar = $('#selbar'); const files = selected();
  if (!files.length) { bar.hidden = true; return; }
  const one = files.length === 1 ? files[0] : null;
  const b = (a, icon, label, cls = '') => `<button class="${cls}" data-a="${a}" title="${label}">${ic(icon)}<span>${label}</span></button>`;
  bar.hidden = false;
  bar.innerHTML = `<button class="cnt" data-a="clear" title="Tout désélectionner (Échap)">${ic('X')}<span><b>${files.length}</b> sélectionné${files.length > 1 ? 's' : ''}</span></button><span class="sep"></span>` + (S.view.kind === 'trash'
    ? b('restore', 'RotateCcw', 'Restaurer', 'k') + b('trash', 'Trash2', 'Supprimer définitivement', 'k danger')
    : (one && isFolder(one) ? b('open', 'FolderOpen', 'Ouvrir', 'k') : one && previewable(one) ? b('open', 'Play', 'Aperçu', 'k') : '') +
      b('dl', 'Download', 'Télécharger', 'k') + b('move', 'FolderInput', 'Déplacer', 'k') + b('copy', 'CopyPlus', 'Copier') +
      (one ? b('ren', 'Pencil', 'Renommer') : '') + b('star', 'Star', files.every((f) => f.starred) ? 'Retirer des favoris' : 'Favori') + b('gem', 'Bot', 'Gemini') + b('trash', 'Trash2', 'Corbeille', 'danger'));
}
$('#selbar').addEventListener('click', (e) => {
  const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
  const files = selected();
  ({ clear: () => { S.sel.clear(); repaintSel(); }, open: () => open(files[0]), dl: () => download(files), move: () => moveOrCopyDialog('move'), copy: () => moveOrCopyDialog('copy'),
    ren: () => rename(files[0]), star: () => star(files, !files.every((f) => f.starred)), gem: () => askGemini(files), trash: () => trash(files),
    restore: () => act(api.driveRestore(files.map(({ id }) => ({ id }))), 'Restauré') })[a]?.();
});

// ---------- context menu ----------
function menu(x, y, items) {
  const m = $('#menu');
  m.innerHTML = items.map((it, i) => it === '-' ? '<hr>' : `<button data-k="${i}" class="${it.danger ? 'danger' : ''}">${ic(it.icon || 'File')}${esc(it.label)}${it.kbd ? `<kbd>${it.kbd}</kbd>` : ''}</button>`).join('');
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(6, Math.min(x, innerWidth - r.width - 6)) + 'px';
  m.style.top = Math.max(6, Math.min(y, innerHeight - r.height - 6)) + 'px';
  m.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; m.hidden = true; items[+b.dataset.k].run(); };
}
window.addEventListener('mousedown', (e) => { if (!e.target.closest('#menu') && !e.target.closest('#importBtn')) $('#menu').hidden = true; }, true);

scroller.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const it = itemAt(e.target); const files = it ? selected() : [];
  const one = files.length === 1 ? files[0] : null;
  if (!files.length) {
    const items = [];
    if (S.view.kind === 'folder') items.push({ label: 'Nouveau dossier', icon: 'FolderPlus', kbd: 'Ctrl+Maj+N', run: newFolder }, { label: 'Importer des fichiers', icon: 'Upload', kbd: 'Ctrl+U', run: () => pickUpload(false) }, { label: 'Importer un dossier', icon: 'FolderInput', run: () => pickUpload(true) });
    if (S.clip && S.view.kind === 'folder') items.push({ label: `Coller ${plural(S.clip.files.length, 'élément')}`, icon: 'Copy', kbd: 'Ctrl+V', run: paste });
    items.push({ label: 'Actualiser', icon: 'RefreshCw', kbd: 'F5', run: refresh });
    return menu(e.clientX, e.clientY, items);
  }
  if (S.view.kind === 'trash') return menu(e.clientX, e.clientY, [{ label: 'Restaurer', icon: 'RotateCcw', run: () => act(api.driveRestore(files.map(({ id }) => ({ id }))), 'Restauré') }, '-', { label: 'Supprimer définitivement', icon: 'Trash2', danger: true, run: () => trash(files) }]);
  const items = [];
  if (one) items.push({ label: isFolder(one) ? 'Ouvrir' : previewable(one) ? 'Aperçu' : 'Ouvrir', icon: isFolder(one) ? 'FolderOpen' : 'Play', kbd: 'Entrée', run: () => open(one) });
  if (one && !isFolder(one)) items.push({ label: "Ouvrir avec l'application", icon: 'Monitor', run: () => openLocal(one) });
  if (one?.webViewLink) items.push({ label: 'Ouvrir dans Google Drive', icon: 'ExternalLink', run: () => openWeb(one) });
  items.push('-', { label: 'Télécharger', icon: 'Download', kbd: 'Ctrl+S', run: () => download(files) },
    { label: 'Déplacer vers…', icon: 'FolderInput', kbd: 'Ctrl+Maj+M', run: () => moveOrCopyDialog('move') },
    { label: 'Copier vers…', icon: 'CopyPlus', run: () => moveOrCopyDialog('copy') },
    { label: 'Copier', icon: 'Copy', kbd: 'Ctrl+C', run: () => setClip('copy') },
    { label: 'Couper', icon: 'Scissors', kbd: 'Ctrl+X', run: () => setClip('cut') });
  if (one) items.push({ label: 'Renommer', icon: 'Pencil', kbd: 'F2', run: () => rename(one) });
  const allStar = files.every((f) => f.starred);
  items.push({ label: allStar ? 'Retirer des favoris' : 'Ajouter aux favoris', icon: 'Star', run: () => star(files, !allStar) });
  if (one?.webViewLink) items.push({ label: 'Copier le lien', icon: 'Link', run: () => copyLink(one) });
  items.push({ label: 'Demander à Gemini', icon: 'Bot', kbd: 'Ctrl+G', run: () => askGemini(files) }, '-', { label: 'Mettre à la corbeille', icon: 'Trash2', kbd: 'Suppr', danger: true, run: () => trash(files) });
  menu(e.clientX, e.clientY, items);
});

// ---------- keyboard ----------
let typed = '', typedAt = 0;
window.addEventListener('keydown', (e) => {
  const inField = e.target.matches('input, textarea, select');
  const k = e.key; const c = e.ctrlKey || e.metaKey;
  if (!$('#modal').hidden || $('.setup')) return;
  if (V) {
    if (k === 'Escape' || k === ' ') { e.preventDefault(); closeV(); }
    else if (k === 'ArrowLeft') stepV(-1); else if (k === 'ArrowRight') stepV(1);
    return;
  }
  if (c && k === 'l' && state?.lock?.enabled) { e.preventDefault(); api.lockNow().then(showLock).catch(fail); return; }
  if (c && (k === 'k' || k === 'f')) { e.preventDefault(); $('#q').focus(); $('#q').select(); return; }
  if (c && k === 'i') { e.preventDefault(); toggleDrawer('info'); return; }
  if (k === 'F5') { e.preventDefault(); if (isSvc(S.view)) { if (S.view.kind === 'tasks') SV.tasks.lists = null; svcRender(); } else refresh(); return; }
  if (inField) return;
  if (isSvc(S.view)) return; // file shortcuts (Suppr, Ctrl+A, arrows…) only act on the file views
  const files = selected(); const n = S.sorted.length;
  if (e.altKey && k === 'ArrowLeft') return back();
  if (e.altKey && k === 'ArrowRight') return fwd();
  if (k === 'Escape') { if (!$('#menu').hidden) { $('#menu').hidden = true; return; } if (!$('#drawer').hidden && !S.sel.size) return toggleDrawer(null); S.sel.clear(); repaintSel(); return; }
  if (k === 'Backspace') return goUp();
  if (k === 'Enter') { if (files.length === 1) open(files[0]); return; }
  if (k === ' ') { e.preventDefault(); const f = byId([...S.sel].pop()); if (f && !isFolder(f) && previewable(f)) viewer(f); return; }
  if (k === 'Delete') return trash(files);
  if (k === 'F2' && files.length === 1) return rename(files[0]);
  if (c && k === 'a') { e.preventDefault(); S.sel = new Set(S.sorted.map((f) => f.id)); repaintSel(); return; }
  if (c && k === 'c') return setClip('copy');
  if (c && k === 'x') return setClip('cut');
  if (c && k === 'v') return paste();
  if (c && k.toLowerCase() === 's') { e.preventDefault(); if (files.length) download(files); return; }
  if (c && e.shiftKey && k.toLowerCase() === 'n') { e.preventDefault(); return newFolder(); }
  if (c && e.shiftKey && k.toLowerCase() === 'm') { e.preventDefault(); return moveOrCopyDialog('move'); }
  if (c && k === 'u') { e.preventDefault(); return pickUpload(false); }
  if (c && k === 'g') { e.preventDefault(); return askGemini(files); }
  const arrows = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: 'up', ArrowDown: 'down' };
  if (k in arrows && n) {
    e.preventDefault();
    let i = S.focus < 0 ? 0 : S.focus; const d = arrows[k];
    if (L.list) i += d === 'up' ? -1 : d === 'down' ? 1 : 0;
    else if (typeof d === 'number') i += d;
    else if (L.gallery && i >= S.nFolders) { // nearest photo in the row above/below
      const p = pos(i); const cx = p.x + p.w / 2; const rowY = d === 'up' ? p.y - 1 : p.y + p.h + GAP + 1;
      let best = i, bd = Infinity;
      for (let j = S.nFolders; j < n; j++) { const q = pos(j); if (rowY >= q.y && rowY <= q.y + q.h + GAP) { const dd = Math.abs(q.x + q.w / 2 - cx); if (dd < bd) { bd = dd; best = j; } } }
      i = best === i && d === 'up' ? Math.max(0, S.nFolders - 1) : best;
    } else { const cols = i < S.nFolders ? L.fc : L.cols; i += d === 'up' ? -cols : cols; }
    i = Math.max(0, Math.min(n - 1, i));
    select(i, { shiftKey: e.shiftKey }); if (!e.shiftKey) S.anchor = i; scrollTo(i); return;
  }
  if (k.length === 1 && !c && !e.altKey) {
    const now = Date.now(); typed = now - typedAt > 800 ? k : typed + k; typedAt = now;
    const i = S.sorted.findIndex((f) => f.name.toLowerCase().startsWith(typed.toLowerCase()));
    if (i >= 0) { select(i, {}); scrollTo(i); }
  }
});
$('#q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && S.view.kind === 'gmail') { SV.mail.q = e.target.value.trim(); SV.mail.open = null; return mailView(); } // the search box searches Gmail while in Gmail
  if (e.key === 'Enter' && e.target.value.trim()) { go({ kind: 'search', text: e.target.value.trim() }); scroller.focus(); }
  if (e.key === 'Escape') { e.target.value = ''; if (S.view.kind === 'gmail' && SV.mail.q) { SV.mail.q = ''; mailView(); } if (S.view.kind === 'search') back(); scroller.focus(); }
});

// ---------- drawer: details + Gemini ----------
function toggleDrawer(tab) {
  const d = $('#drawer');
  const current = d.hidden ? null : $('.tabs .on').dataset.tab;
  if (!tab || current === tab) d.hidden = true; else { d.hidden = false; setTab(tab); }
  drawerBtns();
}
function drawerBtns() {
  const t = $('#drawer').hidden ? null : $('.tabs .on').dataset.tab;
  $('#infoBtn').classList.toggle('on', t === 'info'); $('#gemBtn').classList.toggle('on', t === 'gemini');
}
function setTab(t) { $$('.tabs [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === t)); $('#info').hidden = t !== 'info'; $('#gemini').hidden = t !== 'gemini'; if (t === 'gemini') { chat(); api.state().then((s) => { state = s; chat(); }).catch(() => {}); $('#prompt').focus(); } else info(); drawerBtns(); }
$('.tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); };
$('#closeDrawer').onclick = () => toggleDrawer(null);
$('#infoBtn').onclick = () => toggleDrawer('info');
$('#gemBtn').onclick = () => toggleDrawer('gemini');

function info() {
  const el = $('#info'); if ($('#drawer').hidden) return;
  const files = selected();
  if (!files.length) {
    el.innerHTML = `<h3>${esc(viewTitle(S.view))}</h3><dl><dt>Fichiers</dt><dd>${S.files.length - S.files.filter(isFolder).length}</dd><dt>Dossiers</dt><dd>${S.files.filter(isFolder).length}</dd><dt>Taille</dt><dd>${bytes(S.files.reduce((s, f) => s + Number(f.size || 0), 0))}</dd></dl>
      <p class="hint"><kbd>Double-clic</kbd> ouvrir · <kbd>Espace</kbd> aperçu<br><kbd>Ctrl C</kbd> <kbd>Ctrl X</kbd> <kbd>Ctrl V</kbd> copier, couper, coller<br><kbd>F2</kbd> renommer · <kbd>Suppr</kbd> corbeille<br>Glisse un fichier sur un dossier pour le déplacer, ou hors du navigateur pour le déposer dans une autre application.</p>`;
    return;
  }
  if (files.length > 1) {
    el.innerHTML = `<h3>${files.length} éléments</h3><dl><dt>Taille</dt><dd>${bytes(files.reduce((s, f) => s + Number(f.size || 0), 0))}</dd><dt>Dossiers</dt><dd>${files.filter(isFolder).length}</dd></dl>`;
    return;
  }
  const f = files[0]; const k = kind(f); const md = f.imageMediaMetadata || f.videoMediaMetadata;
  el.innerHTML = `<div class="pv">${hasThumb(f) ? `<img src="${thumbUrl(f, 640)}" alt="" data-drop>` : ic(KIND_ICON[k])}</div>
    <h3>${esc(f.name)}</h3>
    <dl><dt>Type</dt><dd>${esc(typeLabel(f))}</dd>${isFolder(f) ? '' : `<dt>Taille</dt><dd>${bytes(f.size)}</dd>`}
    <dt>Modifié</dt><dd>${f.modifiedTime ? dShort.format(new Date(f.modifiedTime)) + ' · ' + dTime.format(new Date(f.modifiedTime)) : '—'}</dd>
    ${md?.width ? `<dt>Dimensions</dt><dd>${md.width} × ${md.height}</dd>` : ''}${f.videoMediaMetadata?.durationMillis ? `<dt>Durée</dt><dd>${dur(f.videoMediaMetadata.durationMillis)}</dd>` : ''}
    <dt>Dossier</dt><dd class="loc" id="loc">${f.parents?.[0] ? '…' : '<span class="m">hors de ton Drive (partagé avec toi)</span>'}</dd>
    <dt>Propriétaire</dt><dd>${esc(f.owners?.[0]?.displayName || '—')}${f.owners?.[0]?.me ? ' (toi)' : ''}</dd><dt>Partagé</dt><dd>${f.shared ? 'oui' : 'non'}</dd></dl>
    <div class="acts">${isFolder(f) ? '' : `<button class="btn" data-a="local">${ic('Monitor')}Application</button>`}<button class="btn" data-a="web">${ic('ExternalLink')}Drive web</button><button class="btn" data-a="link">${ic('Link')}Copier le lien</button></div>`;
  // Where the file lives: its folder path, each part clickable (answers "is this really in my Drive, and where?")
  const parent = f.parents?.[0];
  if (parent) api.drivePath(parent).then((p) => {
    const loc = $('#loc'); if (!loc || selected()[0]?.id !== f.id) return;
    loc.innerHTML = p.map((x) => `<button data-go="${esc(x.id)}" data-drive="${esc(x.driveId || '')}" title="Ouvrir ce dossier">${esc(x.name)}</button>`).join('<i>/</i>');
  }).catch(() => { const loc = $('#loc'); if (loc) loc.innerHTML = '<span class="m">dossier inaccessible (partagé avec toi)</span>'; });
}
$('#info').addEventListener('click', (e) => {
  const g = e.target.closest('[data-go]');
  if (g) return go({ kind: 'folder', id: g.dataset.go, name: g.textContent, driveId: g.dataset.drive || undefined });
  const a = e.target.closest('[data-a]')?.dataset.a; const f = selected()[0]; if (!a || !f) return;
  ({ local: () => openLocal(f), web: () => openWeb(f), link: () => copyLink(f) })[a]?.();
});

// ---------- Gemini ----------
function askGemini(files) { S.attach = files.filter((f) => !isFolder(f)).slice(0, 10); if ($('#drawer').hidden || $('.tabs .on').dataset.tab !== 'gemini') toggleDrawer('gemini'); else chat(); }
const SUGGEST = [['Résume les fichiers joints en quelques points.', false], ['Décris ce que montrent les photos jointes.', false], ['Range les fichiers de ce dossier dans des sous-dossiers par type.', true], ['Trouve mes documents qui parlent de factures.', true]];
function md(t) {
  return esc(t).split(/```/).map((b, i) => i % 2 ? `<pre>${b.replace(/^\w*\n/, '')}</pre>` : b.split(/\n{2,}/).map((p) => {
    const inl = (s) => s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    const lines = p.split('\n');
    if (lines.every((l) => /^\s*([-*]|\d+\.)\s/.test(l))) return '<ul>' + lines.map((l) => `<li>${inl(l.replace(/^\s*([-*]|\d+\.)\s/, ''))}</li>`).join('') + '</ul>';
    return `<p>${inl(p).replace(/\n/g, '<br>')}</p>`;
  }).join('')).join('');
}
function chat() {
  $('#attach').innerHTML = S.attach.length ? S.attach.map((f) => `<span title="${esc(f.name)}">${esc(f.name)}</span>`).join('') + `<button class="ib" style="width:22px;height:22px" id="clearAtt" title="Retirer">${ic('X')}</button>` : '';
  const m = $('#msgs');
  if (!state?.gemini) { m.innerHTML = `<div class="intro">Connecte ton compte Google pour discuter avec tes fichiers : Gemini passe par le même compte que ton Drive.</div>`; return; }
  if (state.geminiScope === false && !S.chat.length) { m.innerHTML = fixHtml('SCOPE:gemini'); return; }
  if (!S.chat.length) { m.innerHTML = `<div class="intro">Sélectionne des fichiers puis <kbd>Ctrl G</kbd> pour les joindre. En mode agent, Gemini range ton Drive, crée des Docs, Sheets et Slides, lit et prépare tes mails, gère ton agenda et tes tâches. Il demande avant d'envoyer un mail ou de supprimer quoi que ce soit.${SUGGEST.map(([s, ag], i) => `<button data-s="${i}">${esc(s)}${ag ? '<small>agent</small>' : ''}</button>`).join('')}</div>`; return; }
  m.innerHTML = S.chat.map((x) => x.role === 'user' ? `<div class="msg user">${esc(x.text)}</div>`
    : fixHtml(x.text) ? `<div class="msg model">${fixHtml(x.text)}</div>`
    : `<div class="msg model ${x.err ? 'err' : ''}">${x.wait ? `<span class="wait">${esc(S.gemStatus || 'Gemini réfléchit…')}</span>` : md(x.text)}${x.log?.length ? `<div class="log">${x.log.map(esc).join(' · ')}</div>` : ''}</div>`).join('');
  m.scrollTop = m.scrollHeight;
}
// Every Google service rides on the same account. Two cases need one click from the user (authorise the account,
// switch the API on in the Google project), so they get a card with a button instead of a raw error.
const SVC_NAME = { gemini: 'Gemini', gmail: 'Gmail', calendar: 'Google Agenda', tasks: 'Google Tasks', docs: 'Google Docs', sheets: 'Google Sheets', slides: 'Google Slides', drive: 'Google Drive' };
function fixHtml(code) {
  const m = /^(SCOPE|API_OFF):(\w+)$/.exec(String(code || '')); if (!m) return '';
  const n = esc(SVC_NAME[m[2]] || m[2]);
  return m[1] === 'SCOPE'
    ? `<div class="fix">${ic('KeyRound')}<b>Autoriser ${n}</b><span>${n} utilise ton compte Google, comme Drive. Ce compte a été relié avant que Tiroir intègre ce service : autorise-le une fois, en cochant toutes les cases dans la page Google.</span><button class="btn primary" data-fix="auth">${ic('ShieldCheck')}Autoriser avec mon compte Google</button></div>`
    : `<div class="fix">${ic('PlugZap')}<b>Activer ${n} dans ton projet Google</b><span>Dans la page qui s'ouvre, vérifie que le projet est « Tiroir » et clique sur <b>Activer</b> (ça active tous les services de Tiroir d'un coup). Attends une minute, puis réessaie.</span><span class="btns"><button class="btn primary" data-fix="api">${ic('ExternalLink')}Activer dans Google Cloud</button><button class="btn" data-fix="retry">${ic('RotateCw')}Réessayer</button></span></div>`;
}
async function authorizeServices() {
  const tab = window.tiroirWin ? null : window.open('about:blank', '_blank');
  try {
    const url = await api.servicesAuthorize();
    if (tab) tab.location = url; else openOut(url);
    toast('Dans Google, coche toutes les cases (ou « Tout sélectionner »), puis Continuer…', 60000);
    await api.authWait();
    state = await api.state();
    const missing = Object.entries(state.scopes || {}).filter(([, v]) => v === false).map(([k]) => SVC_NAME[k] || k);
    toast(missing.length ? `Pas encore autorisé : ${missing.join(', ')}. Réessaie en cochant toutes les cases.` : 'Tous les services Google sont autorisés', 8000);
    S.chat = S.chat.filter((x) => !fixHtml(x.text)); chat();
    if (isSvc(S.view)) svcRender();
  } catch (x) { tab?.close(); toast(oauthMsg(x), 8000); }
}
const geminiAuthorize = authorizeServices;
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-fix]'); if (!b) return;
  if (b.dataset.fix === 'auth') authorizeServices();
  else if (b.dataset.fix === 'api') openOut(state?.enableApisUrl || 'https://console.cloud.google.com/apis/library');
  else if (b.dataset.fix === 'retry') b.closest('#msgs') ? geminiRetry() : svcRender();
});
function geminiRetry() {
  const i = S.chat.findLastIndex((x) => fixHtml(x.text)); if (i < 1) return;
  const q = S.chat[i - 1]; S.chat.splice(i - 1, 2); $('#prompt').value = q.text.replace(/\n\n\([^)]*\)$/, ''); send();
}
$('#msgs').addEventListener('click', (e) => {
  const s = e.target.closest('[data-s]'); if (!s) return;
  const [t, ag] = SUGGEST[+s.dataset.s]; $('#prompt').value = t; $('#agent').checked = ag; $('#prompt').focus();
});
$('#attach').addEventListener('click', (e) => { if (e.target.closest('#clearAtt')) { S.attach = []; chat(); } });
async function send() {
  const text = $('#prompt').value.trim(); if (!text || S.chat.at(-1)?.wait) return;
  $('#prompt').value = '';
  const files = S.attach; S.attach = [];
  S.chat.push({ role: 'user', text: files.length ? `${text}\n\n(${files.map((f) => f.name).join(', ')})` : text });
  const reply = { role: 'model', wait: true, text: '' }; S.chat.push(reply); S.gemStatus = ''; S.gemT0 = Date.now(); chat();
  // what Gemini is doing right now + elapsed seconds, so a long answer never looks frozen
  const tick = setInterval(() => { const w = $('#msgs .wait'); if (w) w.textContent = `${S.gemStatus || 'Gemini réfléchit…'} ${Math.round((Date.now() - S.gemT0) / 1000)} s`; }, 1000);
  try {
    const r = await api.geminiChat({ history: S.chat.filter((x) => !x.wait && !x.err).map(({ role, text: t }) => ({ role, text: t })), files: files.map(({ id }) => ({ id })), agent: $('#agent').checked, folder: S.view.kind === 'folder' ? { id: S.view.id, name: viewTitle(S.view) } : null, selection: selected().slice(0, 30).map(({ id, name }) => ({ id, name })) });
    Object.assign(reply, { wait: false, text: r.text || '(vide)', log: r.log });
  } catch (e) { Object.assign(reply, { wait: false, err: true, text: cleanErr(e) }); }
  clearInterval(tick); S.gemStatus = '';
  chat();
}
on('gemini', ({ status }) => { S.gemStatus = status; const w = $('#msgs .wait'); if (w) w.textContent = `${status} ${Math.round((Date.now() - (S.gemT0 || Date.now())) / 1000)} s`; });
$('#send').onclick = send;
$('#prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
// From a mail, an event list…: open Gemini with a ready question, agent mode on so it can use the tools.
function askGeminiText(text) {
  if ($('#drawer').hidden || $('.tabs .on').dataset.tab !== 'gemini') toggleDrawer('gemini');
  $('#agent').checked = true; $('#prompt').value = text; send();
}

// ---------- Google views: Gmail, Agenda, Tâches (shown instead of the file grid) ----------
const SVC_VIEWS = new Set(['gmail', 'calendar', 'tasks']);
const isSvc = (v) => SVC_VIEWS.has(v?.kind);
const svcEl = $('#svc');
const SV = { mail: { label: 'INBOX', q: '', list: [], next: null, open: null }, cal: { start: null, days: 28 }, tasks: { lists: null, list: null } };
const svcErr = (e) => { const c = cleanErr(e); return fixHtml(c) || `<div class="fix">${ic('CloudOff')}<b>Impossible de charger</b><span>${esc(c)}</span><button class="btn" data-fix="retry">${ic('RotateCw')}Réessayer</button></div>`; };
const svcLoading = () => '<div class="gload"><i></i><i></i><i></i></div>';
function svcRender() {
  const k = S.view.kind;
  $('#q').placeholder = k === 'gmail' ? 'Rechercher dans Gmail' : 'Rechercher dans Drive';
  if (k === 'gmail') mailView(); else if (k === 'calendar') calView(); else if (k === 'tasks') tasksView();
}
// "Jean Dupont <jean@x.fr>" -> "Jean Dupont"
const who = (s) => (String(s).match(/^\s*"?([^"<]+?)"?\s*</)?.[1] || String(s).replace(/[<>]/g, '')).trim();
const dMail = (t) => { const d = new Date(t); return d.toDateString() === new Date().toDateString() ? dTime.format(d) : dShort.format(d); };

// --- Gmail ---
const LABELS = [['INBOX', 'Reçus'], ['STARRED', 'Suivis'], ['SENT', 'Envoyés'], ['ALL', 'Tous']];
async function mailView({ more = false } = {}) {
  const M = SV.mail;
  if (!more || !svcEl.querySelector('.mail')) {
    svcEl.innerHTML = `<div class="mail"><div class="mlist"><div class="mtools"><div class="seg" id="mLabels">${M.q ? `<button class="on" data-l="search">« ${esc(M.q)} »</button>` : ''}${LABELS.map(([l, n]) => `<button data-l="${l}" class="${!M.q && M.label === l ? 'on' : ''}">${n}</button>`).join('')}</div><span class="grow"></span><button class="ib" data-m="reload" title="Actualiser">${ic('RotateCw')}</button><button class="btn primary" data-m="compose">${ic('PenLine')}Nouveau</button></div><div class="mitems" id="mItems">${svcLoading()}</div></div><div class="mread" id="mRead"><div class="mempty">${ic('Mail')}<span>Choisis un message</span></div></div></div>`;
  }
  try {
    const r = await api.gmailList({ q: M.q, label: M.label, pageToken: more ? M.next : null });
    if (S.view.kind !== 'gmail') return;
    M.list = more ? M.list.concat(r.messages) : r.messages; M.next = r.next;
    paintMailList();
    if (!more && M.label === 'INBOX' && !M.q) badge(M.list.filter((m) => m.unread).length);
    if (M.open && !more) openMail(M.open, { keep: true });
  } catch (e) { $('#mItems') && ($('#mItems').innerHTML = svcErr(e)); }
}
function badge(n) { const b = $('#mailBadge'); b.hidden = !n; b.textContent = n > 99 ? '99+' : n; }
function paintMailList() {
  const M = SV.mail; const el = $('#mItems'); if (!el) return;
  el.innerHTML = M.list.length ? M.list.map((m) => `<button class="mi ${m.unread ? 'unread' : ''} ${M.open === m.id ? 'on' : ''}" data-id="${esc(m.id)}">
      <span class="r1"><b>${esc(who(M.label === 'SENT' ? 'À : ' + m.to : m.from) || '(inconnu)')}</b>${m.attach ? ic('Paperclip') : ''}${m.starred ? ic('Star') : ''}<time>${dMail(m.date)}</time></span>
      <span class="r2">${esc(m.subject || '(sans objet)')}</span><span class="r3">${esc(m.snippet)}</span></button>`).join('') + (M.next ? `<button class="btn more" data-m="more">Messages plus anciens</button>` : '')
    : `<div class="mempty">${ic('Inbox')}<span>Aucun message</span></div>`;
}
async function openMail(id, { keep = false } = {}) {
  const M = SV.mail; M.open = id;
  $$('#mItems .mi').forEach((b) => b.classList.toggle('on', b.dataset.id === id));
  const el = $('#mRead'); if (!keep) el.innerHTML = svcLoading();
  try {
    const m = await api.gmailGet(id);
    if (M.open !== id || !$('#mRead')) return;
    const li = M.list.find((x) => x.id === id); if (li?.unread) { li.unread = false; paintMailList(); if (M.label === 'INBOX' && !M.q) badge(M.list.filter((x) => x.unread).length); }
    M.msg = m;
    el.innerHTML = `<div class="mhead"><h2>${esc(m.subject || '(sans objet)')}</h2>
      <div class="mmeta"><span><b>${esc(who(m.from))}</b> <small>${esc(m.from)}</small></span><time>${esc(new Date(m.date).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' }))}</time></div>
      <div class="mmeta"><small>À : ${esc(m.to)}${m.cc ? ' · Cc : ' + esc(m.cc) : ''}</small></div>
      <div class="mact"><button class="btn" data-m="reply">${ic('Reply')}Répondre</button><button class="btn" data-m="forward">${ic('Forward')}Transférer</button><button class="btn" data-m="gem">${ic('Sparkles')}Résumer avec Gemini</button><span class="grow"></span>
        <button class="ib" data-m="star" title="${m.starred ? 'Retirer le suivi' : 'Suivre'}">${ic(m.starred ? 'StarOff' : 'Star')}</button><button class="ib" data-m="unread" title="Marquer comme non lu">${ic('MailWarning')}</button><button class="ib" data-m="archive" title="Archiver">${ic('Archive')}</button><button class="ib" data-m="trash" title="Corbeille">${ic('Trash2')}</button><button class="ib" data-m="web" title="Ouvrir dans Gmail">${ic('ExternalLink')}</button></div></div>
      ${m.attachments.length ? `<div class="matt">${m.attachments.map((a, i) => `<span class="ach">${ic(KIND_ICON[kind({ mimeType: a.mimeType })] || 'File')}<span title="${esc(a.name)}">${esc(a.name)}</span><small>${bytes(a.size)}</small><button class="ib" data-att="${i}" data-to="drive" title="Enregistrer dans Drive">${ic('HardDriveUpload')}</button><button class="ib" data-att="${i}" data-to="downloads" title="Télécharger">${ic('Download')}</button></span>`).join('')}</div>` : ''}
      <div class="mbody">${m.html ? '<iframe sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe><p class="mnote">Images distantes bloquées pour ta vie privée.</p>' : `<pre>${esc(m.text || '(message vide)')}</pre>`}</div>`;
    // Mail HTML runs in an opaque sandbox: no scripts, no access to Tiroir; our CSP also blocks remote images (tracking pixels).
    const fr = $('iframe', el); if (fr) fr.srcdoc = `<!doctype html><meta charset="utf-8"><style>body{font:14px/1.5 system-ui,sans-serif;color:#111;background:#fff;margin:16px;word-wrap:break-word}img{max-width:100%;height:auto}</style>${m.html}`;
  } catch (e) { if (M.open === id) el.innerHTML = svcErr(e); }
}
function compose(init = {}) {
  return modal(`<form class="compose-m"><h4>${esc(init.title || 'Nouveau message')}</h4>
    <label>À<input name="to" value="${esc(init.to || '')}" placeholder="adresse@exemple.com" spellcheck="false"></label>
    <label>Cc<input name="cc" value="${esc(init.cc || '')}" spellcheck="false"></label>
    <label>Objet<input name="subject" value="${esc(init.subject || '')}"></label>
    <textarea name="body" rows="12">${esc(init.body || '')}</textarea>
    <div class="err" id="cErr"></div>
    <div class="btns"><button type="button" class="btn left" data-draft>${ic('Save')}Brouillon</button><button type="button" class="btn" data-x>Annuler</button><button class="btn primary">${ic('Send')}Envoyer</button></div></form>`, (m, done) => {
    const f = $('form', m); const val = () => ({ ...Object.fromEntries(new FormData(f)), threadId: init.threadId, inReplyTo: init.inReplyTo, references: init.references });
    (init.to ? $('textarea', m) : $('[name=to]', m)).focus(); if (init.to) $('textarea', m).setSelectionRange(0, 0);
    const go_ = async (fn, ok) => { try { await fn(val()); done(true); toast(ok); } catch (e) { $('#cErr', m).textContent = cleanErr(e); } };
    $('[data-draft]', m).onclick = () => go_(api.gmailDraft, 'Brouillon enregistré dans Gmail');
    f.onsubmit = (e) => { e.preventDefault(); if (!val().to.trim()) return ($('#cErr', m).textContent = 'Indique au moins un destinataire.'); go_(api.gmailSend, 'Message envoyé'); };
  });
}
// Plain text of a mail; for HTML-only mails, DOMParser gives the text without running scripts or loading anything.
const plain = (m) => m.text || new DOMParser().parseFromString(String(m.html || '').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '$&\n'), 'text/html').body.textContent.replace(/\n{3,}/g, '\n\n').trim();
const quote = (m) => `\n\nLe ${new Date(m.date).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' })}, ${m.from} a écrit :\n` + plain(m).split('\n').map((l) => '> ' + l).join('\n');
svcEl.addEventListener('click', async (e) => {
  if (S.view.kind !== 'gmail') return;
  const M = SV.mail; const m = M.msg;
  const l = e.target.closest('[data-l]'); if (l) { if (l.dataset.l !== 'search') { M.label = l.dataset.l; M.q = ''; $('#q').value = ''; M.open = null; mailView(); } return; }
  const it = e.target.closest('.mi'); if (it) return openMail(it.dataset.id);
  const att = e.target.closest('[data-att]');
  if (att && m) {
    const a = m.attachments[+att.dataset.att];
    if (att.dataset.to === 'downloads') return api.gmailSaveAttachment(m.id, { id: a.id, partId: a.partId, name: a.name }, { to: 'downloads' }).then((r) => toast(`« ${r.name} » enregistré dans Téléchargements`)).catch(fail);
    const dest = await pickFolder(`Enregistrer « ${a.name} » dans…`, 'Enregistrer ici', new Set()); if (!dest) return;
    return api.gmailSaveAttachment(m.id, { id: a.id, partId: a.partId, name: a.name }, { to: 'drive', folder: dest.id }).then(() => { cache.clear(); toast(`« ${a.name} » enregistré dans « ${dest.name} »`); }).catch(fail);
  }
  const b = e.target.closest('[data-m]'); if (!b) return;
  const act_ = { reload: () => mailView(), more: () => mailView({ more: true }), compose: () => compose() };
  if (act_[b.dataset.m]) return act_[b.dataset.m]();
  if (!m) return;
  const drop = () => { M.list = M.list.filter((x) => x.id !== m.id); M.open = null; M.msg = null; paintMailList(); $('#mRead').innerHTML = `<div class="mempty">${ic('Mail')}<span>Choisis un message</span></div>`; };
  switch (b.dataset.m) {
    case 'reply': return compose({ title: 'Répondre', to: m.replyTo || m.from, subject: /^re\s*:/i.test(m.subject) ? m.subject : 'Re: ' + m.subject, body: quote(m), threadId: m.threadId, inReplyTo: m.messageId, references: m.references });
    case 'forward': return compose({ title: 'Transférer', subject: 'Fwd: ' + m.subject, body: `\n\n---------- Message transféré ----------\nDe : ${m.from}\nObjet : ${m.subject}\n\n${plain(m)}` });
    case 'gem': return askGeminiText(`Résume ce mail (id ${m.id}) en quelques points et dis-moi s'il y a quelque chose à faire.`);
    case 'star': await api.gmailStar(m.id, !m.starred).catch(fail); m.starred = !m.starred; return openMail(m.id, { keep: true });
    case 'unread': await api.gmailMarkUnread(m.id).catch(fail); { const li = M.list.find((x) => x.id === m.id); if (li) li.unread = true; } M.open = null; paintMailList(); return toast('Marqué comme non lu');
    case 'archive': await api.gmailArchive(m.id).then(() => { drop(); toast('Archivé'); }).catch(fail); return;
    case 'trash': await api.gmailTrash(m.id).then(() => { drop(); toast('Mis à la corbeille de Gmail'); }).catch(fail); return;
    case 'web': return openOut(`https://mail.google.com/mail/u/${encodeURIComponent(S.me)}/#all/${encodeURIComponent(m.id)}`);
  }
});

// --- Agenda ---
const startOfWeek = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dDay = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const dRange = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
async function calView() {
  const C = SV.cal; C.start ||= startOfWeek(new Date());
  const end = new Date(C.start); end.setDate(end.getDate() + C.days);
  svcEl.innerHTML = `<div class="cal"><div class="mtools"><button class="ib" data-c="prev" title="Période précédente">${ic('ChevronLeft')}</button><button class="btn" data-c="today">Aujourd'hui</button><button class="ib" data-c="next" title="Période suivante">${ic('ChevronRight')}</button>
    <b class="crange">${dRange.format(C.start)} – ${dRange.format(new Date(end - 1))}</b><span class="grow"></span><button class="btn" data-c="gem">${ic('Sparkles')}Ma semaine avec Gemini</button><button class="btn primary" data-c="new">${ic('Plus')}Nouvel événement</button></div><div class="cdays" id="cDays">${svcLoading()}</div></div>`;
  try {
    const evs = await api.calEvents({ from: C.start.toISOString(), to: end.toISOString() });
    if (S.view.kind !== 'calendar') return;
    C.events = evs;
    const by = new Map();
    const midnight = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
    for (const e of evs) { // an event spanning several days shows on each of them
      const s = new Date(e.allDay ? e.start + 'T00:00' : e.start);
      const last = midnight(new Date((e.allDay ? new Date(e.end + 'T00:00') : new Date(e.end)) - 1)); // end is exclusive
      for (let d = midnight(Math.max(s, C.start)); d <= last && d < end; d.setDate(d.getDate() + 1)) {
        const k = dayKey(d); if (!by.has(k)) by.set(k, []); by.get(k).push(e);
      }
    }
    const today = dayKey(new Date()); const out = [];
    for (let d = new Date(C.start); d < end; d.setDate(d.getDate() + 1)) {
      const k = dayKey(d); const list = by.get(k) || [];
      if (!list.length && k !== today) continue;
      out.push(`<section class="cday ${k === today ? 'today' : ''}"><h3>${esc(dDay.format(d))}${k === today ? '<small>aujourd’hui</small>' : ''}</h3>${list.length ? list.map((e) => `<button class="cev" data-ev="${esc(e.calendarId)}|${esc(e.id)}"><i style="background:${esc(e.color)}"></i><time>${e.allDay ? 'Journée' : dTime.format(new Date(e.start)) + ' – ' + dTime.format(new Date(e.end))}</time><b>${esc(e.summary)}</b>${e.location ? `<small>${ic('MapPin')}${esc(e.location)}</small>` : ''}</button>`).join('') : '<p class="cnone">Rien de prévu</p>'}</section>`);
    }
    $('#cDays').innerHTML = out.join('') || `<div class="mempty">${ic('CalendarDays')}<span>Aucun événement sur cette période</span></div>`;
  } catch (e) { $('#cDays') && ($('#cDays').innerHTML = svcErr(e)); }
}
async function eventForm() {
  const cals = await api.calCalendars().catch((e) => { fail(e); return null; }); if (!cals) return;
  const now = new Date(); now.setMinutes(0, 0, 0); now.setHours(now.getHours() + 1);
  const t = (d) => `${String(d.getHours()).padStart(2, '0')}:00`;
  modal(`<form><h4>Nouvel événement</h4>
    <label>Titre<input name="summary" required></label>
    <div class="row2"><label>Date<input type="date" name="date" value="${dayKey(now)}" required></label><label>Début<input type="time" name="start" value="${t(now)}"></label><label>Fin<input type="time" name="end" value="${t(new Date(now.getTime() + 36e5))}"></label></div>
    <label class="chk"><input type="checkbox" name="allDay"> Toute la journée</label>
    <label>Lieu<input name="location"></label>
    <label>Notes<input name="description"></label>
    <label>Agenda<select name="calendarId">${cals.filter((c) => c.writable).map((c) => `<option value="${esc(c.id)}" ${c.primary ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
    <div class="err" id="eErr"></div>
    <div class="btns"><button type="button" class="btn" data-x>Annuler</button><button class="btn primary">Créer</button></div></form>`, (m, done) => {
    $('[name=summary]', m).focus();
    $('form', m).onsubmit = async (e) => {
      e.preventDefault(); const v = Object.fromEntries(new FormData(e.target));
      const allDay = !!v.allDay;
      try {
        await api.calCreate({ calendarId: v.calendarId, summary: v.summary, location: v.location, description: v.description, allDay, start: allDay ? v.date : `${v.date}T${v.start}`, end: allDay ? undefined : `${v.date}T${v.end}` });
        done(true); toast('Événement créé'); calView();
      } catch (x) { $('#eErr', m).textContent = cleanErr(x); }
    };
  });
}
svcEl.addEventListener('click', async (e) => {
  if (S.view.kind !== 'calendar') return;
  const C = SV.cal;
  const b = e.target.closest('[data-c]');
  if (b) {
    const c = b.dataset.c;
    if (c === 'prev' || c === 'next') { C.start = new Date(C.start); C.start.setDate(C.start.getDate() + (c === 'next' ? C.days : -C.days)); return calView(); }
    if (c === 'today') { C.start = null; return calView(); }
    if (c === 'new') return eventForm();
    if (c === 'gem') return askGeminiText('Résume mon agenda des 7 prochains jours et signale les conflits ou les journées chargées.');
  }
  const ev_ = e.target.closest('[data-ev]'); if (!ev_) return;
  const [cid, id] = ev_.dataset.ev.split('|'); const x = C.events?.find((y) => y.id === id && y.calendarId === cid); if (!x) return;
  modal(`<form><h4>${esc(x.summary)}</h4><p>${x.allDay ? 'Toute la journée' : esc(new Date(x.start).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' })) + ' → ' + esc(dTime.format(new Date(x.end)))}${x.location ? '\n' + esc(x.location) : ''}\n${esc(x.calendar)}${x.description ? '\n\n' + esc(x.description.replace(/<[^>]+>/g, ' ')) : ''}</p>
    <div class="btns">${x.writable ? `<button type="button" class="btn left danger" data-del>${ic('Trash2')}Supprimer</button>` : ''}<button type="button" class="btn" data-x>Fermer</button>${x.link ? `<button type="button" class="btn primary" data-open>${ic('ExternalLink')}Ouvrir dans Agenda</button>` : ''}</div></form>`, (m, done) => {
    $('[data-open]', m)?.addEventListener('click', () => { openOut(x.link); done(null); });
    $('[data-del]', m)?.addEventListener('click', async () => {
      done(null);
      if (!(await confirmBox(`Supprimer « ${x.summary} » ?`, 'L’événement sera supprimé de ton agenda Google.', 'Supprimer'))) return;
      api.calDelete(x.calendarId, x.id).then(() => { toast('Événement supprimé'); calView(); }).catch(fail);
    });
  });
});

// --- Tâches ---
async function tasksView() {
  const T = SV.tasks;
  svcEl.innerHTML = `<div class="tasks"><div class="mtools"><select id="tList" title="Liste"><option>chargement…</option></select><span class="grow"></span><button class="btn" data-t="gem">${ic('Sparkles')}Planifier avec Gemini</button></div>
    <form class="tadd" id="tAdd"><input name="title" placeholder="Ajouter une tâche, puis Entrée" autocomplete="off"><input type="date" name="due" title="Échéance"><button class="btn primary">${ic('Plus')}Ajouter</button></form>
    <div class="titems" id="tItems">${svcLoading()}</div></div>`;
  try {
    T.lists ||= await api.tasksLists();
    if (S.view.kind !== 'tasks') return;
    if (!T.lists.length) { $('#tItems').innerHTML = `<div class="mempty">${ic('ListChecks')}<span>Aucune liste de tâches</span></div>`; return; }
    if (!T.lists.some((l) => l.id === T.list)) T.list = T.lists[0].id;
    $('#tList').innerHTML = T.lists.map((l) => `<option value="${esc(l.id)}" ${l.id === T.list ? 'selected' : ''}>${esc(l.title)}</option>`).join('');
    await paintTasks();
  } catch (e) { $('#tItems') && ($('#tItems').innerHTML = svcErr(e)); }
}
async function paintTasks() {
  const T = SV.tasks; const el = $('#tItems'); if (!el) return;
  T.items = await api.tasksList(T.list);
  if (S.view.kind !== 'tasks') return;
  const row = (t) => `<div class="ti ${t.status === 'completed' ? 'done' : ''}" data-id="${esc(t.id)}"><button class="tchk" data-t="toggle" title="${t.status === 'completed' ? 'Marquer à faire' : 'Terminer'}">${t.status === 'completed' ? ic('CircleCheck') : ic('Circle')}</button><span class="tt"><b>${esc(t.title)}</b>${t.notes ? `<small>${esc(t.notes)}</small>` : ''}</span>${t.due ? `<time class="${t.status !== 'completed' && t.due < dayKey(new Date()) ? 'late' : ''}">${esc(dShort.format(new Date(t.due + 'T00:00')))}</time>` : ''}<button class="ib" data-t="del" title="Supprimer">${ic('X')}</button></div>`;
  const todo = T.items.filter((t) => t.status !== 'completed'), done = T.items.filter((t) => t.status === 'completed');
  el.innerHTML = (todo.length ? todo.map(row).join('') : `<div class="mempty">${ic('PartyPopper')}<span>Tout est fait</span></div>`) + (done.length ? `<details class="tdone"><summary>Terminées (${done.length})</summary>${done.map(row).join('')}</details>` : '');
}
svcEl.addEventListener('submit', async (e) => {
  if (e.target.id !== 'tAdd') return; e.preventDefault();
  const v = Object.fromEntries(new FormData(e.target)); if (!v.title.trim()) return;
  e.target.reset(); $('[name=title]', e.target).focus();
  await api.tasksAdd(SV.tasks.list, { title: v.title.trim(), due: v.due || undefined }).catch(fail); paintTasks().catch(fail);
});
svcEl.addEventListener('change', (e) => { if (e.target.id === 'tList') { SV.tasks.list = e.target.value; paintTasks().catch(fail); } });
svcEl.addEventListener('click', async (e) => {
  if (S.view.kind !== 'tasks') return;
  const b = e.target.closest('[data-t]'); if (!b) return;
  if (b.dataset.t === 'gem') return askGeminiText('Regarde mes tâches et mon agenda de la semaine, et propose-moi un plan pour avancer.');
  const id = b.closest('[data-id]')?.dataset.id; const t = SV.tasks.items?.find((x) => x.id === id); if (!t) return;
  if (b.dataset.t === 'toggle') { b.closest('.ti').classList.toggle('done'); await api.tasksUpdate(SV.tasks.list, id, { status: t.status === 'completed' ? 'needsAction' : 'completed' }).catch(fail); }
  if (b.dataset.t === 'del') await api.tasksDelete(SV.tasks.list, id).catch(fail);
  paintTasks().catch(fail);
});

// ---------- jobs, toast, modals ----------
function setJob(j) { S.jobs.set(j.id, j); if (j.state !== 'run') setTimeout(() => { S.jobs.delete(j.id); jobs(); }, j.state === 'ok' ? 4000 : 15000); jobs(); }
function jobs() {
  $('#jobs').innerHTML = [...S.jobs.values()].slice(-5).map((j) => {
    const pct = j.total ? Math.min(100, (j.done / j.total) * 100) : j.state === 'run' ? 35 : 100;
    return `<div class="job ${j.state}" title="${esc(j.error || j.label)}"><div class="l"><b>${esc(j.label)}</b><span>${j.state === 'err' ? 'échec' : j.state === 'ok' ? 'terminé' : j.total ? Math.round(pct) + ' %' : bytes(j.done)}</span></div><div class="bar2"><i style="width:${pct}%"></i></div></div>`;
  }).join('');
}
on('job', setJob);
on('changed', refresh);
on('confirm', async ({ id, message, detail, verb }) => api.confirmAnswer(id, await confirmBox(message, detail, verb || 'Confirmer')));

let toastT;
function toast(m, ms = 3400) { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms); }

function modal(html, setup) {
  return new Promise((res) => {
    const m = $('#modal'); m.innerHTML = html; m.hidden = false;
    const done = (v) => { m.hidden = true; m.innerHTML = ''; scroller.focus(); res(v); };
    m.onkeydown = (e) => { if (e.key === 'Escape') done(null); };
    m.onmousedown = (e) => { if (e.target === m) done(null); };
    $('[data-x]', m)?.addEventListener('click', () => done(null));
    setup(m, done);
  });
}
const ask = (title, value, stem) => modal(`<form><h4>${esc(title)}</h4><input value="${esc(value)}" spellcheck="false"><div class="btns"><button type="button" class="btn" data-x>Annuler</button><button class="btn primary">Valider</button></div></form>`, (m, done) => {
  const inp = $('input', m); inp.focus(); const dot = value.lastIndexOf('.'); stem && dot > 0 ? inp.setSelectionRange(0, dot) : inp.select();
  $('form', m).onsubmit = (e) => { e.preventDefault(); done(inp.value.trim() || null); };
});
const confirmBox = (title, detail, verb) => modal(`<form><h4>${esc(title)}</h4>${detail ? `<p>${esc(detail)}</p>` : ''}<div class="btns"><button type="button" class="btn" data-x>Annuler</button><button class="btn primary">${esc(verb)}</button></div></form>`, (m, done) => {
  $('form', m).onsubmit = (e) => { e.preventDefault(); done(true); }; $('.btn.primary', m).focus();
}).then((v) => v === true);

function pickFolder(title, verb, exclude) {
  let trail = [{ id: 'root', name: 'Mon Drive' }];
  return modal('', (m, done) => {
    async function show() {
      const cur = trail.at(-1);
      m.innerHTML = `<form class="picker"><h4>${esc(title)}</h4><nav class="pcrumbs">${trail.map((p, i) => `<button type="button" data-t="${i}">${esc(p.name)}</button>`).join('<i>/</i>')}</nav>
        <div class="plist"><p class="pmuted">chargement…</p></div>
        <div class="btns"><button type="button" class="btn left" data-new>${ic('FolderPlus')}Nouveau dossier</button><button type="button" class="btn" data-x2>Annuler</button><button class="btn primary">${esc(verb)}</button></div></form>`;
      $('form', m).onsubmit = (e) => { e.preventDefault(); done(cur); };
      $('[data-x2]', m).onclick = () => done(null);
      $('[data-new]', m).onclick = async () => {
        const inp = document.createElement('input'); inp.placeholder = 'Nom du nouveau dossier, puis Entrée'; $('.plist', m).prepend(inp); inp.focus();
        inp.onkeydown = async (e) => { e.stopPropagation(); if (e.key === 'Escape') return inp.remove(); if (e.key !== 'Enter') return; e.preventDefault(); const n = inp.value.trim(); if (!n) return; const f = await api.driveMkdir(n, cur.id).catch(fail); if (f) { cache.clear(); trail.push({ id: f.id, name: f.name }); show(); } };
      };
      $('.pcrumbs', m).onclick = (e) => { const t = e.target.closest('[data-t]'); if (t) { trail = trail.slice(0, +t.dataset.t + 1); show(); } };
      let folders = [];
      try { let next; do { const r = await api.driveList({ kind: 'folder', id: cur.id }, next); folders.push(...r.files.filter((f) => f.mimeType === FOLDER)); next = r.next; } while (next); } catch (e) { fail(e); }
      if (trail.at(-1) !== cur || m.hidden) return;
      folders = folders.filter((f) => !exclude.has(f.id)).sort((a, b) => coll.compare(a.name, b.name));
      $('.plist', m).innerHTML = folders.length ? folders.map((f) => `<button type="button" data-id="${esc(f.id)}">${ic('Folder')}<span>${esc(f.name)}</span>${ic('ChevronRight')}</button>`).join('') : '<p class="pmuted">Aucun sous-dossier. Tu peux tout de même valider ici.</p>';
      $('.plist', m).onclick = (e) => { const b = e.target.closest('[data-id]'); if (b) { trail.push({ id: b.dataset.id, name: b.textContent }); show(); } };
    }
    show();
  });
}

async function settings() {
  state = await api.state();
  modal(`<form><h4>Réglages</h4>
    <div class="acctlist"><span>Drives reliés</span>${(S.accounts || []).map((a) => `<div><span class="av">${esc(initials(a))}</span><span class="who"><b>${esc(a.name || a.email)}</b><small>${esc(a.email)}</small></span><button type="button" class="btn" data-rm="${esc(a.email)}">Retirer</button></div>`).join('')}</div>
    <label>ID client OAuth<input name="clientId" value="${esc(state.clientId)}" spellcheck="false"></label>
    <label>Secret client OAuth<input name="clientSecret" type="password" placeholder="enregistré · laisser vide pour garder"></label>
    <div class="acctlist"><span>Services Google · ${esc(S.me || 'compte actif')}</span>${(() => {
      const sc = state.scopes || {}; const todo = Object.values(sc).some((v) => v === false);
      const name = { drive: 'Drive, Docs, Sheets, Slides', gemini: state.geminiVia === 'key' ? 'Gemini (via ta clé API)' : 'Gemini', gmail: 'Gmail', calendar: 'Agenda', tasks: 'Tâches' };
      return `<div class="svclist">${Object.keys(name).map((k) => `<span class="${sc[k] === false ? 'off' : 'on'}" title="${sc[k] === false ? 'À autoriser' : sc[k] ? 'Autorisé' : 'Sera vérifié à la première utilisation'}">${ic(sc[k] === false ? 'CircleDashed' : 'CircleCheck')}${esc(name[k])}</span>`).join('')}</div>
        <div class="svcbtns">${todo ? '<button type="button" class="btn primary" data-gauth>Autoriser les services manquants</button>' : ''}<button type="button" class="btn" data-apis>${ic('ExternalLink')}Activer les API dans Google Cloud</button></div>`;
    })()}</div>
    <div class="acctlist"><span>Verrou</span><div><span class="av">${ic(state.lock?.enabled ? 'LockKeyhole' : 'LockOpen')}</span><span class="who"><b>${state.lock?.enabled ? 'Code demandé à l’ouverture' : 'Pas de code'}</b><small>${state.lock?.enabled ? (state.lock.minutes ? `et après ${state.lock.minutes} min d’absence · Ctrl+L` : 'à chaque ouverture · Ctrl+L') : 'n’importe qui sur ta session Windows peut ouvrir Tiroir'}</small></span><button type="button" class="btn" data-lock>${state.lock?.enabled ? 'Gérer' : 'Activer'}</button></div></div>
    <label>Modèle Gemini<select name="geminiModel"><option value="">Automatique (le plus récent)${state.model && !state.modelChoice ? ' · ' + esc(state.model) : ''}</option>${state.modelChoice ? `<option value="${esc(state.modelChoice)}" selected>${esc(state.modelChoice)}</option>` : ''}</select></label>
    <details class="manual"><summary>Avancé : utiliser une clé API Gemini à la place du compte Google</summary>
      <label>Clé API Gemini<input name="geminiKey" type="password" placeholder="${state.geminiVia === 'key' ? 'enregistrée · laisser vide pour garder' : 'facultatif · aistudio.google.com/apikey'}"></label>
      ${state.geminiVia === 'key' ? '<label class="chk"><input type="checkbox" name="geminiKeyClear" value="1"> Retirer la clé et repasser par le compte Google</label>' : ''}
    </details>
    <div class="btns"><button type="button" class="btn" data-x>Fermer</button><button class="btn primary">Enregistrer</button></div></form>`, (m, done) => {
    $('[data-gauth]', m)?.addEventListener('click', () => { done(null); authorizeServices(); });
    $('[data-apis]', m)?.addEventListener('click', () => openOut(state.enableApisUrl));
    $('[data-lock]', m).addEventListener('click', () => { done(null); setTimeout(() => lockSettings(), 0); });
    // Automatic follows Google's newest stable Flash, so a retired model never breaks Gemini again; a fixed choice stays possible.
    if (state.gemini && state.geminiScope !== false) api.geminiModels().then(({ models, auto }) => {
      const s = $('select[name=geminiModel]', m); if (!s) return;
      s.innerHTML = `<option value="">Automatique (le plus récent)${auto ? ' · ' + esc(auto) : ''}</option>` + models.map((x) => `<option value="${esc(x.id)}" ${x.id === state.modelChoice ? 'selected' : ''}>${esc(x.label)} · ${esc(x.id)}</option>`).join('');
    }).catch(() => {});
    $$('[data-rm]', m).forEach((b) => b.onclick = async () => {
      if (!(await confirmBox(`Retirer le Drive de ${b.dataset.rm} ?`, 'Tiroir oubliera ce compte. Tes fichiers restent dans Google Drive.', 'Retirer'))) return;
      await api.accountRemove(b.dataset.rm); cache.clear(); idb.clear(); S.hist = []; S.path = []; boot(); // forget that account's file lists too
    });
    $('form', m).onsubmit = async (e) => { e.preventDefault(); await api.configSet(Object.fromEntries(new FormData(e.target))); done(true); state = await api.state(); chat(); toast('Réglages enregistrés'); };
  });
}
$('#acct').onclick = settings;

// ---------- first run: step-by-step Google connection ----------
const ENABLE_APIS_URL = 'https://console.cloud.google.com/flows/enableapi?apiid=drive.googleapis.com,generativelanguage.googleapis.com,gmail.googleapis.com,calendar-json.googleapis.com,tasks.googleapis.com,docs.googleapis.com,sheets.googleapis.com,slides.googleapis.com';
const SETUP_STEPS = [
  {
    t: 'Pourquoi cette étape ?',
    s: '1 minute de lecture',
    body: `<p>Google oblige chaque application qui ouvre un Drive à avoir sa propre <b>clé d'accès</b>. Comme Tiroir est ton app à toi, tu vas créer ta clé personnelle. C'est <b>gratuit</b>, sans carte bancaire, et à faire <b>une seule fois</b> (environ 10 minutes).</p>
      <p>Tu vas faire 5 petites choses sur le site de Google, dans ton navigateur. Garde Tiroir ouvert à côté : chaque étape te dit exactement où cliquer.</p>
      <p class="note">Ta clé et ton Drive restent sur ton PC. Tiroir ne passe par aucun serveur à part ceux de Google.</p>`,
  },
  {
    t: 'Créer un projet Google Cloud', s: 'Le « dossier » qui contiendra ta clé',
    url: 'https://console.cloud.google.com/projectcreate', btn: 'Ouvrir la page « Nouveau projet »',
    body: `<ol>
      <li>Clique sur le bouton ci-dessous. Connecte-toi avec <b>le compte Gmail de ton Drive</b>.</li>
      <li>Si c'est ta première fois, Google demande d'accepter ses conditions : coche la case puis <b>Accepter et continuer</b>.</li>
      <li>Dans <b>Nom du projet</b>, écris <code>Tiroir</code>. Ne touche pas au reste.</li>
      <li>Clique sur <b>Créer</b> et attends une dizaine de secondes.</li>
      <li>Une cloche en haut à droite dit que le projet est créé : clique sur <b>Sélectionner le projet</b>.</li>
    </ol>
    <p class="note">Le nom du projet affiché en haut à gauche de Google Cloud doit maintenant être « Tiroir ».</p>`,
  },
  {
    t: 'Autoriser l’accès à Google Drive', s: 'On dit à Google que ce projet utilise Drive',
    url: 'https://console.cloud.google.com/apis/library/drive.googleapis.com', btn: 'Ouvrir la page « Google Drive API »',
    body: `<ol>
      <li>Vérifie en haut à gauche que le projet sélectionné est bien <b>Tiroir</b>.</li>
      <li>Clique sur le bouton bleu <b>Activer</b>.</li>
      <li>La page change et affiche des graphiques : c'est bon, rien d'autre à faire ici.</li>
    </ol>
    <p class="note">Si le bouton dit déjà <b>Gérer</b> au lieu de <b>Activer</b>, c'est déjà fait.</p>`,
  },
  {
    t: 'Présenter l’app à Google', s: 'L’écran que tu verras en te connectant',
    url: 'https://console.cloud.google.com/auth/overview', btn: 'Ouvrir « Google Auth Platform »',
    body: `<ol>
      <li>Clique sur <b>Commencer</b>.</li>
      <li><b>Nom de l'application</b> : <code>Tiroir</code>. <b>Adresse e-mail d'assistance</b> : choisis ton adresse dans la liste. Puis <b>Suivant</b>.</li>
      <li><b>Audience</b> : choisis <b>Externe</b>. Puis <b>Suivant</b>.</li>
      <li><b>Coordonnées</b> : tape ton adresse Gmail. Puis <b>Suivant</b>.</li>
      <li>Coche la case pour accepter le règlement, puis <b>Continuer</b> et <b>Créer</b>.</li>
    </ol>
    <p class="note">Les noms des boutons peuvent varier un peu selon la langue de Google, mais l'ordre reste le même.</p>`,
  },
  {
    t: 'T’ajouter comme testeur', s: 'Sinon Google refusera ta connexion',
    url: 'https://console.cloud.google.com/auth/audience', btn: 'Ouvrir la page « Audience »',
    body: `<ol>
      <li>Descends jusqu'à la partie <b>Utilisateurs tests</b>.</li>
      <li>Clique sur <b>+ Add users</b> (ou <b>Ajouter des utilisateurs</b>).</li>
      <li>Tape <b>ton adresse Gmail</b>, celle de ton Drive, puis <b>Enregistrer</b>.</li>
    </ol>
    <p class="note">Ton app reste en « mode test » : seules les adresses de cette liste peuvent s'y connecter. Laisse-la comme ça, c'est parfait pour un usage perso.</p>`,
  },
  {
    t: 'Créer la clé de Tiroir', s: 'Le fichier que tu vas donner à Tiroir',
    url: 'https://console.cloud.google.com/auth/clients/create', btn: 'Ouvrir la page « Créer un client »',
    body: `<ol>
      <li><b>Type d'application</b> : choisis <b>Application de bureau</b>. C'est important : pas « Application Web ».</li>
      <li><b>Nom</b> : <code>Tiroir</code>. Puis <b>Créer</b>.</li>
      <li>Une fenêtre « Client OAuth créé » s'ouvre. Clique sur <b>Télécharger le fichier JSON</b> (icône de téléchargement).</li>
      <li>Garde ce fichier : il s'appelle <code>client_secret_….json</code> et se trouve dans tes Téléchargements.</li>
    </ol>
    <p class="note">Google ne montre le secret qu'une seule fois. Si tu as fermé la fenêtre trop vite, clique sur ton client dans la liste, puis <b>Add secret</b> (ou <b>Ajouter un secret</b>) pour en créer un nouveau.</p>`,
  },
  {
    t: 'Activer les services Google', s: 'Gemini, Gmail, Agenda, Tâches, Docs…',
    url: ENABLE_APIS_URL, btn: 'Activer tous les services d’un coup',
    body: `<ol>
      <li>Clique sur le bouton ci-dessous. Google affiche la liste des services que Tiroir utilise : Gemini, Gmail, Agenda, Tasks, Docs, Sheets et Slides.</li>
      <li>Vérifie que le projet sélectionné est bien <b>Tiroir</b>, puis clique sur <b>Suivant</b> ou <b>Activer</b>.</li>
      <li>Attends quelques secondes que Google confirme.</li>
    </ol>
    <p>Tous ces services passeront par le compte Google que tu connectes à la fin, comme Drive. Aucune clé à copier.</p>
    <p class="note">Tu peux sauter cette étape : Tiroir te proposera ce bouton plus tard, au moment où un service en aura besoin.</p>`,
  },
  {
    t: 'Rester connecté', s: 'Sinon Google te déconnecte chaque semaine',
    url: 'https://console.cloud.google.com/auth/audience', btn: 'Ouvrir la page « Audience »',
    body: `<p>Tant que ton app est « en test », Google coupe la connexion <b>tous les 7 jours</b>. Pour l'éviter, on la passe « en production ». Elle reste privée : personne ne peut l'utiliser sans connaître ta clé, et Google ne demande aucune vérification pour un usage personnel.</p>
    <ol>
      <li>Dans <b>État de publication</b>, clique sur <b>Publier l'application</b>, puis <b>Confirmer</b>.</li>
      <li>Si Google parle de validation, ignore-le : c'est seulement pour les apps publiques de plus de 100 personnes.</li>
    </ol>
    <p class="note">En te connectant, l'écran « Google n'a pas validé cette application » continuera de s'afficher : c'est normal, clique sur <b>Continuer</b>.</p>`,
  },
  { t: 'Connecter Tiroir', s: 'Dernière étape', last: true },
];

function showSetup() {
  $('.setup')?.remove();
  let step = Math.min(store.get('setupStep', 0), SETUP_STEPS.length - 1);
  document.body.insertAdjacentHTML('beforeend', '<div class="setup wiz"></div>'); keepWinctlOnTop();
  const root = $('.setup');
  const paint = () => {
    store.set('setupStep', step);
    const st = SETUP_STEPS[step];
    root.innerHTML = `<aside class="wsteps"><div class="brand"><span class="mark"></span>Tiroir</div><p class="wsub">Relier ton Google Drive</p>
      <ol>${SETUP_STEPS.map((x, i) => `<li class="${i === step ? 'on' : i < step ? 'done' : ''}" data-go="${i}"><span class="dot">${i < step ? ic('Check') : i}</span><span><b>${esc(x.t)}</b><small>${esc(x.s)}</small></span></li>`).join('')}</ol></aside>
      <section class="wbody"><div class="wcard">
        <p class="wnum">${step === 0 ? 'Avant de commencer' : `Étape ${step} sur ${SETUP_STEPS.length - 1}`}</p>
        <h1>${esc(st.t)}</h1>
        ${st.last ? connectForm() : st.body}
        ${st.url ? `<p><button class="btn primary big" data-open="${esc(st.url)}">${ic('ExternalLink')}${esc(st.btn)}</button></p>` : ''}
        <div class="wnav">${step ? `<button class="btn" data-prev>${ic('ChevronLeft')}Retour</button>` : '<span></span>'}${st.last ? '' : `<button class="btn ${st.url ? '' : 'primary'}" data-next>${step === 0 ? 'Commencer' : 'C’est fait, étape suivante'}${ic('ChevronRight')}</button>`}</div>
      </div></section>`;
    if (st.last) wireConnect(root);
  };
  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-open],[data-next],[data-prev],[data-go]'); if (!t) return;
    if (t.dataset.open) return openOut(t.dataset.open);
    step = t.hasAttribute('data-next') ? step + 1 : t.hasAttribute('data-prev') ? step - 1 : +t.dataset.go;
    paint();
  });
  paint();
}

function connectForm() {
  return `<p>Donne à Tiroir le fichier JSON téléchargé à l'étape 5. Tu peux le glisser ici ou cliquer pour le choisir.</p>
    <label class="jsondrop" id="jsonDrop"><input type="file" accept=".json,application/json" hidden id="jsonPick">${ic('FileCode')}<span id="jsonLabel">Glisse ici <code>client_secret_….json</code><br><small>ou clique pour le choisir dans tes Téléchargements</small></span></label>
    <details class="manual"><summary>Je n'ai pas le fichier, je préfère copier-coller</summary>
      <label>ID client<input name="clientId" id="cid" value="${esc(state?.clientId || '')}" placeholder="123456-abc.apps.googleusercontent.com" spellcheck="false"></label>
      <label>Code secret du client<input name="clientSecret" id="csec" type="password" placeholder="${state?.configured ? 'déjà enregistré' : 'GOCSPX-…'}"></label>
    </details>
    <div class="err" id="setupErr"></div>
    <p><button class="btn primary big" id="connectBtn" ${state?.configured ? '' : 'disabled'}>${ic('Link')}Se connecter avec Google</button></p>
    <div class="what">
      <b>Ce qui va se passer</b>
      <ol>
        <li>Ton navigateur s'ouvre sur Google : choisis ton compte.</li>
        <li>Google affiche <b>« Google n'a pas validé cette application »</b>. C'est normal, c'est ta propre app : clique sur <b>Continuer</b>.</li>
        <li>Clique sur <b>Tout sélectionner</b> (Drive, Gemini, Gmail, Agenda, Tâches), puis <b>Continuer</b>.</li>
        <li>La page affiche « Le compte … est relié à Tiroir » : reviens ici, ton Drive s'affiche tout seul et les autres services sont prêts.</li>
      </ol>
    </div>`;
}

const OAUTH_HELP = [
  [/access_denied/i, 'Google a refusé l’accès. Vérifie que ton adresse Gmail est bien dans les utilisateurs tests (étape 4), puis réessaie.'],
  [/invalid_client|unauthorized/i, 'Google ne reconnaît pas cette clé. Re-télécharge le fichier JSON (étape 5) et redonne-le à Tiroir.'],
  [/redirect_uri|invalid_request/i, 'La clé n’est pas du type « Application de bureau ». Crée un nouveau client de ce type (étape 5).'],
  [/expir/i, 'La connexion n’a pas été terminée dans le navigateur à temps. Clique de nouveau sur « Se connecter avec Google ».'],
];
const oauthMsg = (e) => OAUTH_HELP.find(([re]) => re.test(cleanErr(e)))?.[1] || cleanErr(e);

function wireConnect(root) {
  const err = (m) => { $('#setupErr', root).textContent = m || ''; };
  const ready = () => { $('#connectBtn', root).disabled = !(($('#cid', root).value.trim() && ($('#csec', root).value.trim() || state?.configured))); };
  async function readJson(file) {
    err();
    try {
      const j = JSON.parse(await file.text());
      if (j.web) throw new Error('Ce fichier est pour une « Application Web ». Il faut un client « Application de bureau » (étape 5).');
      const c = j.installed;
      if (!c?.client_id || !c?.client_secret) throw new Error('Ce fichier ne contient pas de clé Google. Prends le fichier client_secret_….json de l’étape 5.');
      $('#cid', root).value = c.client_id; $('#csec', root).value = c.client_secret;
      $('#jsonLabel', root).innerHTML = `<b>Fichier reconnu</b><br><small>${esc(c.client_id.slice(0, 22))}…</small>`;
      $('#jsonDrop', root).classList.add('ok');
      ready();
    } catch (e) { err(e instanceof SyntaxError ? 'Ce fichier n’est pas un fichier JSON valide.' : e.message); }
  }
  $('#jsonPick', root).onchange = (e) => e.target.files[0] && readJson(e.target.files[0]);
  const drop = $('#jsonDrop', root);
  drop.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) readJson(f); });
  root.addEventListener('input', ready);
  $('#connectBtn', root).onclick = async (e) => {
    const b = e.currentTarget; err();
    const clientId = $('#cid', root).value.trim(), clientSecret = $('#csec', root).value.trim();
    if (!/\.apps\.googleusercontent\.com$/.test(clientId)) return err('L’ID client doit se terminer par « .apps.googleusercontent.com ».');
    b.disabled = true; b.innerHTML = `${ic('Loader')}Termine la connexion dans ton navigateur…`;
    const tab = window.tiroirWin ? null : window.open('about:blank', '_blank'); // in a browser, open during the click or popup blockers stop it
    try {
      await api.configSet({ clientId, clientSecret });
      const url = await api.authStart();
      if (tab) tab.location = url; else openOut(url); // in the app window this opens the real browser
      await api.authWait();
      store.set('setupStep', 0); state = await api.state(); boot();
    } catch (x) { tab?.close(); err(oauthMsg(x)); b.disabled = false; b.innerHTML = `${ic('Link')}Se connecter avec Google`; }
  };
}

// Electron resolves drag/no-drag regions in document order: the window buttons must stay last in <body>.
function keepWinctlOnTop() { const w = $('#winctl'); if (w) document.body.append(w); }

// ---------- desktop shell: our own window buttons (only exists inside the Tiroir app window) ----------
if (window.tiroirWin) {
  const W_ICONS = {
    min: '<svg viewBox="0 0 10 10"><path d="M0 5.5h10"/></svg>',
    max: '<svg viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9"/></svg>',
    restore: '<svg viewBox="0 0 10 10"><rect x=".5" y="2.5" width="7" height="7"/><path d="M2.5 2.5V.5h7v7h-2"/></svg>',
    close: '<svg viewBox="0 0 10 10"><path d="M.5.5l9 9M9.5.5l-9 9"/></svg>',
  };
  document.body.classList.add('app');
  document.body.insertAdjacentHTML('beforeend', `<div id="winctl"><button data-w="min" title="Réduire">${W_ICONS.min}</button><button data-w="max" title="Agrandir">${W_ICONS.max}</button><button data-w="close" title="Fermer">${W_ICONS.close}</button></div>`);
  $('#winctl').onclick = (e) => { const b = e.target.closest('[data-w]'); if (b) window.tiroirWin[b.dataset.w](); };
  window.tiroirWin.onState(({ max, focus }) => {
    document.body.classList.toggle('blurred', !focus);
    const b = $('#winctl [data-w="max"]'); b.innerHTML = max ? W_ICONS.restore : W_ICONS.max; b.title = max ? 'Restaurer' : 'Agrandir';
  });
}

events();
boot().catch(fail);
