// Ask Gengar: interfaccia della chat (storico con pin, cluster nel second brain, suggerimento del cluster).
// Usa da panel.js: $, esc, md, api, setTab.
let AS = null;            // ultimo stato ricevuto dal main process
let pendingText = null;   // messaggio inviato, in attesa di risposta
let pendingConv = null;   // conversazione in cui è partito
let askFiles = [];        // allegati scelti e non ancora inviati
const NEW_CLUSTER = '__new__';
let askMode = null;        // Mock/Official: al cambio ricarico tutto
let askEpoch = 0;         // cresce a ogni cambio di modalità

function askRender() {
  if (!AS) return;
  renderAskBar();
  renderAskHistory();
  renderAskLog();
  renderSuggest();
}

// barra in alto: cluster (default "Chat vuota")
function renderAskBar() {
  const cur = AS.active.cluster || '';
  $('#askCluster').innerHTML = [
    '<option value="">Chat vuota</option>',
    ...AS.clusters.map(c => `<option value="${esc(c)}">📁 ${esc(c)}</option>`),
    `<option value="${NEW_CLUSTER}">➕ Nuovo cluster…</option>`,
  ].join('');
  $('#askCluster').value = cur;
}

// storico: fissate in alto, poi le recenti
function renderAskHistory() {
  const item = c => {
    const when = new Date(c.updatedAt).toLocaleDateString('it-IT', { day: '2-digit', month: 'short' });
    return `<div class="hitem${c.id === AS.activeId ? ' on' : ''}" data-open="${c.id}">
      <div class="hmain"><div class="htitle">${esc(c.title)}</div>
      <div class="hmeta">${c.cluster ? '📁 ' + esc(c.cluster) : 'chat vuota'} · ${when}</div></div>
      <button class="hpin${c.pinned ? ' on' : ''}" data-pin="${c.id}" title="${c.pinned ? 'Togli dai fissati' : 'Fissa in alto'}">📌</button>
    </div>`;
  };
  const pinned = AS.list.filter(c => c.pinned);
  const rest = AS.list.filter(c => !c.pinned);
  $('#askHistory').innerHTML = (pinned.length ? `<div class="hgroup">Fissate</div>${pinned.map(item).join('')}` : '')
    + (rest.length ? `<div class="hgroup">Recenti</div>${rest.map(item).join('')}` : '')
    || '<div class="hempty">Nessuna chat ancora.</div>';
}

function toggleHistory(force) {
  const el = $('#askHistory');
  const show = force ?? el.classList.contains('hidden');
  el.classList.toggle('hidden', !show);
  $('#askHist').classList.toggle('on', show);
}

function renderAskLog() {
  const log = $('#askLog');
  const msgs = AS.active.messages || [];
  const showPending = pendingText && pendingConv === AS.activeId;
  log.innerHTML = (msgs.length || showPending
    ? msgs.map(m => m.role === 'user'
      ? `<div class="msg user">${esc(m.text)}</div>`
      : `<div class="msg assistant">${md(m.text)}${m.model ? `<div class="sub">${esc(m.model)}</div>` : ''}</div>`).join('')
      + (showPending ? `<div class="msg user">${esc(pendingText)}</div><div class="msg assistant thinking"><span class="sparkle">✨ Gengar sta pensando…</span></div>` : '')
    : `<div class="chat-empty">✨ Sono Gengar 🧠<br>Conosco i tuoi to-do, le chiamate Granola e il second brain.<br>Chiedimi cosa fare, o aggiungi/sposta to-do. Puoi allegare audio, immagini o PDF.</div>`);
  log.scrollTop = log.scrollHeight;
  $('#askSend').disabled = !!pendingText || !!AS.busy;
}

// proposta di cluster per le chat senza cluster
function renderSuggest() {
  const s = AS.active.suggestion;
  const el = $('#askSuggest');
  if (!s || AS.active.cluster) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  el.innerHTML = `<span>💡 Suggerisco il cluster <b>${esc(s.cluster)}</b>${s.nuovo ? ' (nuovo)' : ''}</span>
    <span class="sbtns"><button class="ok" data-sok title="Accetta: archivia la chat in questo cluster">✅</button>
    <button class="no" data-sno title="Scarta la proposta">❌</button></span>`;
}

// ---------- allegati ----------
function renderAskFiles() {
  $('#askFiles').innerHTML = askFiles.map((f, i) => `<span>📎 ${esc(f.name)} <button type="button" data-i="${i}" title="Togli">✕</button></span>`).join('');
}

// ---------- azioni ----------
async function sendAsk(text) {
  text = text.trim();
  if ((!text && !askFiles.length) || pendingText || (AS && AS.busy)) return;
  const files = askFiles;
  askFiles = [];
  renderAskFiles();
  $('#askInput').value = '';
  const label = text || `(allegati: ${files.map(f => f.name).join(', ')})`;
  pendingText = label;
  pendingConv = AS.activeId;
  renderAskLog();
  try {
    const payload = await Promise.all(files.map(async f => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
    const epoch = askEpoch;
    const r = await api.invoke('ask:send', text, $('#askModel').value, payload);
    AS = epoch === askEpoch ? r : await api.invoke('ask:get'); // nel frattempo è cambiata modalità
  } catch (e) {
    AS = await api.invoke('ask:get');
  }
  pendingText = null;
  pendingConv = null;
  askRender();
}

$('#askForm').addEventListener('submit', e => { e.preventDefault(); sendAsk($('#askInput').value); });
$('#askInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAsk(e.target.value); } });
$('#askFile').addEventListener('change', e => { askFiles.push(...e.target.files); e.target.value = ''; renderAskFiles(); });
$('#askFiles').addEventListener('click', e => {
  const b = e.target.closest('button[data-i]');
  if (!b) return;
  askFiles.splice(Number(b.dataset.i), 1);
  renderAskFiles();
});
document.querySelectorAll('.quick [data-q]').forEach(b => b.addEventListener('click', () => { setTab('ask'); sendAsk(b.dataset.q); }));

$('#askNew').onclick = async () => { AS = await api.invoke('ask:new'); toggleHistory(false); askRender(); };
$('#askHist').onclick = () => toggleHistory();

$('#askHistory').addEventListener('click', async e => {
  const pin = e.target.closest('[data-pin]');
  if (pin) {
    const c = AS.list.find(x => x.id === pin.dataset.pin);
    AS = await api.invoke('ask:pin', c.id, !c.pinned);
    askRender();
    return;
  }
  const open = e.target.closest('[data-open]');
  if (open) {
    AS = await api.invoke('ask:open', open.dataset.open);
    toggleHistory(false);
    askRender();
  }
});

$('#askCluster').addEventListener('change', async e => {
  const v = e.target.value;
  if (v === NEW_CLUSTER) {
    $('#askNewCluster').classList.remove('hidden');
    $('#askNewClusterInput').focus();
    return;
  }
  AS = await api.invoke('ask:cluster', AS.activeId, v || null);
  askRender();
});
$('#askNewClusterInput').addEventListener('keydown', async e => {
  if (e.key === 'Escape') { e.target.value = ''; $('#askNewCluster').classList.add('hidden'); askRender(); return; }
  if (e.key !== 'Enter') return;
  const name = e.target.value.trim();
  if (!name) return;
  e.target.value = '';
  $('#askNewCluster').classList.add('hidden');
  AS = await api.invoke('ask:cluster', AS.activeId, name);
  askRender();
});

$('#askSuggest').addEventListener('click', async e => {
  if (e.target.closest('[data-sok]')) AS = await api.invoke('ask:cluster', AS.activeId, AS.active.suggestion.cluster);
  else if (e.target.closest('[data-sno]')) AS = await api.invoke('ask:dismiss', AS.activeId);
  else return;
  askRender();
});

api.invoke('ask:get').then(s => { AS = s; askRender(); });
api.on('state', async s => {
  if (askMode === null) { askMode = s.mode; return; }
  if (s.mode === askMode) return;
  askMode = s.mode;
  askEpoch++;
  pendingText = null; pendingConv = null; askFiles = []; renderAskFiles();
  $('#askInput').value = '';
  $('#askNewClusterInput').value = ''; $('#askNewClusterInput').classList.add('hidden');
  toggleHistory(false);
  AS = await api.invoke('ask:get');
  askRender();
});
