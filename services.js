// Tiroir: the other Google services, reached with the same Google sign-in as Drive.
// Gmail, Google Agenda, Google Tasks for the page; plus Docs / Sheets / Slides for the Gemini agent.
// server.js hands in what it owns (token, Drive helpers, confirmations) and gets back RPC handlers and agent tools.

const BASE = {
  gmail: process.env.TIROIR_GMAIL || 'https://gmail.googleapis.com/gmail/v1/users/me/',
  calendar: process.env.TIROIR_CALENDAR || 'https://www.googleapis.com/calendar/v3/',
  tasks: process.env.TIROIR_TASKS || 'https://tasks.googleapis.com/tasks/v1/',
  docs: process.env.TIROIR_DOCS || 'https://docs.googleapis.com/v1/',
  sheets: process.env.TIROIR_SHEETS || 'https://sheets.googleapis.com/v4/',
  slides: process.env.TIROIR_SLIDES || 'https://slides.googleapis.com/v1/',
};
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

module.exports = function services(d) {
  // ---------- one REST helper for every Google API ----------
  async function g(svc, p, { method = 'GET', query = {}, body } = {}) {
    const url = new URL(BASE[svc] + p);
    for (const [k, v] of Object.entries(query)) if (v != null && v !== '') for (const x of [].concat(v)) url.searchParams.append(k, x);
    const res = await fetch(url, { method, headers: { Authorization: 'Bearer ' + (await d.token()), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 204) return null;
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw d.googleError(svc, res.status, j);
    return j;
  }
  const lim = d.limiter(8);

  // ---------- Gmail ----------
  const b64d = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const hdr = (h, n) => (h || []).find((x) => x.name.toLowerCase() === n.toLowerCase())?.value || '';
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  const entities = (s) => String(s).replace(/&(#x?[\da-f]+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m));
  function decodePart(part) {
    const cs = /charset="?([\w.-]+)/i.exec(hdr(part.headers, 'Content-Type'))?.[1] || 'utf-8';
    const buf = b64d(part.body?.data);
    try { return new TextDecoder(cs).decode(buf); } catch { return buf.toString('utf8'); }
  }
  function walk(part, out) {
    if (part.filename && (part.body?.attachmentId || part.body?.data)) out.attachments.push({ name: part.filename, mimeType: part.mimeType, size: part.body.size || 0, id: part.body.attachmentId || '', partId: part.partId });
    else if (part.mimeType === 'text/plain' && part.body?.data && !out.text) out.text = decodePart(part);
    else if (part.mimeType === 'text/html' && part.body?.data && !out.html) out.html = decodePart(part);
    for (const p of part.parts || []) walk(p, out);
  }
  const summary = (m) => {
    const h = m.payload?.headers;
    return {
      id: m.id, threadId: m.threadId, from: hdr(h, 'From'), to: hdr(h, 'To'), subject: hdr(h, 'Subject'),
      date: Number(m.internalDate) || Date.parse(hdr(h, 'Date')) || 0, snippet: entities(m.snippet || ''),
      unread: !!m.labelIds?.includes('UNREAD'), starred: !!m.labelIds?.includes('STARRED'), attach: m.payload?.mimeType === 'multipart/mixed',
    };
  };
  // Links in a mail open in the real browser; the page shows the HTML in a sandboxed frame with no scripts and no remote images.
  const safeHtml = (html) => String(html).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<a\s/gi, '<a target="_blank" rel="noopener noreferrer" ');

  async function gmailList({ q, label = 'INBOX', pageToken } = {}) {
    const r = await g('gmail', 'messages', { query: { maxResults: 40, q: q || undefined, labelIds: q || label === 'ALL' ? undefined : label, pageToken, includeSpamTrash: label === 'TRASH' || undefined } });
    const ms = await Promise.all((r.messages || []).map((m) => lim(() => g('gmail', `messages/${m.id}`, { query: { format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] } }))));
    return { messages: ms.map(summary), next: r.nextPageToken || null };
  }
  async function gmailGet(id, { markRead = true } = {}) {
    const m = await g('gmail', `messages/${encodeURIComponent(id)}`, { query: { format: 'full' } });
    const out = { text: '', html: '', attachments: [] };
    walk(m.payload || {}, out);
    if (markRead && m.labelIds?.includes('UNREAD')) await g('gmail', `messages/${encodeURIComponent(id)}/modify`, { method: 'POST', body: { removeLabelIds: ['UNREAD'] } }).catch(() => {});
    const h = m.payload?.headers;
    return { ...summary(m), unread: false, cc: hdr(h, 'Cc'), replyTo: hdr(h, 'Reply-To'), messageId: hdr(h, 'Message-ID'), references: hdr(h, 'References'), text: out.text, html: out.html ? safeHtml(out.html) : '', attachments: out.attachments };
  }
  async function attachmentBytes(msgId, att) {
    if (att.id) return b64d((await g('gmail', `messages/${encodeURIComponent(msgId)}/attachments/${encodeURIComponent(att.id)}`)).data);
    const m = await g('gmail', `messages/${encodeURIComponent(msgId)}`, { query: { format: 'full' } }); // small inline part: its bytes are in the message itself
    let found; const find = (p) => { if (p.partId === att.partId) found = p; (p.parts || []).forEach(find); }; find(m.payload || {});
    if (!found?.body?.data) throw new Error('Pièce jointe introuvable');
    return b64d(found.body.data);
  }
  async function findAttachment(msgId, ref) {
    const { attachments } = await gmailGet(msgId, { markRead: false });
    const a = attachments.find((x) => (ref.id && x.id === ref.id) || (ref.partId && x.partId === ref.partId) || (ref.name && x.name === ref.name));
    if (!a) throw new Error('Pièce jointe introuvable dans ce mail');
    return a;
  }
  async function gmailSaveAttachment(msgId, ref, { to = 'drive', folder = 'root' } = {}) {
    const a = await findAttachment(msgId, ref); // name and type come from Gmail, never from the page
    const buf = await attachmentBytes(msgId, a);
    if (to === 'downloads') return d.saveToDownloads(a.name, buf);
    return d.driveUploadBuffer({ name: a.name, parents: [folder || 'root'] }, buf, a.mimeType || 'application/octet-stream');
  }
  function rfc822({ to, cc, subject, body, inReplyTo, references }) {
    const one = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim(); // no header injection through a field
    const enc = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
    if (!one(to)) throw new Error('Destinataire manquant');
    const L = [`To: ${one(to)}`];
    if (one(cc)) L.push(`Cc: ${one(cc)}`);
    L.push(`Subject: ${enc(one(subject))}`);
    if (one(inReplyTo)) L.push(`In-Reply-To: ${one(inReplyTo)}`, `References: ${one([references, inReplyTo].filter(Boolean).join(' '))}`);
    L.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(String(body || '')).toString('base64').replace(/.{76}/g, '$&\r\n'));
    return b64u(L.join('\r\n'));
  }
  const gmailSend = async (m) => ({ id: (await g('gmail', 'messages/send', { method: 'POST', body: { raw: rfc822(m), ...(m.threadId ? { threadId: m.threadId } : {}) } })).id });
  const gmailDraft = async (m) => ({ id: (await g('gmail', 'drafts', { method: 'POST', body: { message: { raw: rfc822(m), ...(m.threadId ? { threadId: m.threadId } : {}) } } })).id });
  const gmailModify = (id, add = [], remove = []) => g('gmail', `messages/${encodeURIComponent(id)}/modify`, { method: 'POST', body: { addLabelIds: add, removeLabelIds: remove } }).then(() => true);
  const gmailTrash = (id) => g('gmail', `messages/${encodeURIComponent(id)}/trash`, { method: 'POST' }).then(() => true);

  // ---------- Google Agenda ----------
  async function calCalendars() {
    const r = await g('calendar', 'users/me/calendarList', { query: { maxResults: 50 } });
    return (r.items || []).map((c) => ({ id: c.id, name: c.summaryOverride || c.summary, color: c.backgroundColor || '#9a9aa2', primary: !!c.primary, selected: c.selected !== false || !!c.primary, writable: ['owner', 'writer'].includes(c.accessRole) }));
  }
  const ev = (e, c) => ({
    id: e.id, calendarId: c.id, calendar: c.name, color: c.color, summary: e.summary || '(sans titre)',
    start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date, allDay: !!e.start?.date,
    location: e.location || '', description: String(e.description || '').slice(0, 3000), link: e.htmlLink || '', writable: c.writable,
  });
  async function calEvents({ from, to } = {}) {
    const cals = (await calCalendars()).filter((c) => c.selected).slice(0, 15);
    const lists = await Promise.all(cals.map((c) => g('calendar', `calendars/${encodeURIComponent(c.id)}/events`, { query: { timeMin: from, timeMax: to, singleEvents: true, orderBy: 'startTime', maxResults: 250 } })
      .then((r) => (r.items || []).filter((e) => e.status !== 'cancelled').map((e) => ev(e, c)))
      .catch((e) => { if (/^(SCOPE|API_OFF):/.test(e.message)) throw e; return []; }))); // one broken shared calendar must not hide the others
    return lists.flat().sort((a, b) => String(a.start).localeCompare(String(b.start)));
  }
  // "2026-11-15T14:00" (local time from the page or Gemini) -> Calendar's { dateTime, timeZone }
  const pad = (n) => String(n).padStart(2, '0');
  const localIso = (dt) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}:00`;
  function when(s, allDay) {
    if (allDay) return { date: String(s).slice(0, 10) };
    if (/[zZ]|[+-]\d\d:\d\d$/.test(s)) return { dateTime: s };
    return { dateTime: String(s).length === 16 ? s + ':00' : s, timeZone: TZ };
  }
  async function calCreate({ calendarId = 'primary', summary, start, end, allDay = false, location, description } = {}) {
    if (!summary || !start) throw new Error('Titre et début obligatoires');
    if (!end) {
      const s = new Date(allDay ? String(start).slice(0, 10) + 'T00:00' : start);
      if (isNaN(s)) throw new Error('Date de début invalide');
      end = allDay ? localIso(new Date(s.getTime() + 864e5)).slice(0, 10) : localIso(new Date(s.getTime() + 36e5));
    }
    const e = await g('calendar', `calendars/${encodeURIComponent(calendarId)}/events`, { method: 'POST', body: { summary, location, description, start: when(start, allDay), end: when(end, allDay) } });
    return ev(e, { id: calendarId, name: '', color: '', writable: true });
  }
  const calDelete = (calendarId, id) => g('calendar', `calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(() => true);

  // ---------- Google Tasks ----------
  const tasksLists = async () => ((await g('tasks', 'users/@me/lists', { query: { maxResults: 100 } })).items || []).map((l) => ({ id: l.id, title: l.title }));
  const task = (t) => ({ id: t.id, title: t.title || '', notes: t.notes || '', status: t.status, due: t.due ? t.due.slice(0, 10) : '', completed: t.completed || '', parent: t.parent || '' });
  async function tasksList(listId) {
    const r = await g('tasks', `lists/${encodeURIComponent(listId)}/tasks`, { query: { showCompleted: true, showHidden: true, maxResults: 100 } });
    return (r.items || []).filter((t) => t.title || t.notes).sort((a, b) => (a.status === 'completed') - (b.status === 'completed') || String(a.position).localeCompare(String(b.position))).map(task);
  }
  const dueIso = (s) => (s ? String(s).slice(0, 10) + 'T00:00:00.000Z' : undefined);
  const tasksAdd = async (listId, { title, notes, due } = {}) => task(await g('tasks', `lists/${encodeURIComponent(listId)}/tasks`, { method: 'POST', body: { title: String(title || '').slice(0, 1000), notes, due: dueIso(due) } }));
  async function tasksUpdate(listId, id, patch = {}) {
    const body = {};
    if (patch.title != null) body.title = String(patch.title);
    if (patch.notes != null) body.notes = String(patch.notes);
    if (patch.due !== undefined) body.due = dueIso(patch.due) || null;
    if (patch.status) { body.status = patch.status === 'completed' ? 'completed' : 'needsAction'; if (body.status === 'needsAction') body.completed = null; }
    return task(await g('tasks', `lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body }));
  }
  const tasksDelete = (listId, id) => g('tasks', `lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(() => true);
  const defaultList = async () => (await tasksLists())[0]?.id || (() => { throw new Error('Aucune liste de tâches'); })();

  // ---------- Docs / Sheets / Slides (for the agent) ----------
  const escH = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function mdHtml(md) { // enough Markdown for what Gemini writes; Drive turns this HTML into a real Google Doc
    const inl = (s) => escH(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>').replace(/`([^`]+)`/g, '<code>$1</code>');
    const out = []; let list = null;
    for (const line of String(md || '').split(/\r?\n/)) {
      const li = /^\s*(?:[-*•]|(\d+)[.)])\s+(.*)/.exec(line); const h = /^(#{1,6})\s+(.*)/.exec(line);
      if (li) { const t = li[1] ? 'ol' : 'ul'; if (list !== t) { if (list) out.push(`</${list}>`); out.push(`<${t}>`); list = t; } out.push(`<li>${inl(li[2])}</li>`); continue; }
      if (list) { out.push(`</${list}>`); list = null; }
      if (h) out.push(`<h${h[1].length}>${inl(h[2])}</h${h[1].length}>`); else if (line.trim()) out.push(`<p>${inl(line)}</p>`);
    }
    if (list) out.push(`</${list}>`);
    return `<!doctype html><html><head><meta charset="utf-8"></head><body>${out.join('\n')}</body></html>`;
  }
  const csvCell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const asRows = (rows) => (Array.isArray(rows) ? rows : []).map((r) => (Array.isArray(r) ? r : [r]).map((c) => (c == null ? '' : String(c))));
  const created = (f) => ({ id: f.id, name: f.name, link: f.webViewLink || '' });

  const docCreate = async ({ title, content, folder_id }) => created(await d.driveUploadBuffer({ name: title || 'Document', mimeType: 'application/vnd.google-apps.document', parents: [folder_id || 'root'] }, Buffer.from(mdHtml(content)), 'text/html'));
  async function docAppend({ file_id, text }) {
    const doc = await g('docs', `documents/${encodeURIComponent(file_id)}`, { query: { fields: 'body/content/endIndex' } });
    const end = Math.max(1, (doc.body?.content?.at(-1)?.endIndex || 2) - 1);
    await g('docs', `documents/${encodeURIComponent(file_id)}:batchUpdate`, { method: 'POST', body: { requests: [{ insertText: { location: { index: end }, text: '\n' + String(text || '') } }] } });
    return 'ok';
  }
  const sheetCreate = async ({ title, rows, folder_id }) => created(await d.driveUploadBuffer({ name: title || 'Tableur', mimeType: 'application/vnd.google-apps.spreadsheet', parents: [folder_id || 'root'] }, Buffer.from(asRows(rows).map((r) => r.map(csvCell).join(',')).join('\r\n')), 'text/csv'));
  const sheetRead = async ({ file_id, range }) => (await g('sheets', `spreadsheets/${encodeURIComponent(file_id)}/values/${encodeURIComponent(range || 'A1:Z200')}`)).values || [];
  const sheetWrite = async ({ file_id, range, rows }) => { const r = await g('sheets', `spreadsheets/${encodeURIComponent(file_id)}/values/${encodeURIComponent(range || 'A1')}`, { method: 'PUT', query: { valueInputOption: 'USER_ENTERED' }, body: { values: asRows(rows) } }); return `${r.updatedCells || 0} cellule(s) écrite(s)`; };
  const sheetAppend = async ({ file_id, rows }) => { await g('sheets', `spreadsheets/${encodeURIComponent(file_id)}/values/A1:append`, { method: 'POST', query: { valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' }, body: { values: asRows(rows) } }); return 'ok'; };
  async function slidesCreate({ title, slides, folder_id }) {
    const p = await g('slides', 'presentations', { method: 'POST', body: { title: title || 'Présentation' } });
    const list = (Array.isArray(slides) ? slides : []).slice(0, 60);
    const req = [];
    list.forEach((s, i) => {
      req.push({ createSlide: { objectId: `tiroir_s${i}`, slideLayoutReference: { predefinedLayout: 'TITLE_AND_BODY' }, placeholderIdMappings: [{ layoutPlaceholder: { type: 'TITLE' }, objectId: `tiroir_t${i}` }, { layoutPlaceholder: { type: 'BODY' }, objectId: `tiroir_b${i}` }] } });
      if (s?.title) req.push({ insertText: { objectId: `tiroir_t${i}`, text: String(s.title) } });
      if (s?.body) req.push({ insertText: { objectId: `tiroir_b${i}`, text: String(s.body) } });
    });
    if (list.length && p.slides?.[0]?.objectId) req.push({ deleteObject: { objectId: p.slides[0].objectId } }); // the empty title slide Google adds
    if (req.length) await g('slides', `presentations/${encodeURIComponent(p.presentationId)}:batchUpdate`, { method: 'POST', body: { requests: req } });
    if (folder_id && folder_id !== 'root') await d.move([{ id: p.presentationId }], folder_id);
    return { id: p.presentationId, name: title, link: `https://docs.google.com/presentation/d/${p.presentationId}/edit` };
  }

  // ---------- Gemini agent tools ----------
  const S = (props, required) => ({ type: 'object', properties: props, required });
  const str = (x) => ({ type: 'string', description: x });
  const rowsT = { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'lignes du tableau, chaque ligne = liste de cellules' };
  const TOOLS = [
    { name: 'create_document', description: 'Crée un Google Doc (contenu en Markdown simple : titres #, listes -, **gras**).', parameters: S({ title: str('titre'), content: str('contenu'), folder_id: str("dossier, 'root' par défaut") }, ['title', 'content']) },
    { name: 'append_to_document', description: "Ajoute du texte à la fin d'un Google Doc existant.", parameters: S({ file_id: str('id du Google Doc'), text: str('texte à ajouter') }, ['file_id', 'text']) },
    { name: 'create_spreadsheet', description: 'Crée un Google Sheets rempli avec des lignes.', parameters: S({ title: str('titre'), rows: rowsT, folder_id: str("dossier, 'root' par défaut") }, ['title', 'rows']) },
    { name: 'read_spreadsheet', description: "Lit les cellules d'un Google Sheets.", parameters: S({ file_id: str('id'), range: str("plage A1, ex. 'Feuille1!A1:D50' (défaut A1:Z200)") }, ['file_id']) },
    { name: 'write_spreadsheet', description: 'Écrit des valeurs dans un Google Sheets à partir de la cellule donnée (les formules =... sont calculées).', parameters: S({ file_id: str('id'), range: str("cellule de départ, ex. 'A1'"), rows: rowsT }, ['file_id', 'range', 'rows']) },
    { name: 'append_rows', description: 'Ajoute des lignes à la fin des données d’un Google Sheets.', parameters: S({ file_id: str('id'), rows: rowsT }, ['file_id', 'rows']) },
    { name: 'create_presentation', description: 'Crée une présentation Google Slides, une diapositive par élément.', parameters: S({ title: str('titre'), slides: { type: 'array', items: S({ title: str('titre de la diapo'), body: str('texte, une idée par ligne') }) }, folder_id: str("dossier, 'root' par défaut") }, ['title', 'slides']) },
    { name: 'search_mail', description: "Cherche des e-mails Gmail (syntaxe Gmail : from:, subject:, has:attachment, newer_than:7d…). Vide = derniers mails reçus.", parameters: S({ query: str('recherche Gmail') }) },
    { name: 'read_mail', description: "Lit un e-mail (texte et liste des pièces jointes).", parameters: S({ message_id: str('id du mail') }, ['message_id']) },
    { name: 'save_attachment_to_drive', description: "Enregistre une pièce jointe d'un e-mail dans le Drive.", parameters: S({ message_id: str('id du mail'), attachment_name: str('nom exact de la pièce jointe'), folder_id: str("dossier, 'root' par défaut") }, ['message_id', 'attachment_name']) },
    { name: 'draft_mail', description: 'Prépare un brouillon dans Gmail (rien n’est envoyé).', parameters: S({ to: str('destinataire(s)'), subject: str('objet'), body: str('texte'), reply_to_message_id: str('id du mail auquel on répond (facultatif)') }, ['to', 'subject', 'body']) },
    { name: 'send_mail', description: "Envoie un e-mail (l'utilisateur confirme avant l'envoi).", parameters: S({ to: str('destinataire(s)'), subject: str('objet'), body: str('texte'), reply_to_message_id: str('id du mail auquel on répond (facultatif)') }, ['to', 'subject', 'body']) },
    { name: 'list_events', description: "Liste les événements de l'agenda entre deux dates.", parameters: S({ from: str('début AAAA-MM-JJ'), to: str('fin AAAA-MM-JJ (incluse)') }, ['from', 'to']) },
    { name: 'create_event', description: "Crée un événement dans l'agenda principal. Heures locales 'AAAA-MM-JJTHH:MM'.", parameters: S({ summary: str('titre'), start: str("début, 'AAAA-MM-JJTHH:MM' ou 'AAAA-MM-JJ' si journée entière"), end: str('fin (facultatif, +1 h par défaut)'), all_day: { type: 'boolean' }, location: str('lieu'), description: str('notes') }, ['summary', 'start']) },
    { name: 'delete_event', description: "Supprime un événement (l'utilisateur confirme).", parameters: S({ calendar_id: str('id de l’agenda'), event_id: str('id de l’événement') }, ['calendar_id', 'event_id']) },
    { name: 'list_tasks', description: 'Liste les tâches Google Tasks (liste par défaut si non précisée).', parameters: S({ list_id: str('id de la liste (facultatif)') }) },
    { name: 'add_task', description: 'Ajoute une tâche.', parameters: S({ title: str('tâche'), notes: str('détails'), due: str('échéance AAAA-MM-JJ'), list_id: str('liste (facultatif)') }, ['title']) },
    { name: 'complete_task', description: 'Coche (termine) une tâche.', parameters: S({ task_id: str('id'), list_id: str('liste (facultatif)') }, ['task_id']) },
  ];
  async function replyFields(id) {
    if (!id) return {};
    const m = await gmailGet(id, { markRead: false });
    return { threadId: m.threadId, inReplyTo: m.messageId, references: m.references };
  }
  const shortMail = (m) => ({ id: m.id, from: m.from, subject: m.subject, date: new Date(m.date).toISOString().slice(0, 16), snippet: m.snippet, unread: m.unread });
  async function runTool(name, a, log) {
    switch (name) {
      case 'create_document': { const f = await docCreate(a); log.push(`Google Doc créé : ${f.name}`); return f; }
      case 'append_to_document': await docAppend(a); log.push('Texte ajouté au document'); return 'ok';
      case 'create_spreadsheet': { const f = await sheetCreate(a); log.push(`Google Sheets créé : ${f.name}`); return f; }
      case 'read_spreadsheet': return (await sheetRead(a)).slice(0, 500);
      case 'write_spreadsheet': { const r = await sheetWrite(a); log.push('Tableur mis à jour'); return r; }
      case 'append_rows': await sheetAppend(a); log.push(`${asRows(a.rows).length} ligne(s) ajoutée(s)`); return 'ok';
      case 'create_presentation': { const f = await slidesCreate(a); log.push(`Présentation créée : ${f.name}`); return f; }
      case 'search_mail': return (await gmailList({ q: a.query || '', label: 'INBOX' })).messages.slice(0, 25).map(shortMail);
      case 'read_mail': { const m = await gmailGet(a.message_id, { markRead: false }); return { ...shortMail(m), to: m.to, cc: m.cc, text: (m.text || entities(m.html.replace(/<style[\s\S]*?<\/style>|<[^>]+>/gi, ' ')).replace(/\s+/g, ' ')).slice(0, 20000), attachments: m.attachments.map((x) => ({ name: x.name, type: x.mimeType, size: x.size })) }; }
      case 'save_attachment_to_drive': { const f = await gmailSaveAttachment(a.message_id, { name: a.attachment_name }, { to: 'drive', folder: a.folder_id }); log.push(`Pièce jointe enregistrée : ${f.name}`); d.emit('changed'); return { id: f.id, name: f.name }; }
      case 'draft_mail': { const r = await gmailDraft({ ...a, ...(await replyFields(a.reply_to_message_id)) }); log.push(`Brouillon prêt pour ${a.to}`); return r; }
      case 'send_mail': {
        if (!(await d.confirmInPage(`Gemini veut envoyer un e-mail à ${a.to}`, `Objet : ${a.subject}\n\n${String(a.body || '').slice(0, 1500)}`, 'Envoyer'))) return "refusé par l'utilisateur";
        const r = await gmailSend({ ...a, ...(await replyFields(a.reply_to_message_id)) }); log.push(`E-mail envoyé à ${a.to}`); return r;
      }
      case 'list_events': return (await calEvents({ from: new Date(a.from + 'T00:00').toISOString(), to: new Date(new Date(a.to + 'T00:00').getTime() + 864e5).toISOString() })).slice(0, 200).map(({ description, link, color, ...e }) => e);
      case 'create_event': { const e = await calCreate({ ...a, allDay: !!a.all_day }); log.push(`Événement créé : ${e.summary}`); return { id: e.id, start: e.start }; }
      case 'delete_event': {
        if (!(await d.confirmInPage('Gemini veut supprimer un événement de ton agenda', a.event_id, 'Supprimer'))) return "refusé par l'utilisateur";
        await calDelete(a.calendar_id, a.event_id); log.push('Événement supprimé'); return 'ok';
      }
      case 'list_tasks': return tasksList(a.list_id || (await defaultList()));
      case 'add_task': { const t = await tasksAdd(a.list_id || (await defaultList()), a); log.push(`Tâche ajoutée : ${t.title}`); return { id: t.id }; }
      case 'complete_task': { await tasksUpdate(a.list_id || (await defaultList()), a.task_id, { status: 'completed' }); log.push('Tâche terminée'); return 'ok'; }
    }
    return undefined;
  }

  return {
    TOOLS, runTool,
    H: {
      gmailList, gmailGet, gmailSaveAttachment, gmailSend, gmailDraft, gmailTrash,
      gmailArchive: (id) => gmailModify(id, [], ['INBOX']),
      gmailStar: (id, on) => gmailModify(id, on ? ['STARRED'] : [], on ? [] : ['STARRED']),
      gmailMarkUnread: (id) => gmailModify(id, ['UNREAD'], []),
      calCalendars, calEvents, calCreate, calDelete,
      tasksLists, tasksList, tasksAdd, tasksUpdate, tasksDelete,
    },
  };
};
