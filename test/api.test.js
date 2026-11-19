// End-to-end tests of server.js against the fake Google endpoints in mock-drive.js.  Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createMock } = require('./mock-drive');

const PORT = 4190 + Math.floor(Math.random() * 300);
const KEY = 'ab'.repeat(24);
const ORIGIN = `http://localhost:${PORT}`;
let mock, DL;

test.before(async () => {
  mock = createMock({ photos: 12 });
  await mock.listen();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tiroir-test-'));
  DL = fs.mkdtempSync(path.join(os.tmpdir(), 'tiroir-dl-'));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ clientId: 'c', clientSecret: 's', refreshToken: 'r', geminiKey: 'g', geminiModel: 'gemini-test', key: KEY }));
  Object.assign(process.env, mock.env(), { TIROIR_DATA: data, TIROIR_PORT: String(PORT), TIROIR_NO_OPEN: '1', TIROIR_NO_SHELL: '1', TIROIR_DOWNLOADS: DL });
  const { server } = require('../server.js');
  if (!server.listening) await new Promise((r) => server.once('listening', r));
});
test.after(() => { const { server } = require('../server.js'); server.closeAllConnections(); server.close(); mock.server.closeAllConnections(); mock.server.close(); });

const auth = { cookie: `tiroir=${KEY}`, 'x-tiroir': '1', 'content-type': 'application/json' };
async function call(name, ...args) {
  const r = await fetch(`${ORIGIN}/api/${name}`, { method: 'POST', headers: auth, body: JSON.stringify(args) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return j;
}
const get = (p, h = {}) => fetch(ORIGIN + p, { headers: { cookie: auth.cookie, ...h }, redirect: 'manual' });
const names = (fs_) => fs_.map((f) => f.name);
const rawHost = (host) => new Promise((r) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/state', headers: { host } }, (res) => { res.resume(); r(res.statusCode); }));

test('security: data routes need the session, foreign hosts and cross-site writes are refused', async () => {
  assert.equal((await fetch(`${ORIGIN}/api/state`, { method: 'POST', headers: { 'x-tiroir': '1' } })).status, 401);
  assert.equal((await fetch(`${ORIGIN}/thumb/img1`)).status, 401);
  assert.equal((await fetch(`${ORIGIN}/api/state`, { method: 'POST', headers: { cookie: auth.cookie } })).status, 404, 'no custom header = no write');
  assert.equal(await rawHost('evil.example:' + PORT), 403, 'DNS rebinding guard');
  assert.equal((await get('/node_modules/../server.js')).status, 404);
  assert.equal((await get('/node_modules/lucide/package.json')).status, 404, 'only whitelisted module folders');
  const bad = await fetch(`${ORIGIN}/?k=nope`, { redirect: 'manual' });
  assert.equal(bad.status, 401);
  const good = await fetch(`${ORIGIN}/?k=${KEY}`, { redirect: 'manual' });
  assert.equal(good.status, 302);
  assert.match(good.headers.get('set-cookie'), /tiroir=.*HttpOnly.*SameSite=Strict/);
  const page = await fetch(ORIGIN + '/');
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(await call('session'), KEY);
});

test('list: root shows folders first, pagination returns every file', async () => {
  const root = await call('driveList', { kind: 'folder', id: 'root' });
  assert.deepEqual(names(root.files.slice(0, 5)), ['Beaucoup de fichiers', 'Cours 2026', 'Factures', 'Photos vacances', 'Projets Roblox']);
  const fromPage = await call('driveList', { kind: 'folder', id: 'root' }, null); // exactly what the browser sends (undefined -> null in JSON)
  assert.equal(fromPage.files.length, root.files.length);
  assert.ok(!mock.log.some((l) => l.query.pageToken === 'null'), 'no literal "null" page token sent to Google');
  const p1 = await call('driveList', { kind: 'folder', id: 'bulk' });
  assert.equal(p1.files.length, 1000);
  const p2 = await call('driveList', { kind: 'folder', id: 'bulk' }, p1.next);
  assert.equal(p2.files.length, 500);
  assert.equal(p2.next, null);
});

test('views: types, starred, search with an apostrophe, path of a nested folder', async () => {
  const imgs = (await call('driveList', { kind: 'type', type: 'image' })).files;
  assert.equal(imgs.length, 12);
  assert.ok(imgs.every((f) => f.mimeType === 'image/jpeg'));
  assert.ok(imgs.every((f) => f.thumbnailLink && f.imageMediaMetadata.width));
  const starred = names((await call('driveList', { kind: 'starred' })).files);
  assert.ok(starred.includes('Notes de cours') && starred.includes('IMG_4800.jpg'));
  assert.deepEqual(names((await call('driveList', { kind: 'search', text: "l'été" })).files), ["l'été à Nice.txt"]);
  await assert.rejects(call('driveList', { kind: 'type', type: "image') or (true" }), /Type inconnu/);
  assert.deepEqual(names(await call('drivePath', 'deep')), ['Mon Drive', 'Cours 2026', 'Chapitre 1', 'Exercices']);
});

test('mkdir, rename, star, trash, restore, delete', async () => {
  const f = await call('driveMkdir', 'Test A', 'root');
  assert.equal(mock.files.get(f.id).mimeType, 'application/vnd.google-apps.folder');
  await call('driveRename', f.id, 'Test B');
  assert.equal(mock.files.get(f.id).name, 'Test B');
  await call('driveStar', [{ id: f.id }], true);
  assert.equal(mock.files.get(f.id).starred, true);
  await call('driveTrash', [{ id: f.id }]);
  assert.equal(mock.files.get(f.id).trashed, true);
  assert.ok(names((await call('driveList', { kind: 'trash' })).files).includes('Test B'));
  await call('driveRestore', [{ id: f.id }]);
  assert.equal(mock.files.get(f.id).trashed, false);
  await call('driveDelete', [{ id: f.id }]);
  assert.equal(mock.files.has(f.id), false);
});

test('move replaces the parent; copy duplicates a whole folder tree', async () => {
  await call('driveMove', [{ id: 'zip1' }], 'factures');
  assert.deepEqual(mock.files.get('zip1').parents, ['factures']);
  await call('driveCopy', [{ id: 'cours' }], 'roblox');
  const copy = [...mock.files.values()].find((f) => f.name === 'Cours 2026' && f.parents?.[0] === 'roblox');
  assert.ok(copy, 'folder copied');
  const kids = [...mock.files.values()].filter((f) => f.parents?.[0] === copy.id);
  assert.deepEqual(names(kids).sort(), ['Chapitre 1', 'Notes de cours']);
  const ch = kids.find((f) => f.name === 'Chapitre 1');
  assert.ok([...mock.files.values()].some((f) => f.name === 'Exercices' && f.parents?.[0] === ch.id), 'grand-child copied');
  assert.deepEqual(mock.files.get('cours').parents, ['root'], 'original untouched');
});

test('upload: bytes arrive intact, nested folders are created once even in parallel', async () => {
  const data = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251));
  const up = (p) => fetch(`${ORIGIN}/upload?parent=roblox&batch=b1&path=${encodeURIComponent(p)}`, { method: 'POST', headers: { cookie: auth.cookie, 'x-tiroir': '1' }, body: data });
  const rs = await Promise.all([up('Album/2026/a.jpg'), up('Album/2026/b.jpg'), up('Album/c.txt')]);
  for (const r of rs) assert.equal(r.status, 200, await r.clone().text());
  const albums = [...mock.files.values()].filter((f) => f.name === 'Album' && f.parents?.[0] === 'roblox');
  assert.equal(albums.length, 1, 'one Album folder');
  const y = [...mock.files.values()].filter((f) => f.name === '2026' && f.parents?.[0] === albums[0].id);
  assert.equal(y.length, 1, 'one 2026 folder');
  const a = [...mock.files.values()].find((f) => f.name === 'a.jpg');
  assert.equal(a.parents[0], y[0].id);
  assert.ok(a.content.equals(data), 'same bytes');
  assert.equal(a.mimeType, 'image/jpeg');
});

test('download: folder lands in Downloads with sub-folders, Google Docs exported as .docx', async () => {
  const out = await call('driveDownload', [{ id: 'cours' }]);
  assert.equal(out.length, 1);
  assert.ok(fs.existsSync(path.join(out[0], 'Notes de cours.docx')));
  assert.equal(fs.readFileSync(path.join(out[0], 'Notes de cours.docx'), 'utf8'), 'Chapitre 1 : les fractions.');
  assert.ok(fs.statSync(path.join(out[0], 'Chapitre 1', 'Exercices')).isDirectory());
  const again = await call('driveDownload', [{ id: 'cours' }]);
  assert.equal(path.basename(again[0]), 'Cours 2026 (1)', 'never overwrites');
});

test('thumbnails: proxied with auth, then served from memory, never written to disk', async () => {
  const r1 = await get('/thumb/img3?s=400&v=x');
  assert.equal(r1.status, 200);
  const b1 = Buffer.from(await r1.arrayBuffer());
  assert.equal(b1[0], 0xff, 'jpeg');
  const before = mock.log.filter((l) => l.path.startsWith('/lh3/img3')).length;
  await new Promise((r) => setTimeout(r, 100));
  const r2 = await get('/thumb/img3?s=400&v=x');
  assert.ok(Buffer.from(await r2.arrayBuffer()).equals(b1));
  assert.equal(mock.log.filter((l) => l.path.startsWith('/lh3/img3')).length, before, 'second hit from cache');
  assert.equal((await get('/thumb/zip1?s=400')).status, 404, 'no thumbnail for a zip');
  assert.equal(fs.existsSync(path.join(process.env.TIROIR_DATA, 'thumbs')), false, 'no preview stored on disk');
});

test('media: range requests for video seeking, HTML never served as a page', async () => {
  const r = await get('/media/img2', { range: 'bytes=0-9' });
  assert.equal(r.status, 206);
  assert.equal((await r.arrayBuffer()).byteLength, 10);
  assert.match(r.headers.get('content-range'), /^bytes 0-9\//);
  const h = await get('/media/html1');
  assert.match(h.headers.get('content-type'), /^text\/plain/);
  assert.equal(h.headers.get('x-content-type-options'), 'nosniff');
});

test('dl: attachment with the real name, works with ?k= alone (drag-out to other apps)', async () => {
  const r = await fetch(`${ORIGIN}/dl/budget?k=${KEY}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment; filename\*=UTF-8''Budget\.xlsx/);
  assert.equal(await r.text(), 'mois,total\noct,120');
  assert.equal((await fetch(`${ORIGIN}/dl/budget?k=wrong`)).status, 401);
});

test('gemini agent: tool calls run on Drive, trash waits for the page to confirm', async () => {
  mock.gemini.script.push(
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'create_folder', args: { name: 'Rangé', parent_id: 'root' } } }] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'Dossier **Rangé** créé.' }] } }] },
  );
  const r = await call('geminiChat', { history: [{ role: 'user', text: 'range' }], files: [{ id: 'notes' }], agent: true, folder: { id: 'root', name: 'Mon Drive' } });
  assert.equal(r.text, 'Dossier **Rangé** créé.');
  assert.deepEqual(r.log, ['Dossier créé : Rangé']);
  assert.ok([...mock.files.values()].some((f) => f.name === 'Rangé'));
  const first = mock.gemini.calls.at(-2);
  assert.match(first.contents[0].parts[0].text, /Chapitre 1 : les fractions/, 'attached Google Doc sent as text');
  assert.equal(first.tools[0].functionDeclarations.length, 29, 'Drive + Docs/Sheets/Slides + Gmail + Agenda + Tasks tools');

  // trash: the server asks the page through /events, the test answers like the UI would.
  const es = await fetch(`${ORIGIN}/events`, { headers: { cookie: auth.cookie } });
  const reader = es.body.getReader();
  const answer = (async () => {
    let buf = '';
    for (;;) {
      const { value } = await reader.read(); buf += Buffer.from(value).toString();
      const m = /data: (\{.*"confirm".*\})\n/.exec(buf);
      if (m) { const { data } = JSON.parse(m[1]); assert.match(data.detail, /backup\.zip/); return call('confirmAnswer', data.id, false); }
    }
  })();
  mock.gemini.script.push(
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'trash_files', args: { file_ids: ['zip1'] } } }] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'Annulé.' }] } }] },
  );
  const r2 = await call('geminiChat', { history: [{ role: 'user', text: 'supprime backup' }], agent: true });
  await answer; reader.cancel();
  assert.equal(r2.text, 'Annulé.');
  assert.equal(mock.files.get('zip1').trashed, false, 'refused = not trashed');
  assert.equal(mock.gemini.calls.at(-1).contents.at(-1).parts[0].functionResponse.response.result, "refusé par l'utilisateur");
});

test('several Google accounts: add a second Drive, switch between them, remove one', async () => {
  assert.deepEqual(await call('accounts'), [{ email: 'testeur@example.com', name: 'Testeur', active: true }], 'old single-account config migrated');
  const url = new URL(await call('authStart'));
  assert.match(url.searchParams.get('prompt'), /select_account/, 'Google lets the user pick another account');
  const back = await fetch(`${url.searchParams.get('redirect_uri')}/?code=second&state=${url.searchParams.get('state')}`);
  assert.equal(back.status, 200);
  assert.equal(await call('authWait'), 'deux@example.com');
  const list = await call('accounts');
  assert.deepEqual(list.map((a) => [a.email, a.active]), [['testeur@example.com', false], ['deux@example.com', true]]);
  assert.deepEqual(names((await call('driveList', { kind: 'folder', id: 'root' })).files), ['Drive de Deux.txt'], 'requests use the new account');
  await call('accountSwitch', 'testeur@example.com');
  assert.ok(names((await call('driveList', { kind: 'folder', id: 'root' })).files).includes('Cours 2026'), 'back on the first Drive');
  await assert.rejects(call('accountSwitch', 'inconnu@example.com'), /Compte inconnu/);
  await call('accountRemove', 'deux@example.com');
  assert.deepEqual((await call('accounts')).map((a) => a.email), ['testeur@example.com']);
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.TIROIR_DATA, 'config.json'), 'utf8'));
  assert.equal(saved.accounts.length, 1);
  assert.equal(saved.refreshToken, undefined);
});

test('gemini through the Google account: no key needed, missing scope asks to re-authorise, then it works', async () => {
  await call('configSet', { geminiKeyClear: '1' });
  let st = await call('state');
  assert.equal(st.geminiVia, 'google');
  assert.equal(st.gemini, true, 'usable with just the Google account');
  await assert.rejects(call('geminiChat', { history: [{ role: 'user', text: 'salut' }] }), /^Error: SCOPE:gemini$/, 'account linked before Gemini');
  assert.equal(mock.gemini.auth.at(-1), 'Bearer tok', 'sent the Google token, not a key');
  assert.equal((await call('state')).geminiScope, false);

  const url = new URL(await call('geminiAuthorize'));
  assert.match(url.searchParams.get('scope'), /generative-language\.retriever/);
  assert.match(url.searchParams.get('scope'), /auth\/drive/);
  assert.equal(url.searchParams.get('login_hint'), 'testeur@example.com', 'straight to the same account');
  await fetch(`${url.searchParams.get('redirect_uri')}/?code=second&state=${url.searchParams.get('state')}`);
  await call('authWait');
  st = await call('state');
  assert.equal(st.geminiScope, true);
  const r = await call('geminiChat', { history: [{ role: 'user', text: 'salut' }] });
  assert.equal(r.text, 'ok');
  assert.equal(mock.gemini.auth.at(-1), 'Bearer tok2');
  assert.deepEqual((await call('geminiModels')).models.map((m) => m.id), ['gemini-test']);

  await call('configSet', { geminiKey: 'cle' });
  assert.equal((await call('state')).geminiVia, 'key');
  await call('geminiChat', { history: [{ role: 'user', text: 'salut' }] });
  assert.equal(mock.gemini.auth.at(-1), 'key:cle', 'a key set in the settings takes over');
});

// Answers the next in-page confirmation like the UI would (true = user clicks the action button).
// Resolves once the event stream is connected, so no confirmation can slip by before we listen.
async function answerNextConfirm(ok, check) {
  const es = await fetch(`${ORIGIN}/events`, { headers: { cookie: auth.cookie } });
  const reader = es.body.getReader();
  let buf = Buffer.from((await reader.read()).value).toString(); // ": ok" = connected
  const done = (async () => {
    for (;;) {
      const m = /data: (\{.*"confirm".*\})\n/.exec(buf);
      if (m) { const { data } = JSON.parse(m[1]); check?.(data); await call('confirmAnswer', data.id, ok); reader.cancel(); return data; }
      buf += Buffer.from((await reader.read()).value).toString();
    }
  })();
  return { done };
}
test('security: bad URL escapes do not crash, the URL key only opens / and /dl, runnable files are never launched', async () => {
  await call('accountSwitch', 'testeur@example.com');
  const bad = await new Promise((r) => http.get({ host: '127.0.0.1', port: PORT, path: '/%E0%A4%A', headers: { host: `localhost:${PORT}` } }, (res) => { res.resume(); r(res.statusCode); }));
  assert.equal(bad, 400);
  assert.equal(await call('session'), KEY, 'server still alive');
  const viaKey = await fetch(`${ORIGIN}/api/state?k=${KEY}`, { method: 'POST', headers: { 'x-tiroir': '1' } });
  assert.equal(viaKey.status, 401, 'API needs the cookie, not the URL key');
  assert.equal((await fetch(`${ORIGIN}/media/img1?k=${KEY}`)).status, 401);
  const r = await call('driveOpenLocal', { id: 'exe1' });
  assert.equal(r.revealed, true, '.exe shown in its folder, not run');
  assert.equal((await call('driveOpenLocal', { id: 'ete' })).revealed, undefined);
});

test('gmail: list, read (sanitised), attachment to Drive and Downloads, send without header injection', async () => {
  const { messages } = await call('gmailList', { label: 'INBOX' });
  assert.deepEqual(messages.map((m) => m.id), ['m1', 'm2']);
  assert.equal(messages[0].snippet, "Voici votre facture d'octobre");
  assert.ok(messages[0].unread && messages[0].attach);
  const m = await call('gmailGet', 'm1');
  assert.doesNotMatch(m.html, /<script/i);
  assert.match(m.html, /<a target="_blank" rel="noopener noreferrer" href=/);
  assert.deepEqual(m.attachments.map((a) => a.name), ['facture-oct.pdf']);
  assert.ok(mock.google.calls.some((c) => c.path === 'messages/m1/modify' && c.body.removeLabelIds.includes('UNREAD')), 'opened = read');
  assert.match((await call('gmailGet', 'm2')).text, /Léa/);

  await call('gmailSaveAttachment', 'm1', { id: 'att1', name: 'evil.exe' }, { to: 'drive', folder: 'factures' });
  const saved = [...mock.files.values()].find((f) => f.name === 'facture-oct.pdf');
  assert.ok(saved, 'name comes from Gmail, not from the page');
  assert.deepEqual(saved.parents, ['factures']);
  assert.equal(String(saved.content), '%PDF facture');
  const dl = await call('gmailSaveAttachment', 'm1', { id: 'att1' }, { to: 'downloads' });
  assert.equal(fs.readFileSync(dl.path, 'utf8'), '%PDF facture');

  await call('gmailSend', { to: 'ami@example.com\r\nBcc: espion@example.com', subject: 'Été', body: 'Salut !' });
  const raw = mock.google.sent.at(-1);
  assert.doesNotMatch(raw, /^Bcc:/m, 'no header injection');
  assert.match(raw, /^Subject: =\?UTF-8\?B\?/m);
  assert.equal(Buffer.from(raw.split('\r\n\r\n')[1].replace(/\s/g, ''), 'base64').toString(), 'Salut !');
  await assert.rejects(call('gmailSend', { to: '', subject: 'x', body: 'y' }), /Destinataire manquant/);
});

test('agenda and tasks: events with local time zone, tasks add / complete / delete', async () => {
  const evs = await call('calEvents', { from: '2026-11-14T00:00:00Z', to: '2026-12-14T00:00:00Z' });
  assert.equal(evs[0].summary, 'Dentiste');
  assert.equal(evs[0].calendar, 'Perso');
  const e = await call('calCreate', { summary: 'Réunion', start: '2026-11-20T14:00' });
  const sent = mock.google.events.at(-1);
  assert.equal(sent.start.dateTime, '2026-11-20T14:00:00');
  assert.equal(sent.end.dateTime, '2026-11-20T15:00:00', 'one hour by default');
  assert.ok(sent.start.timeZone, 'time zone of this PC');
  assert.equal(e.summary, 'Réunion');
  await call('calCreate', { summary: 'Vacances', start: '2026-12-24', allDay: true });
  assert.deepEqual([mock.google.events.at(-1).start, mock.google.events.at(-1).end], [{ date: '2026-12-24' }, { date: '2026-12-25' }]);

  const t = await call('tasksAdd', 'L1', { title: 'Payer EDF', due: '2026-11-30' });
  assert.equal(mock.google.tasks.at(-1).due, '2026-11-30T00:00:00.000Z');
  await call('tasksAdd', 'L1', { title: 'Appeler Léa' });
  await call('tasksUpdate', 'L1', t.id, { status: 'completed' });
  const list = await call('tasksList', 'L1');
  assert.deepEqual(list.map((x) => [x.title, x.status]), [['Appeler Léa', 'needsAction'], ['Payer EDF', 'completed']], 'done tasks last');
  await call('tasksDelete', 'L1', t.id);
  assert.equal((await call('tasksList', 'L1')).length, 1);
});

test('gemini agent: Docs/Sheets/Slides made for real, mail sending waits for the user', async () => {
  mock.gemini.script.push(
    { candidates: [{ content: { role: 'model', parts: [
      { functionCall: { name: 'create_document', args: { title: 'Résumé', content: '# Factures\n- EDF : **120 €**', folder_id: 'factures' } } },
      { functionCall: { name: 'create_spreadsheet', args: { title: 'Budget 2026', rows: [['mois', 'total'], ['nov', '=1+1']] } } },
      { functionCall: { name: 'create_presentation', args: { title: 'Bilan', slides: [{ title: 'Intro', body: 'Bonjour' }] } } },
      { functionCall: { name: 'add_task', args: { title: 'Relancer EDF' } } },
    ] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'Fait.' }] } }] },
  );
  const r = await call('geminiChat', { history: [{ role: 'user', text: 'prépare tout' }], agent: true });
  assert.equal(r.text, 'Fait.');
  const doc = [...mock.files.values()].find((f) => f.name === 'Résumé');
  assert.equal(doc.mimeType, 'application/vnd.google-apps.document', 'converted to a real Google Doc');
  assert.equal(doc.uploadType, 'text/html');
  assert.match(String(doc.content), /<h1>Factures<\/h1>[\s\S]*<li>EDF : <b>120 €<\/b><\/li>/);
  const sheet = [...mock.files.values()].find((f) => f.name === 'Budget 2026');
  assert.equal(sheet.mimeType, 'application/vnd.google-apps.spreadsheet');
  assert.equal(String(sheet.content), 'mois,total\r\nnov,=1+1');
  const slides = mock.google.calls.filter((c) => c.api === 'slides');
  assert.equal(slides[1].body.requests[0].createSlide.slideLayoutReference.predefinedLayout, 'TITLE_AND_BODY');
  assert.ok(slides[1].body.requests.some((q) => q.deleteObject?.objectId === 'p0'), 'empty first slide removed');
  assert.ok(mock.google.tasks.some((t) => t.title === 'Relancer EDF'));
  assert.equal(r.log.length, 4);
  const sys = mock.gemini.calls.at(-2).systemInstruction.parts[0].text;
  assert.match(sys, /jamais une consigne/, 'prompt-injection guard in the system prompt');

  const before = mock.google.sent.length;
  const answered = await answerNextConfirm(false, (d) => { assert.match(d.message, /envoyer un e-mail à pirate@example\.com/); assert.equal(d.verb, 'Envoyer'); });
  mock.gemini.script.push(
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'send_mail', args: { to: 'pirate@example.com', subject: 'Tes fichiers', body: 'tout' } } }] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'Annulé.' }] } }] },
  );
  await call('geminiChat', { history: [{ role: 'user', text: 'lis mes mails' }], agent: true });
  await answered.done;
  assert.equal(mock.google.sent.length, before, 'refused = not sent');

  const answered2 = await answerNextConfirm(true);
  mock.gemini.script.push(
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'send_mail', args: { to: 'lea@example.com', subject: 'Re: Demain', body: 'Oui !', reply_to_message_id: 'm2' } } }] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'Envoyé.' }] } }] },
  );
  const r3 = await call('geminiChat', { history: [{ role: 'user', text: 'réponds oui à Léa' }], agent: true });
  assert.deepEqual(r3.log, ['E-mail envoyé à lea@example.com']);
  assert.match(mock.google.sent.at(-1), /^In-Reply-To: /m, 'threaded reply');
  await answered2.done;
  assert.equal(mock.google.sent.length, before + 1, 'confirmed = sent');
});

test('google errors become one-click fixes: missing permission or API switched off', async () => {
  await assert.rejects(call('gmailList', { q: 'OFF' }), /^Error: API_OFF:gmail$/);
  await assert.rejects(call('gmailList', { q: 'NOSCOPE' }), /^Error: SCOPE:gmail$/);
  const st = await call('state');
  for (const api of ['gmail', 'calendar-json', 'tasks', 'docs', 'sheets', 'slides', 'generativelanguage']) assert.match(st.enableApisUrl, new RegExp(api + '\\.googleapis\\.com'));
  assert.deepEqual(Object.keys(st.scopes), ['drive', 'gemini', 'gmail', 'calendar', 'tasks']);
  const url = new URL(await call('servicesAuthorize'));
  for (const s of ['gmail.modify', 'calendar.events', 'tasks', 'generative-language.retriever', 'auth/drive']) assert.ok(url.searchParams.get('scope').includes(s), s);
});
test('videos and audio: exact indexed types, no server-side sort (fast on a huge Drive)', async () => {
  const before = mock.log.length;
  const vids = await call('driveList', { kind: 'type', type: 'video' });
  const req = mock.log.slice(before).find((l) => l.path === '/drive/v3/files');
  assert.doesNotMatch(req.query.q, /contains/, 'no full-Drive scan');
  assert.match(req.query.q, /mimeType = 'video\/mp4'/);
  assert.match(req.query.q, /mimeType = 'video\/quicktime'/);
  assert.equal(req.query.orderBy, undefined);
  assert.ok(Array.isArray(vids.files));
  await assert.rejects(call('driveList', { kind: 'type', type: 'constructor' }), /Type inconnu/);
});

test('"Mes fichiers" hides what others shared; the path of a file names only the real root "Mon Drive"', async () => {
  const all = names((await call('driveList', { kind: 'type', type: 'video' })).files);
  assert.ok(all.includes('clip-de-lea.mp4'), 'shared video listed by default');
  const mine = names((await call('driveList', { kind: 'type', type: 'video', mine: true })).files);
  assert.ok(!mine.includes('clip-de-lea.mp4'), 'hidden with "Mes fichiers"');
  assert.match(mock.log.filter((l) => l.path === '/drive/v3/files').at(-1).query.q, /^'me' in owners and /);
  assert.deepEqual(names(await call('drivePath', 'sub')), ['Mon Drive', 'Cours 2026', 'Chapitre 1']);
});

test('gemini model: newest stable Flash chosen automatically, a retired model is replaced on the fly', async () => {
  await call('configSet', { geminiKey: 'cle' });
  mock.gemini.models = ['gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-3.8-flash-lite', 'gemini-3.8-pro', 'gemini-4.0-flash-preview-09', 'gemini-3.8-flash-image', 'gemini-embedding-001'];
  mock.gemini.retired = ['gemini-2.5-flash'];
  await call('configSet', { geminiModel: 'gemini-2.5-flash' }); // like a config saved when 2.5 was the default
  const r = await call('geminiChat', { history: [{ role: 'user', text: 'salut' }] });
  assert.equal(r.text, 'ok', 'answered despite the retired model');
  assert.equal(mock.gemini.models_used.at(-1), 'gemini-3.8-flash', 'newest stable Flash, not preview / lite / image');
  const st = await call('state');
  assert.equal(st.modelChoice, '', 'back to automatic');
  assert.equal(st.model, 'gemini-3.8-flash');
  assert.equal((await call('geminiModels')).auto, 'gemini-3.8-flash');
  mock.gemini.models = ['gemini-test']; mock.gemini.retired = [];
  await call('configSet', { geminiModel: 'gemini-test' });
});

test('gemini without agent mode: read-only tools only, knows the selection, can tell where a file is', async () => {
  mock.gemini.script.push(
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'file_info', args: { file_id: 'img3' } } }, { functionCall: { name: 'trash_files', args: { file_ids: ['img3'] } } }] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'Dans Photos vacances.' }] } }] },
  );
  const r = await call('geminiChat', { history: [{ role: 'user', text: "c'est dans quel dossier ?" }], selection: [{ id: 'img3', name: 'IMG_4803.jpg' }] });
  assert.equal(r.text, 'Dans Photos vacances.');
  const first = mock.gemini.calls.at(-2);
  const tools = first.tools[0].functionDeclarations.map((t) => t.name);
  assert.ok(tools.includes('file_info') && tools.includes('search_drive'));
  assert.ok(!tools.includes('trash_files') && !tools.includes('send_mail') && !tools.includes('move_files'), 'no write tool outside agent mode');
  assert.match(first.systemInstruction.parts[0].text, /IMG_4803\.jpg \(id img3\)/, 'selection passed to Gemini');
  const answers = mock.gemini.calls.at(-1).contents.at(-1).parts.map((p) => p.functionResponse.response.result);
  assert.equal(answers[0].dossier, 'Mon Drive / Photos vacances');
  assert.match(answers[1], /refusé : mode lecture/);
  assert.equal(mock.files.get('img3').trashed, false);
});

test('gemini is quick: a heavy video is described, not uploaded; fast thinking asked; a model refusing it still answers', async () => {
  mock.files.set('bigvid', { id: 'bigvid', name: 'match.mp4', mimeType: 'video/mp4', parents: ['photos'], trashed: false, owners: [{ displayName: 'Moi', me: true }], modifiedTime: new Date().toISOString(), content: Buffer.alloc(5e6), size: String(5e6) });
  mock.gemini.models = ['gemini-3.8-flash']; await call('configSet', { geminiModel: '' });
  await call('geminiChat', { history: [{ role: 'user', text: 'il est dans quel dossier ?' }], files: [{ id: 'bigvid' }] });
  const sent = mock.gemini.calls.at(-1);
  const parts = sent.contents[0].parts;
  assert.ok(!parts.some((p) => p.inlineData), 'the 5 MB video is not uploaded to Gemini');
  assert.match(parts[0].text, /match\.mp4 » · id bigvid .* dossier : Mon Drive \/ Photos vacances/);
  assert.deepEqual(sent.generationConfig, { thinkingConfig: { thinkingLevel: 'low' } });

  mock.gemini.script.push({ __error: { code: 400, message: 'Thinking level is not supported for this model.' } });
  const r = await call('geminiChat', { history: [{ role: 'user', text: 'salut' }] });
  assert.equal(r.text, 'ok', 'retried without the setting');
  assert.equal(mock.gemini.calls.at(-1).generationConfig, undefined);
  mock.gemini.models = ['gemini-test']; await call('configSet', { geminiModel: 'gemini-test' });
});

test('leaves nothing behind: opened-file copies and unfinished downloads are purged', async () => {
  const { purgeTemp } = require('../server.js');
  const r = await call('driveOpenLocal', { id: 'ete' });
  assert.ok(fs.existsSync(r.path), 'copy made to open the file');
  fs.writeFileSync(path.join(DL, 'gros-fichier.mp4.part'), 'x'); // stands for a download cut short (tracked ones are removed the same way)
  assert.equal(purgeTemp(), true);
  assert.equal(fs.existsSync(r.path), false, 'copy removed');
  assert.equal(fs.existsSync(path.join(process.env.TIROIR_DATA, 'thumbs')), false);
});

test('passcode lock: sign-ins encrypted on disk, nothing served while locked, slow retries, change / disable / reset', async () => {
  const disk = () => JSON.parse(fs.readFileSync(path.join(process.env.TIROIR_DATA, 'config.json'), 'utf8'));
  const raw = (p) => fetch(ORIGIN + p, { headers: { cookie: auth.cookie } });
  await assert.rejects(call('lockSetup', '123'), /au moins 6/);
  await call('lockSetup', '246810', 15);
  assert.ok(disk().accounts.every((a) => a.refreshToken.startsWith('lk:')), 'refresh tokens encrypted with the passcode on disk');
  assert.ok(disk().lock.salt && disk().lock.wrapped.startsWith('lk:'));
  assert.ok((await call('driveList', { kind: 'folder', id: 'root' })).files.length, 'still unlocked right after setting it up');

  await call('lockNow');
  assert.deepEqual((await call('state')).lock, { enabled: true, locked: true, minutes: 15 });
  await assert.rejects(call('driveList', { kind: 'folder', id: 'root' }), /LOCKED/);
  await assert.rejects(call('accounts'), /LOCKED/);
  await assert.rejects(call('gmailList', {}), /LOCKED/);
  assert.equal((await raw('/thumb/img1?s=400')).status, 423, 'no previews');
  assert.equal((await raw('/dl/budget')).status, 423, 'no downloads');

  await assert.rejects(call('unlock', '000000'), /^Error: Code incorrect\.$/);
  await assert.rejects(call('unlock', '111111'), /^Error: Code incorrect\.$/);
  await assert.rejects(call('unlock', '222222'), /Prochain essai dans 5 s/);
  await assert.rejects(call('unlock', '246810'), /Trop d'essais/, 'even the right code waits');
  await new Promise((r) => setTimeout(r, 5200));
  await call('unlock', '246810');
  assert.ok((await call('driveList', { kind: 'folder', id: 'root' })).files.length, 'unlocked again');
  assert.equal(disk().lock.fails, 0);

  await assert.rejects(call('lockChange', 'mauvais', '13579bis'), /Code actuel incorrect/);
  await call('lockChange', '246810', '13579bis');
  await call('lockNow');
  await assert.rejects(call('unlock', '246810'), /Code incorrect/);
  await call('unlock', '13579bis');
  await call('lockDisable', '13579bis');
  assert.ok(disk().accounts.every((a) => !a.refreshToken.startsWith('lk:')), 'back to Windows encryption only');
  assert.equal(disk().lock, undefined);
  assert.ok((await call('driveList', { kind: 'folder', id: 'root' })).files.length);

  await call('lockSetup', '999999', 0);
  await call('lockNow');
  await call('lockReset'); // forgotten code
  const st = await call('state');
  assert.equal(st.lock.enabled, false);
  assert.equal(st.signedIn, false, 'accounts must be reconnected');
});
