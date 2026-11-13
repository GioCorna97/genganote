const $ = s => document.querySelector(s);
const PRIO = { alta: 0, media: 1, bassa: 2 };
const WD = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
let S = null;
const expanded = new Set();
let tab = 'todo';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const isUrgent = t => t.status === 'open' && t.due && t.due <= addDays(S.today, 1) && t.due >= addDays(S.today, -2);
const isStale = t => t.status === 'open' && t.due && t.due < addDays(S.today, -2);

function dueInfo(due) {
  if (!due) return null;
  const diff = Math.round((new Date(due + 'T12:00:00') - new Date(S.today + 'T12:00:00')) / 864e5);
  if (diff < 0) return { label: `scaduto da ${-diff} g`, cls: 'overdue' };
  if (diff === 0) return { label: 'oggi', cls: 'today' };
  if (diff === 1) return { label: 'domani', cls: 'today' };
  const d = new Date(due + 'T12:00:00');
  if (diff < 7) return { label: `${WD[d.getDay()]} ${d.getDate()}`, cls: '' };
  return { label: `${d.getDate()}/${d.getMonth() + 1}`, cls: '' };
}

function ago(iso) {
  if (!iso) return 'mai';
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return 'adesso';
  if (m < 60) return `${m} min fa`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h fa` : `${Math.round(h / 24)} g fa`;
}

// ordine: urgenti prima; poi i to-do senza posizione manuale (nuovi, ordinati in automatico); poi quelli spostati a mano (rank)
function rankCmp(a, b) {
  const ra = a.rank != null, rb = b.rank != null;
  if (ra && rb) return a.rank - b.rank;
  if (ra !== rb) return ra ? 1 : -1;
  return 0;
}
const sortTodos = l => [...l].sort((a, b) => (isUrgent(b) - isUrgent(a)) || rankCmp(a, b) || (PRIO[a.priority] - PRIO[b.priority])
  || (a.due || '9999').localeCompare(b.due || '9999') || (b.createdAt || '').localeCompare(a.createdAt || ''));
let groupsOrder = []; // ids ordinati per ogni gruppo visibile (serve a spostare su/giù)

function itemHTML(t) {
  const di = dueInfo(t.due);
  const enriching = S.enriching.includes(t.id);
  const open = expanded.has(t.id);
  const meta = [];
  if (di) meta.push(`<span class="due ${di.cls}">📅 ${di.label}</span>`);
  if (t.project) meta.push(`<span class="chip">${esc(t.project)}</span>`);
  if (t.waitingOn) meta.push(`<span>⏳ ${esc(t.waitingOn)}</span>`);
  else if (t.people?.length) meta.push(`<span>👥 ${esc(t.people.slice(0, 3).join(', '))}</span>`);
  if (enriching) meta.push(`<span class="sparkle">✨ sto analizzando…</span>`);
  const src = t.source?.type === 'granola' ? `📞 ${esc(t.source.title)}` : t.source?.type === 'chat' ? '💬 da chat' : '✍️ aggiunto a mano';

  return `<div class="item p-${t.priority} ${isUrgent(t) ? 'urgent' : ''} ${t.status === 'done' ? 'done' : ''}" data-id="${t.id}">
    <button class="check" data-act="toggle" title="${t.status === 'done' ? 'Riapri' : 'Fatto'}">${t.status === 'done' ? '✓' : ''}</button>
    <div class="body" data-act="expand">
      <div class="title">${esc(t.title)}</div>
      ${t.nextStep && t.status !== 'done' ? `<div class="next">→ ${esc(t.nextStep)}</div>` : ''}
      ${meta.length ? `<div class="meta">${meta.join('')}</div>` : ''}
      ${open ? `<div class="details" data-stop>
        ${t.detail ? `<div class="detail">${esc(t.detail)}</div>` : ''}
        <div class="row"><label>Titolo</label><input data-field="title" value="${esc(t.title)}"></div>
        <div class="row"><label>Next step</label><input data-field="nextStep" value="${esc(t.nextStep || '')}"></div>
        <div class="row"><label>Scadenza</label><input type="date" data-field="due" value="${t.due || ''}">
          <select data-field="priority">${['alta', 'media', 'bassa'].map(p => `<option ${p === t.priority ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
        <div class="row"><label>Stato</label><select data-field="status">
          ${[['open', 'Da fare'], ['waiting', 'In attesa di altri'], ['done', 'Fatto']].map(([v, l]) => `<option value="${v}" ${v === t.status ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="actions">
          ${t.source?.url ? `<button class="link" data-act="open" data-url="${esc(t.source.url)}">${src} ↗</button>` : `<span class="meta">${src}</span>`}
          <button class="btn danger" data-act="remove">Elimina</button>
        </div>
      </div>` : ''}
    </div>
    ${t.status !== 'done' ? `<div class="grip" data-act="grip" title="Clic sopra: sposta su · Clic sotto: sposta giù">${'<i></i>'.repeat(9)}</div>` : ''}
  </div>`;
}

function groupHTML(title, list, cls = '') {
  return list.length ? `<div class="group ${cls}">${title} · ${list.length}</div>${list.map(itemHTML).join('')}` : '';
}

function renderLists() {
  const T = S.todos;
  const open = sortTodos(T.filter(t => t.status === 'open'));
  const urgent = open.filter(isUrgent);
  const stale = open.filter(isStale);
  const week = open.filter(t => !isUrgent(t) && !isStale(t) && t.due && t.due <= addDays(S.today, 7));
  const rest = open.filter(t => !isUrgent(t) && !isStale(t) && !(t.due && t.due <= addDays(S.today, 7)));
  $('#todoList').innerHTML = open.length
    ? groupHTML('⚠️ Urgenti', urgent, 'fire') + groupHTML('📆 Questa settimana', week) + groupHTML('📌 Da fare', rest) + groupHTML('⌛ Scaduti — ancora da fare?', stale)
    : `<div class="empty">${S.syncing ? 'Sto leggendo le tue chiamate… 🧠' : 'Niente da fare. Goditela ☕'}</div>`;

  const waiting = sortTodos(T.filter(t => t.status === 'waiting'));
  groupsOrder = [urgent, week, rest, stale, waiting].map(l => l.map(t => t.id));
  $('#waitingList').innerHTML = waiting.length ? waiting.map(itemHTML).join('') : '<div class="empty">Non stai aspettando nessuno.</div>';

  const done = T.filter(t => t.status === 'done').sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || '')).slice(0, 80);
  $('#doneList').innerHTML = done.length ? done.map(itemHTML).join('') : '<div class="empty">Ancora niente di completato.</div>';

  $('#cTodo').textContent = S.stats.open || '';
  $('#cTodo').classList.toggle('fire', S.stats.urgent > 0);
  $('#cWaiting').textContent = S.stats.waiting || '';
}

function renderHeader() {
  document.querySelectorAll('#modeSw button').forEach(b => b.classList.toggle('on', b.dataset.mode === (S.mode || 'official')));
  const lbl = $('#syncLabel');
  lbl.classList.toggle('err', !!S.lastError);
  lbl.textContent = S.syncing ? (S.syncProgress || 'Sync in corso…')
    : S.lastError ? `⚠️ ${S.lastError}`
    : `Granola aggiornato ${ago(S.lastSync)} · ogni ${S.syncMinutes} min`;
  $('#syncBtn').classList.toggle('spin', !!S.syncing);
  $('#syncBtn').disabled = !!S.syncing;
  const b = $('#banner');
  if (!S.hasGranola) { b.textContent = 'API key Granola non trovata: aggiungila in config.json (granolaApiKey).'; b.className = 'banner err'; }
  else b.className = 'banner hidden';
}

// --- mini markdown (sicuro: escape prima) ---
function md(src) {
  const lines = esc(src).split(/\r?\n/);
  let html = '', list = null;
  const inline = s => s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>').replace(/(^|\s)_([^_]+)_/g, '$1<i>$2</i>');
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const l of lines) {
    let m;
    if ((m = l.match(/^\s*[-*•]\s+(.*)/))) { if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = l.match(/^#{1,4}\s+(.*)/))) { close(); html += `<h4>${inline(m[1])}</h4>`; }
    else if (!l.trim()) { close(); }
    else { close(); html += `<p>${inline(l)}</p>`; }
  }
  close();
  return html;
}

let lastMode = null;
function render(s) {
  const modeChanged = lastMode !== null && s.mode !== lastMode;
  lastMode = s.mode;
  S = s;
  if (modeChanged) onModeChange();
  renderHeader();
  // non ridisegnare la lista mentre l'utente sta scrivendo in un campo dei dettagli (tranne al cambio Mock/Official)
  const ae = document.activeElement;
  if (modeChanged || (!(ae && ae.closest && ae.closest('.details')) && !drag)) renderLists();
}

function setTab(t) {
  tab = t;
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + t));
  if (t === 'ask') setTimeout(() => $('#askInput').focus(), 0);
  if (t === 'todo') setTimeout(() => $('#addInput').focus(), 0);
}

// --- eventi ---
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
$('#closeBtn').onclick = () => api.send('panel:hide');
$('#syncBtn').onclick = () => api.invoke('sync:now');
document.addEventListener('keydown', e => { if (e.key === 'Escape') api.send('panel:hide'); });

$('#addForm').addEventListener('submit', async e => {
  e.preventDefault();
  const v = $('#addInput').value.trim();
  if (!v) return;
  $('#addInput').value = '';
  await api.invoke('todo:add', v);
});

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  if (e.target.closest('[data-stop]') && el.dataset.act === 'expand') return;
  const id = el.closest('.item')?.dataset.id;
  const act = el.dataset.act;
  if (act === 'toggle') api.invoke('todo:toggle', id);
  else if (act === 'expand') { expanded.has(id) ? expanded.delete(id) : expanded.add(id); renderLists(); }
  else if (act === 'remove') { if (confirm('Eliminare questo to-do?')) api.invoke('todo:remove', id); }
  else if (act === 'open') api.invoke('open:url', el.dataset.url);
});

document.addEventListener('change', e => {
  const f = e.target.dataset?.field;
  if (!f) return;
  const id = e.target.closest('.item').dataset.id;
  api.invoke('todo:update', id, { [f]: e.target.value || null });
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.dataset?.field && e.target.tagName === 'INPUT') e.target.blur();
});
document.addEventListener('focusout', e => { if (e.target.closest?.('.details')) setTimeout(() => S && renderLists(), 0); });

api.on('state', render);
api.on('panel-shown', () => setTab(tab));
api.invoke('state:get').then(render);
setInterval(() => S && renderHeader(), 30000);

// ---------- appunti ----------
const NEW = '__new__';
let sug = null, sugSeq = 0, sugTimer = null, sugText = '', picked = false, notesInit = false, draftTimer = null;

function fillFolders(keep) {
  const sel = $('#folderSel');
  const cur = keep ?? sel.value;
  sel.innerHTML = (S.folders || []).map(f => '<option value="' + esc(f) + '">' + esc(f) + '</option>').join('')
    + '<option value="' + NEW + '">➕ Nuova cartella…</option>';
  sel.value = [...sel.options].some(o => o.value === cur) ? cur : ((S.folders || [])[0] || NEW);
  $('#newFolder').classList.toggle('hidden', sel.value !== NEW);
}

function showSuggestion() {
  const el = $('#suggest');
  el.classList.remove('busy');
  if (!sug) { el.textContent = '📁 Nessun suggerimento: scegli tu la cartella.'; return; }
  if (sug.folder) el.innerHTML = '📁 Cartella consigliata: <b>' + esc(sug.folder) + '</b> <span class="pct">' + sug.confidence + '%</span>';
  else el.innerHTML = '📁 Nessuna cartella adatta. Nuova consigliata: <b>' + esc(sug.newFolder || '—') + '</b>';
}

function applySuggestion() {
  showSuggestion();
  if (!sug) return;
  if (!picked) {
    if (sug.folder) { $('#folderSel').value = sug.folder; }
    else if (sug.newFolder) { $('#folderSel').value = NEW; $('#newFolder').value = sug.newFolder; }
    $('#newFolder').classList.toggle('hidden', $('#folderSel').value !== NEW);
  }
  if (sug.title && !$('#noteTitle').dataset.touched) $('#noteTitle').value = sug.title;
}

async function runSuggest() {
  const text = $('#noteText').value.trim();
  if (text.length < 15 || text === sugText) return;
  sugText = text;
  const seq = ++sugSeq;
  $('#suggest').classList.add('busy');
  $('#suggest').textContent = '📁 Sto cercando la cartella giusta…';
  const r = await api.invoke('notes:suggest', text);
  if (seq !== sugSeq) return;
  sug = r; applySuggestion();
}

function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => api.invoke('notes:draft', {
    text: $('#noteText').value, title: $('#noteTitle').value,
    folder: $('#folderSel').value === NEW ? null : $('#folderSel').value,
  }), 600);
}

function initNotes() {
  if (!S) return;
  if (!notesInit) {
    notesInit = true;
    if (S.draft && S.draft.text) {
      $('#noteText').value = S.draft.text;
      $('#noteTitle').value = S.draft.title || '';
      if (S.draft.title) $('#noteTitle').dataset.touched = '1';
    }
    fillFolders((S.draft && S.draft.folder) || undefined);
    if (S.draft && S.draft.folder) picked = true;
  } else fillFolders();
  if (S.draft && S.draft.text && !sug) runSuggest();
}

$('#noteText').addEventListener('input', () => {
  clearTimeout(sugTimer);
  sugTimer = setTimeout(runSuggest, 1500);
  $('#noteStatus').textContent = ''; saveDraft();
});
$('#noteText').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveNote(); } });
$('#noteTitle').addEventListener('input', e => { e.target.dataset.touched = e.target.value ? '1' : ''; saveDraft(); });
$('#folderSel').addEventListener('change', e => {
  picked = true;
  $('#newFolder').classList.toggle('hidden', e.target.value !== NEW);
  if (e.target.value === NEW) $('#newFolder').focus();
  saveDraft();
});

async function saveNote() {
  const text = $('#noteText').value.trim();
  const sel = $('#folderSel').value;
  const folder = sel === NEW ? $('#newFolder').value.trim() : sel;
  const st = $('#noteStatus');
  st.className = 'sub';
  if (!text) { st.textContent = 'Scrivi qualcosa prima.'; return; }
  if (!folder) { st.textContent = 'Dai un nome alla nuova cartella.'; $('#newFolder').focus(); return; }
  $('#noteSave').disabled = true;
  const r = await api.invoke('notes:save', { text, folder, title: $('#noteTitle').value.trim() });
  $('#noteSave').disabled = false;
  if (!r.ok) { st.textContent = '⚠️ ' + r.error; return; }
  $('#noteText').value = ''; $('#noteTitle').value = ''; $('#noteTitle').dataset.touched = '';
  $('#newFolder').value = ''; sug = null; sugText = ''; picked = false; sugSeq++;
  $('#suggest').textContent = '📁 Scrivi qualcosa e ti suggerisco la cartella…';
  st.className = 'sub ok'; st.textContent = '✅ Salvato in ' + r.path;
  fillFolders(folder);
}
$('#noteSave').onclick = saveNote;

// cambio Mock/Official: svuota tutto ciò che è rimasto a schermo dall'altro ambiente (bozze, campi, timer)
function onModeChange() {
  clearTimeout(draftTimer); clearTimeout(sugTimer);
  sug = null; sugSeq++; sugText = ''; picked = false; notesInit = false;
  $('#noteText').value = ''; $('#noteTitle').value = ''; $('#noteTitle').dataset.touched = '';
  $('#noteStatus').textContent = '';
  $('#suggest').className = 'suggest';
  $('#suggest').textContent = '📁 Scrivi qualcosa e ti suggerisco la cartella…';
  $('#addInput').value = '';
  expanded.clear();
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  if (tab === 'notes') initNotes();
}
document.querySelectorAll('#modeSw button').forEach(b => b.addEventListener('click', () => api.invoke('mode:set', b.dataset.mode)));

const _setTab = setTab;
setTab = function (t) { _setTab(t); if (t === 'notes') { initNotes(); setTimeout(() => $('#noteText').focus(), 0); } };
api.on('state', () => { if (notesInit && tab !== 'notes') fillFolders(); });

// ---------- animazione apertura/chiusura ----------
const appEl = document.querySelector('.app');
function setOrigin(o) {
  if (!o) return;
  appEl.style.setProperty('--ox', o.ox + 'px');
  appEl.style.setProperty('--oy', o.oy + 'px');
}
api.on('panel-shown', o => {
  setOrigin(o);
  appEl.classList.remove('closing');
  void appEl.offsetWidth;
  requestAnimationFrame(() => {
    appEl.classList.add('open');
    document.querySelectorAll('.tab.active .list > *').forEach((el, i) => {
      if (i < 14) { el.style.animationDelay = (140 + i * 38) + 'ms'; el.classList.add('rise'); }
    });
    setTimeout(() => document.querySelectorAll('.rise').forEach(el => { el.classList.remove('rise'); el.style.animationDelay = ''; }), 1200);
  });
});
api.on('panel-closing', o => {
  setOrigin(o);
  appEl.classList.remove('open');
  appEl.classList.add('closing');
});

// ---------- 9 quadratini: tieni premuto e trascina su/giù ----------
let drag = null;

function groupOf(id) { return groupsOrder.find(ids => ids.includes(id)) || null; }

document.addEventListener('pointerdown', e => {
  const grip = e.target.closest && e.target.closest('.grip');
  if (!grip || e.button !== 0) return;
  e.preventDefault();
  const item = grip.closest('.item');
  const id = item.dataset.id;
  const g = groupOf(id);
  if (!g) return;
  const els = g.map(gid => document.querySelector('.item[data-id="' + gid + '"]')).filter(Boolean);
  const rects = els.map(el => el.getBoundingClientRect());
  const from = g.indexOf(id);
  drag = { id, g, els, rects, from, to: from, item, startY: e.clientY, list: item.closest('.list'), scrollTop0: item.closest('.list').scrollTop, lastY: e.clientY };
  grip.setPointerCapture(e.pointerId);
  item.classList.add('dragging');
  document.body.classList.add('is-dragging');
  els.forEach(el => { if (el !== item) el.style.transition = 'transform .18s cubic-bezier(.2,.9,.3,1)'; });
  drag.raf = requestAnimationFrame(dragTick);
});

function dragLayout() {
  const d = drag;
  const scrollDelta = d.list.scrollTop - d.scrollTop0;
  const dy = d.lastY - d.startY + scrollDelta;
  d.item.style.transform = 'translateY(' + dy + 'px) scale(1.02)';
  // centro della voce trascinata (in coordinate "originali") -> nuova posizione
  const r = d.rects[d.from];
  const center = r.top + r.height / 2 + dy;
  let to = 0;
  for (let k = 0; k < d.rects.length; k++) {
    if (k === d.from) continue;
    const rk = d.rects[k];
    if (center > rk.top + rk.height / 2) to = k < d.from ? k + 1 : k;
  }
  // indice finale: quante voci (esclusa la trascinata) stanno sopra al centro
  let above = 0;
  for (let k = 0; k < d.rects.length; k++) if (k !== d.from && center > d.rects[k].top + d.rects[k].height / 2) above++;
  to = above;
  if (to !== d.to && navigator.vibrate) {}
  d.to = to;
  const h = r.height + 0; // spazio da liberare
  d.els.forEach((el, k) => {
    if (k === d.from) return;
    let shift = 0;
    if (d.from < to && k > d.from && k <= to) shift = -h;
    if (d.from > to && k >= to && k < d.from) shift = h;
    el.style.transform = shift ? 'translateY(' + shift + 'px)' : '';
  });
}

function dragTick() {
  if (!drag) return;
  // auto-scroll vicino ai bordi della lista
  const lr = drag.list.getBoundingClientRect();
  if (drag.lastY < lr.top + 40) drag.list.scrollTop -= Math.ceil((lr.top + 40 - drag.lastY) / 4);
  else if (drag.lastY > lr.bottom - 40) drag.list.scrollTop += Math.ceil((drag.lastY - (lr.bottom - 40)) / 4);
  dragLayout();
  drag.raf = requestAnimationFrame(dragTick);
}

document.addEventListener('pointermove', e => { if (drag) drag.lastY = e.clientY; });

function endDrag() {
  if (!drag) return;
  const d = drag; drag = null;
  cancelAnimationFrame(d.raf);
  document.body.classList.remove('is-dragging');
  const ids = [...d.g];
  ids.splice(d.from, 1);
  ids.splice(d.to, 0, d.id);
  if (d.to === d.from) {
    // nessuno spostamento: torna a posto con un rimbalzo
    d.item.animate([{ transform: d.item.style.transform }, { transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.2,1.4,.4,1)' });
    d.els.forEach(el => { el.style.transform = ''; el.style.transition = ''; });
    d.item.classList.remove('dragging');
    return;
  }
  // FLIP: ricostruisco la lista nel nuovo ordine e animo dal punto in cui ho lasciato la voce
  const first = new Map(d.els.map(el => [el.dataset.id, el.getBoundingClientRect().top]));
  ids.forEach((tid, k) => { const t = S.todos.find(x => x.id === tid); if (t) t.rank = (k + 1) * 10; });
  renderLists();
  ids.forEach(tid => {
    const n = document.querySelector('.item[data-id="' + tid + '"]');
    if (!n) return;
    const dy = (first.get(tid) ?? 0) - n.getBoundingClientRect().top;
    if (dy) n.animate([{ transform: 'translateY(' + dy + 'px)' + (tid === d.id ? ' scale(1.02)' : '') }, { transform: 'none' }],
      { duration: tid === d.id ? 260 : 180, easing: 'cubic-bezier(.2,1.2,.4,1)' });
  });
  const moved = document.querySelector('.item[data-id="' + d.id + '"]');
  if (moved) moved.animate([{ boxShadow: '0 0 0 2px var(--accent)' }, { boxShadow: '0 0 0 0 transparent' }], { duration: 700 });
  api.invoke('todo:reorder', ids);
}
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && drag) { drag.to = drag.from; endDrag(); e.stopPropagation(); } }, true);
