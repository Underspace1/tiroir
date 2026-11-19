// In-memory fake of the Google endpoints Tiroir uses (OAuth token, Drive v3, resumable upload, thumbnails, Gemini).
// Used by test/api.test.js and for clicking through the UI without a real account:  node test/mock-drive.js
const http = require('http');
const fs = require('fs');
const path = require('path');

const FOLDER = 'application/vnd.google-apps.folder';
// Demo photos: any folder of .jpg given in TIROIR_MOCK_WALLS (e.g. your own test images), otherwise a 1-pixel image.
const WALLS = process.env.TIROIR_MOCK_WALLS && fs.existsSync(process.env.TIROIR_MOCK_WALLS)
  ? fs.readdirSync(process.env.TIROIR_MOCK_WALLS).filter((f) => /\.jpe?g$/i.test(f)).sort().map((f) => path.join(process.env.TIROIR_MOCK_WALLS, f))
  : [];
const TINY_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

function createMock({ video = process.env.TIROIR_MOCK_VIDEO, photos = 40 } = {}) {
  const files = new Map();
  const log = [];
  const gemini = { script: [], calls: [], auth: [], models: ['gemini-test'], retired: [] };
  const h = (name, value) => ({ name, value });
  const b64 = (s) => Buffer.from(s).toString('base64url');
  const google = {
    calls: [], sent: [], drafts: [], tasks: [], events: [
      { id: 'e1', status: 'confirmed', summary: 'Dentiste', start: { dateTime: '2026-11-16T09:00:00+01:00' }, end: { dateTime: '2026-11-16T09:30:00+01:00' } },
    ],
    mail: [
      { id: 'm1', threadId: 't1', labelIds: ['INBOX', 'UNREAD'], internalDate: String(Date.now() - 3.6e6), snippet: 'Voici votre facture d&#39;octobre',
        payload: { mimeType: 'multipart/mixed', headers: [h('From', 'EDF <factures@edf.example>'), h('To', 'testeur@example.com'), h('Subject', 'Votre facture'), h('Message-ID', '<m1@edf>')],
          parts: [
            { partId: '0', mimeType: 'text/html', headers: [h('Content-Type', 'text/html; charset=utf-8')], body: { data: b64('<p>Bonjour, <a href="https://edf.example">votre facture</a></p><script>alert(1)</script>') } },
            { partId: '1', mimeType: 'application/pdf', filename: 'facture-oct.pdf', headers: [], body: { attachmentId: 'att1', size: 12 } },
          ] } },
      { id: 'm2', threadId: 't2', labelIds: ['INBOX'], internalDate: String(Date.now() - 8.6e7), snippet: 'On se voit demain ?',
        payload: { mimeType: 'text/plain', headers: [h('From', '"Léa" <lea@example.com>'), h('Subject', 'Demain'), h('Message-ID', '<m2@lea>'), h('Content-Type', 'text/plain; charset=utf-8')], body: { data: b64('On se voit demain ?\nLéa') } } },
    ],
  }; // tests push canned Gemini responses into script
  let seq = 0, base = '';
  const now = Date.now();
  const add = (f) => {
    const id = f.id || 'id' + ++seq;
    const rec = { id, parents: ['root'], trashed: false, starred: false, shared: false, owners: [{ displayName: 'Moi', me: true }], modifiedTime: new Date(now - seq * 3.6e6).toISOString(), ...f, id };
    if (rec.mimeType !== FOLDER && rec.content == null && !rec.videoFile) rec.content = Buffer.from(`contenu de ${rec.name}`);
    if (rec.content) rec.size = String(rec.content.length);
    rec.fileExtension = rec.mimeType === FOLDER ? undefined : (rec.name.match(/\.(\w+)$/) || [])[1];
    files.set(id, rec);
    return rec;
  };
  const wall = (i) => (WALLS.length ? fs.readFileSync(WALLS[i % WALLS.length]) : TINY_JPEG);

  // --- seed: a believable Drive ---
  add({ id: 'root', name: 'My Drive', mimeType: FOLDER, parents: undefined });
  const cours = add({ id: 'cours', name: 'Cours 2026', mimeType: FOLDER });
  const photosF = add({ id: 'photos', name: 'Photos vacances', mimeType: FOLDER });
  add({ id: 'factures', name: 'Factures', mimeType: FOLDER });
  const roblox = add({ id: 'roblox', name: 'Projets Roblox', mimeType: FOLDER });
  add({ id: 'sub', name: 'Chapitre 1', mimeType: FOLDER, parents: [cours.id] });
  add({ id: 'deep', name: 'Exercices', mimeType: FOLDER, parents: ['sub'] });
  add({ id: 'notes', name: 'Notes de cours', mimeType: 'application/vnd.google-apps.document', parents: [cours.id], starred: true, content: Buffer.from('Chapitre 1 : les fractions.') });
  add({ id: 'budget', name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet', content: Buffer.from('mois,total\noct,120') });
  add({ id: 'pdf1', name: 'facture-octobre.pdf', mimeType: 'application/pdf', parents: ['factures'] });
  add({ id: 'zip1', name: 'backup.zip', mimeType: 'application/zip' });
  add({ id: 'exe1', name: 'setup.exe', mimeType: 'application/x-msdownload' });
  add({ id: 'shvid', name: 'clip-de-lea.mp4', mimeType: 'video/mp4', parents: undefined, shared: true, owners: [{ displayName: 'Léa', me: false }] }); // shared with me, not in my Drive
  add({ id: 'html1', name: 'page.html', mimeType: 'text/html', content: Buffer.from('<script>alert(1)</script>') });
  add({ id: 'ete', name: "l'été à Nice.txt", mimeType: 'text/plain' });
  add({ id: 'lua', name: 'main.lua', mimeType: 'text/x-lua', parents: [roblox.id] });
  for (let i = 0; i < photos; i++) {
    const port = i % 3 === 1;
    add({ id: 'img' + i, name: `IMG_${4800 + i}.jpg`, mimeType: 'image/jpeg', parents: [photosF.id], content: wall(i), starred: i % 11 === 0, thumbnail: true,
      imageMediaMetadata: port ? { width: 3024, height: 4032 } : { width: 4032, height: i % 5 === 0 ? 1800 : 3024 } });
  }
  if (video && fs.existsSync(video)) {
    for (let i = 0; i < 3; i++) add({ id: 'vid' + i, name: `clip-${i}.mp4`, mimeType: 'video/mp4', parents: [photosF.id], videoFile: video, size: String(fs.statSync(video).size), thumbnail: true, videoMediaMetadata: { width: 1920, height: 1080, durationMillis: 14000 + i * 61000 } });
  }
  for (let i = 0; i < 1500; i++) add({ id: 'bulk' + i, name: `log-${String(i).padStart(4, '0')}.txt`, mimeType: 'text/plain', parents: ['bulk'] });
  add({ id: 'bulk', name: 'Beaucoup de fichiers', mimeType: FOLDER });

  const pub = (f) => {
    const { content, thumbnail, videoFile, ...m } = f;
    if (thumbnail) m.thumbnailLink = `${base}/lh3/${f.id}=s220`;
    m.webViewLink = `https://drive.google.com/file/d/${f.id}/view`;
    return m;
  };
  const bytesOf = (f) => (f.videoFile ? fs.readFileSync(f.videoFile) : f.content);

  // Drive query language -> JS predicate (enough of it for what Tiroir sends).
  function predicate(q) {
    const strs = [];
    const lit = (s) => { strs.push(s.replace(/\\'/g, "'").replace(/\\\\/g, '\\')); return `S[${strs.length - 1}]`; };
    let js = (q || 'true').replace(/'((?:\\.|[^'\\])*)'/g, (_, s) => lit(s));
    js = js
      .replace(/(S\[\d+\]) in parents/g, '(f.parents||[]).includes($1)')
      .replace(/S\[\d+\] in owners/g, '(f.owners||[]).some((o) => o.me)')
      .replace(/mimeType contains (S\[\d+\])/g, 'f.mimeType.includes($1)')
      .replace(/mimeType != (S\[\d+\])/g, 'f.mimeType !== $1')
      .replace(/mimeType = (S\[\d+\])/g, 'f.mimeType === $1')
      .replace(/(?:name|fullText) contains (S\[\d+\])/g, 'f.name.toLowerCase().includes($1.toLowerCase())')
      .replace(/trashed = (true|false)/g, 'f.trashed === $1')
      .replace(/starred = true/g, 'f.starred === true')
      .replace(/sharedWithMe = true/g, 'f.shared === true')
      .replace(/ and /g, ' && ').replace(/ or /g, ' || ');
    if (/[^\w\s()[\]|&.!=,'"<>-]/.test(js.replace(/S\[\d+\]/g, ''))) throw new Error('query not understood: ' + q);
    const fn = new Function('f', 'S', `return ${js};`);
    return (f) => fn(f, strs);
  }
  const body = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
  const json = (res, code, o, h = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
  const sessions = new Map();

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, base);
    const p = u.pathname;
    log.push({ method: req.method, path: p, query: Object.fromEntries(u.searchParams), range: req.headers.range });
    try {
      if (p === '/token') { // code or refresh token 'second' belongs to a second Google account
        const b = new URLSearchParams(String(await body(req)));
        const second = b.get('code') === 'second' || b.get('refresh_token') === 'second';
        // the first account was linked before Tiroir asked for Gemini; the second one granted it
        const scope = second ? 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/generative-language.retriever openid' : 'https://www.googleapis.com/auth/drive openid';
        return json(res, 200, { access_token: second ? 'tok2' : 'tok', expires_in: 3600, scope, ...(b.get('code') ? { refresh_token: second ? 'second' : 'r' } : {}) });
      }
      if (p.startsWith('/lh3/')) {
        const id = p.slice(5).replace(/=s\d+$/, '');
        if (req.headers.authorization !== 'Bearer tok') return json(res, 403, {});
        const f = files.get(id);
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        return res.end(f?.mimeType.startsWith('image/') ? f.content : wall(id.length));
      }
      if (p.startsWith('/gemini/')) {
        const b = req.method === 'POST' ? JSON.parse(await body(req)) : null;
        gemini.auth.push(req.headers['x-goog-api-key'] ? 'key:' + req.headers['x-goog-api-key'] : req.headers.authorization);
        // like Google: an OAuth token without the Gemini scope is refused
        if (!req.headers['x-goog-api-key'] && req.headers.authorization !== 'Bearer tok2') return json(res, 403, { error: { code: 403, message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } });
        if (p.endsWith('/models')) return json(res, 200, { models: gemini.models.map((id) => ({ name: 'models/' + id, displayName: id, supportedGenerationMethods: ['generateContent'] })) });
        const asked = (/models\/([^:]+):/.exec(p) || [])[1];
        if (gemini.retired.includes(asked)) return json(res, 404, { error: { code: 404, message: `This model models/${asked} is no longer available to new users. Please update your code to use models/gemini-3.8-flash.` } });
        gemini.models_used = [...(gemini.models_used || []), asked];
        gemini.calls.push(b);
        const next = gemini.script.shift();
        if (next?.__error) return json(res, next.__error.code, { error: next.__error });
        return json(res, 200, next || { candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }] });
      }
      if (p.startsWith('/upload-session/')) { // like Google: the session URL itself is the credential
        const s = sessions.get(p.split('/').pop());
        const buf = await body(req);
        if (buf.length !== s.size) return json(res, 400, { error: { message: `size ${buf.length} != ${s.size}` } });
        const ext = (s.meta.name.match(/\.(\w+)$/) || [])[1]?.toLowerCase();
        const mime = s.meta.mimeType || { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', mp4: 'video/mp4', txt: 'text/plain', pdf: 'application/pdf' }[ext] || 'application/octet-stream';
        return json(res, 200, pub(add({ name: s.meta.name, parents: s.meta.parents, mimeType: mime, content: buf, uploadType: s.type })));
      }
      // --- Gmail, Agenda, Tasks, Docs/Sheets/Slides: just enough of each API for Tiroir ---
      const svc = /^\/(gmail|calendar|tasks|docs|sheets|slides)\/(.*)$/.exec(p);
      if (svc) {
        if (!/^Bearer tok2?$/.test(req.headers.authorization || '')) return json(res, 401, { error: { message: 'no auth' } });
        const b = ['POST', 'PUT', 'PATCH'].includes(req.method) ? JSON.parse(String(await body(req)) || '{}') : null;
        const G = google; const [, api_, rest] = svc;
        G.calls.push({ api: api_, method: req.method, path: rest, query: Object.fromEntries(u.searchParams), body: b });
        if (u.searchParams.get('q') === 'OFF') return json(res, 403, { error: { code: 403, message: 'Gmail API has not been used in project 123 before or it is disabled.', status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } });
        if (u.searchParams.get('q') === 'NOSCOPE') return json(res, 403, { error: { code: 403, message: 'Request had insufficient authentication scopes.', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } });
        if (api_ === 'gmail') {
          if (rest === 'messages' && req.method === 'GET') return json(res, 200, { messages: G.mail.map((m) => ({ id: m.id, threadId: m.threadId })) });
          if (rest === 'messages/send') { G.sent.push(Buffer.from(b.raw, 'base64url').toString()); return json(res, 200, { id: 'sent' + G.sent.length }); }
          let mm;
          if ((mm = /^messages\/([^/]+)$/.exec(rest))) { const m = G.mail.find((x) => x.id === mm[1]); return m ? json(res, 200, m) : json(res, 404, { error: { message: 'not found' } }); }
          if ((mm = /^messages\/([^/]+)\/attachments\/([^/]+)$/.exec(rest))) return json(res, 200, { data: Buffer.from('%PDF facture').toString('base64url'), size: 12 });
          if ((mm = /^messages\/([^/]+)\/(modify|trash)$/.exec(rest))) return json(res, 200, { id: mm[1] });
          if (rest === 'messages/send') { G.sent.push(Buffer.from(b.raw, 'base64url').toString()); return json(res, 200, { id: 'sent' + G.sent.length }); }
          if (rest === 'drafts') { G.drafts.push(Buffer.from(b.message.raw, 'base64url').toString()); return json(res, 200, { id: 'd' + G.drafts.length }); }
        }
        if (api_ === 'calendar') {
          if (rest === 'users/me/calendarList') return json(res, 200, { items: [{ id: 'primary@x', summary: 'Perso', primary: true, backgroundColor: '#e57373', accessRole: 'owner' }] });
          if (/^calendars\/[^/]+\/events$/.test(rest) && req.method === 'GET') return json(res, 200, { items: G.events });
          if (/^calendars\/[^/]+\/events$/.test(rest) && req.method === 'POST') { const e = { id: 'ev' + (G.events.length + 1), status: 'confirmed', ...b }; G.events.push(e); return json(res, 200, e); }
          if (/^calendars\/[^/]+\/events\/[^/]+$/.test(rest) && req.method === 'DELETE') { res.writeHead(204); return res.end(); }
        }
        if (api_ === 'tasks') {
          if (rest === 'users/@me/lists') return json(res, 200, { items: [{ id: 'L1', title: 'Mes tâches' }] });
          if (rest === 'lists/L1/tasks' && req.method === 'GET') return json(res, 200, { items: G.tasks });
          if (rest === 'lists/L1/tasks' && req.method === 'POST') { const t = { id: 't' + (G.tasks.length + 1), status: 'needsAction', position: String(G.tasks.length), ...b }; G.tasks.push(t); return json(res, 200, t); }
          let mm;
          if ((mm = /^lists\/L1\/tasks\/([^/]+)$/.exec(rest))) {
            const t = G.tasks.find((x) => x.id === mm[1]);
            if (req.method === 'PATCH') { Object.assign(t, b); return json(res, 200, t); }
            if (req.method === 'DELETE') { G.tasks.splice(G.tasks.indexOf(t), 1); res.writeHead(204); return res.end(); }
          }
        }
        if (api_ === 'sheets') return json(res, 200, req.method === 'GET' ? { values: [['mois', 'total'], ['oct', '120']] } : { updatedCells: (b.values || []).flat().length });
        if (api_ === 'docs') return json(res, 200, req.method === 'GET' ? { body: { content: [{ endIndex: 1 }, { endIndex: 30 }] } } : { replies: [] });
        if (api_ === 'slides') return json(res, 200, req.method === 'POST' && rest === 'presentations' ? { presentationId: 'pres1', slides: [{ objectId: 'p0' }] } : { replies: [] });
        return json(res, 404, { error: { message: 'not mocked ' + p } });
      }
      if (req.headers.authorization === 'Bearer tok2') { // second account: its own tiny Drive
        if (p.endsWith('/about')) return json(res, 200, { user: { displayName: 'Deux', emailAddress: 'deux@example.com' }, storageQuota: { limit: '100', usage: '1' } });
        if (p === '/drive/v3/files' && req.method === 'GET') return json(res, 200, { files: [{ id: 'deux1', name: 'Drive de Deux.txt', mimeType: 'text/plain', parents: ['root'] }] });
      }
      if (req.headers.authorization !== 'Bearer tok') return json(res, 401, { error: { message: 'no auth' } });
      if (p === '/upload') {
        const meta = JSON.parse(await body(req));
        const sid = 's' + ++seq; sessions.set(sid, { meta, size: Number(req.headers['x-upload-content-length']), type: req.headers['x-upload-content-type'] });
        res.writeHead(200, { location: `${base}/upload-session/${sid}` }); return res.end();
      }
      const m = /^\/drive\/v3\/(files|about|drives)(?:\/([^/]+))?(?:\/(copy|export))?$/.exec(p);
      if (!m) return json(res, 404, { error: { message: 'not found ' + p } });
      if (m[1] === 'about') return json(res, 200, { user: { displayName: 'Testeur', emailAddress: 'testeur@example.com' }, storageQuota: { limit: String(15 * 2 ** 30), usage: String(9.1 * 2 ** 30) } });
      if (m[1] === 'drives') return json(res, 200, { drives: [] });
      const id = m[2] && decodeURIComponent(m[2]);
      if (!id && req.method === 'GET') {
        const pred = predicate(u.searchParams.get('q'));
        let all = [...files.values()].filter((f) => pred(f));
        if ((u.searchParams.get('orderBy') || '').startsWith('folder')) all.sort((a, b) => (b.mimeType === FOLDER) - (a.mimeType === FOLDER) || a.name.localeCompare(b.name));
        // Like a huge real Drive: heavy searches first answer with empty pages that only carry a nextPageToken.
        const slow = Number(process.env.TIROIR_MOCK_EMPTY_PAGES || 0); const tok = u.searchParams.get('pageToken') || '';
        if (slow && /video\//.test(u.searchParams.get('q') || '') && (!tok || tok.startsWith('e'))) {
          const n = tok ? Number(tok.slice(1)) : 0;
          await new Promise((r) => setTimeout(r, 600));
          return json(res, 200, { files: [], nextPageToken: n + 1 < slow ? 'e' + (n + 1) : '0' });
        }
        const size = Number(u.searchParams.get('pageSize') || 100); const start = Number(u.searchParams.get('pageToken') || 0);
        const page = all.slice(start, start + size);
        return json(res, 200, { files: page.map(pub), ...(start + size < all.length ? { nextPageToken: String(start + size) } : {}) });
      }
      if (!id && req.method === 'POST') { const b = JSON.parse(await body(req)); return json(res, 200, pub(add({ name: b.name, mimeType: b.mimeType, parents: b.parents }))); }
      const f = files.get(id);
      if (!f) return json(res, 404, { error: { message: 'File not found: ' + id } });
      if (m[3] === 'copy') { const b = JSON.parse(await body(req)); return json(res, 200, pub(add({ ...f, id: undefined, name: b.name || f.name, parents: b.parents, content: f.content }))); }
      if (m[3] === 'export') { res.writeHead(200, { 'content-type': u.searchParams.get('mimeType') }); return res.end(f.content); }
      if (req.method === 'PATCH') {
        const b = JSON.parse((await body(req)) || '{}');
        const add_ = u.searchParams.get('addParents'), rem = u.searchParams.get('removeParents');
        if (add_ || rem) f.parents = [...f.parents.filter((x) => !(rem || '').split(',').includes(x)), ...(add_ ? [add_] : [])];
        Object.assign(f, b); f.modifiedTime = new Date().toISOString();
        return json(res, 200, pub(f));
      }
      if (req.method === 'DELETE') { files.delete(id); res.writeHead(204); return res.end(); }
      if (u.searchParams.get('alt') === 'media') {
        const buf = bytesOf(f);
        const r = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
        if (r) {
          const a = Number(r[1]), b = Math.min(buf.length - 1, r[2] ? Number(r[2]) : a + 2 * 2 ** 20);
          res.writeHead(206, { 'content-type': f.mimeType, 'content-length': b - a + 1, 'content-range': `bytes ${a}-${b}/${buf.length}`, 'accept-ranges': 'bytes' });
          return res.end(buf.subarray(a, b + 1));
        }
        res.writeHead(200, { 'content-type': f.mimeType, 'content-length': buf.length, 'accept-ranges': 'bytes' });
        return res.end(buf);
      }
      return json(res, 200, pub(f));
    } catch (e) { json(res, 500, { error: { message: e.message } }); }
  });

  return {
    files, log, gemini, google, server,
    listen: (port = 0) => new Promise((r) => server.listen(port, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(base); })),
    env: () => ({
      TIROIR_DRIVE: `${base}/drive/v3/`, TIROIR_UPLOAD: `${base}/upload`, TIROIR_TOKEN_URL: `${base}/token`, TIROIR_GEMINI: `${base}/gemini/`,
      TIROIR_GMAIL: `${base}/gmail/`, TIROIR_CALENDAR: `${base}/calendar/`, TIROIR_TASKS: `${base}/tasks/`, TIROIR_DOCS: `${base}/docs/`, TIROIR_SHEETS: `${base}/sheets/`, TIROIR_SLIDES: `${base}/slides/`,
    }),
  };
}

module.exports = { createMock };

// Standalone: start the fake Drive + Tiroir on port 4171 to click through the UI.
if (require.main === module) {
  (async () => {
    const os = require('os');
    const m = createMock();
    await m.listen(Number(process.env.MOCK_PORT || 0));
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tiroir-demo-'));
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ clientId: 'demo', clientSecret: 'demo', refreshToken: 'demo', geminiKey: 'demo', geminiModel: 'gemini-test', key: 'demo0000demo' }));
    Object.assign(process.env, m.env(), { TIROIR_DATA: data, TIROIR_PORT: process.env.TIROIR_PORT || '4171', TIROIR_NO_OPEN: '1', TIROIR_NO_SHELL: '1', TIROIR_DOWNLOADS: fs.mkdtempSync(path.join(os.tmpdir(), 'tiroir-dl-')) });
    require('../server.js');
    console.log(`Démo : http://localhost:${process.env.TIROIR_PORT}/?k=demo0000demo`);
  })();
}
