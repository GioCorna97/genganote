// Motore: stato dei to-do (JSON locale), sync Granola -> Claude, arricchimento, mirror nel vault. La chat è in ask.js.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');
const { runClaude, extractJSON } = require('./claude');
const granola = require('./granola');

const PRIO = { alta: 0, media: 1, bassa: 2 };
const STATUSES = ['open', 'waiting', 'done'];
const WEEKDAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];

const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => isoDate(new Date());
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return isoDate(d); };
const todayLabel = () => { const d = new Date(); return `${WEEKDAYS[d.getDay()]} ${isoDate(d)}, ore ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');
const chunks = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };
const safeName = s => s.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);

function noteTitle(n) {
  if (n.title) return n.title;
  const d = new Date(n.created_at);
  return `Nota senza titolo ${isoDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

class Engine extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.notesDir = path.join(cfg.dataDir, 'notes');
    fs.mkdirSync(this.notesDir, { recursive: true });
    this.file = path.join(cfg.dataDir, 'state.json');
    this.state = this._load();
    this.syncing = false;
    this.syncProgress = null;
    this.lastError = null;
    this.busy = new Set();     // id dei to-do in arricchimento
    this._mirrorTimer = null;
  }

  // ---------- stato ----------
  _load() {
    const empty = { todos: [], processedNotes: {}, lastSync: null, lastSyncResult: null, folders: [], draft: { text: '', title: '', folder: null } };
    try { return { ...empty, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch { return empty; }
  }

  save() {
    const data = JSON.stringify(this.state, null, 2);
    const tmp = this.file + '.tmp';
    try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, this.file); } catch { fs.writeFileSync(this.file, data); }
    this._scheduleVaultMirror();
    this.emit('change');
  }

  // urgente = scade tra oggi e domani, o è scaduto da max 2 giorni (quelli più vecchi sono "stale", non accendono il 🔥)
  isUrgent(t) { return t.status === 'open' && !!t.due && t.due <= addDays(today(), 1) && t.due >= addDays(today(), -2); }
  isStale(t) { return t.status === 'open' && !!t.due && t.due < addDays(today(), -2); }

  stats() {
    const open = this.state.todos.filter(t => t.status === 'open');
    return {
      open: open.length,
      urgent: open.filter(t => this.isUrgent(t)).length,
      waiting: this.state.todos.filter(t => t.status === 'waiting').length,
    };
  }

  snapshot() {
    return {
      todos: this.state.todos,
      lastSync: this.state.lastSync,
      lastSyncResult: this.state.lastSyncResult,
      syncing: this.syncing,
      syncProgress: this.syncProgress,
      lastError: this.lastError,
      enriching: [...this.busy],
      folders: this.allFolders(),
      draft: this.state.draft,
      stats: this.stats(),
      today: today(),
      vaultPath: this.cfg.vaultPath,
      hasGranola: !!this.cfg.granolaApiKey,
      syncMinutes: this.cfg.syncMinutes,
    };
  }

  // ---------- to-do CRUD ----------
  _normalize(raw, base) {
    const t = { ...base };
    for (const k of ['title', 'detail', 'nextStep', 'project', 'waitingOn']) {
      if (raw[k] !== undefined) t[k] = raw[k] == null || raw[k] === '' ? null : String(raw[k]).trim();
    }
    if (raw.people !== undefined) t.people = Array.isArray(raw.people) ? raw.people.map(String) : [];
    if (raw.due !== undefined) t.due = /^\d{4}-\d{2}-\d{2}$/.test(raw.due || '') ? raw.due : null;
    if (raw.priority !== undefined && PRIO[raw.priority] !== undefined) t.priority = raw.priority;
    if (raw.status !== undefined && STATUSES.includes(raw.status) && raw.status !== t.status) {
      t.doneAt = raw.status === 'done' ? new Date().toISOString() : null;
      t.status = raw.status;
    }
    if (!t.title) t.title = '(senza titolo)';
    t.updatedAt = new Date().toISOString();
    return t;
  }

  _newTodo(raw, source) {
    const now = new Date().toISOString();
    return this._normalize(raw, {
      id: crypto.randomUUID().slice(0, 8), title: '', detail: null, nextStep: null, project: null,
      people: [], due: null, priority: 'media', status: 'open', waitingOn: null,
      source, createdAt: now, doneAt: null,
    });
  }

  find(id) { return this.state.todos.find(t => t.id === id); }

  update(id, patch) {
    const i = this.state.todos.findIndex(t => t.id === id);
    if (i < 0) return null;
    this.state.todos[i] = this._normalize(patch, this.state.todos[i]);
    this.save();
    return this.state.todos[i];
  }

  toggle(id) {
    const t = this.find(id);
    if (!t) return null;
    return this.update(id, { status: t.status === 'done' ? 'open' : 'done' });
  }

  // ordine manuale: salva la posizione di ogni to-do del gruppo (usata da pannello e file nel vault)
  setRanks(ids) {
    if (!Array.isArray(ids)) return;
    ids.forEach((id, k) => { const t = this.find(id); if (t) t.rank = (k + 1) * 10; });
    this.save();
  }

  remove(id) {
    this.state.todos = this.state.todos.filter(t => t.id !== id);
    this.save();
  }

  addManual(text) {
    text = (text || '').trim();
    if (!text) return null;
    const t = this._newTodo({ title: text }, { type: 'manual' });
    this.state.todos.unshift(t);
    this.save();
    this._enrich(t.id, text); // async, non blocca la UI
    return t;
  }

  _projects() { return [...new Set(this.state.todos.map(t => t.project).filter(Boolean))].slice(0, 40); }

  async _enrich(id, text) {
    this.busy.add(id); this.emit('change');
    try {
      const prompt = `Sei l'assistente to-do di ${this.cfg.userName}. Oggi è ${todayLabel()}.
Trasforma questo appunto in un to-do strutturato.

APPUNTO: """${text}"""

Progetti/clienti già in uso (riusa lo stesso nome se pertinente): ${JSON.stringify(this._projects())}

Rispondi SOLO con un oggetto JSON, nessun altro testo:
{"title": "imperativo, breve, max 10 parole",
 "detail": "contesto in 1 frase oppure null",
 "nextStep": "primo passo concreto e piccolo, max 15 parole",
 "project": "progetto/cliente oppure null",
 "people": ["persone coinvolte"],
 "due": "YYYY-MM-DD oppure null (converti 'domani', 'venerdì', 'fine mese'...)",
 "priority": "alta|media|bassa",
 "status": "open, oppure waiting se è qualcosa che ${this.cfg.userName} aspetta da altri",
 "waitingOn": "persona attesa oppure null"}`;
      const { result } = await runClaude(prompt, { model: this.cfg.model, cmd: this.cfg.claudeCmd, cwd: this.cfg.dataDir, timeoutMs: 120000 });
      const j = extractJSON(result);
      const t = this.find(id);
      if (t && j) {
        if (t.title !== text) delete j.title; // l'utente l'ha già modificato a mano
        this.update(id, j);
      }
    } catch (e) {
      console.error('[enrich]', e.message);
    } finally {
      this.busy.delete(id); this.emit('change');
    }
  }

  // ---------- sync Granola ----------
  async sync() {
    if (this.syncing) return null;
    if (this.cfg.mock) { // modalità Mock: nessuna chiamata a Granola, simulo solo un sync riuscito
      this.syncing = true; this.lastError = null; this.syncProgress = 'Leggo Granola…'; this.emit('change');
      await new Promise(r => setTimeout(r, 1200));
      this.syncing = false; this.syncProgress = null;
      this.state.lastSync = new Date().toISOString();
      this.state.lastSyncResult = { notes: 0, added: 0, updated: 0 };
      this.save();
      return this.state.lastSyncResult;
    }
    if (!this.cfg.granolaApiKey) {
      this.lastError = 'API key Granola non trovata (plugin granola-sync o config.json)';
      this.emit('change');
      return null;
    }
    this.syncing = true; this.lastError = null; this.syncProgress = 'Leggo Granola…'; this.emit('change');
    const res = { notes: 0, added: 0, updated: 0 };
    try {
      const key = this.cfg.granolaApiKey;
      await this.fetchFolders().catch(() => {});
      const since = new Date();
      since.setDate(since.getDate() - (this.state.lastSync ? 3 : this.cfg.firstSyncDaysBack));
      since.setHours(0, 0, 0, 0);

      const list = await granola.listNotes(key, since.toISOString());
      const changed = list
        .filter(n => !n.deleted_at && this.state.processedNotes[n.id]?.updatedAt !== n.updated_at)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));

      const toProcess = [];
      for (const n of changed) {
        const d = await granola.getNote(key, n.id);
        const summary = (d.summary_markdown || d.summary_text || '').trim();
        if (!summary) continue; // riunione in corso / riassunto non ancora pronto: riprovo al prossimo giro
        this._mirrorNote(d);
        const hash = sha1(summary + (d.private_notes_markdown || ''));
        const prev = this.state.processedNotes[n.id];
        if (prev && prev.hash === hash) { prev.updatedAt = n.updated_at; continue; }
        toProcess.push({ d, hash });
      }

      const batches = chunks(toProcess, 4);
      for (let i = 0; i < batches.length; i++) {
        this.syncProgress = `Analizzo chiamate ${i * 4 + 1}-${Math.min((i + 1) * 4, toProcess.length)} di ${toProcess.length}…`;
        this.emit('change');
        const r = await this._extract(batches[i].map(x => x.d));
        res.added += r.added; res.updated += r.updated;
        for (const x of batches[i]) {
          this.state.processedNotes[x.d.id] = { updatedAt: x.d.updated_at, hash: x.hash, title: noteTitle(x.d) };
        }
        this.save(); // i to-do compaiono man mano
      }
      res.notes = toProcess.length;
      this.state.lastSync = new Date().toISOString();
      this.state.lastSyncResult = res;
      this.save();
    } catch (e) {
      console.error('[sync]', e);
      this.lastError = e.message;
    } finally {
      this.syncing = false; this.syncProgress = null; this.emit('change');
    }
    return res;
  }

  _noteBlock(d) {
    const people = (d.attendees || []).map(a => a.name || a.email).filter(Boolean).join(', ');
    const folders = (d.folder_membership || []).map(f => f.title || f.name).filter(Boolean).join(', ');
    let s = `=== NOTA id=${d.id} ===\nTitolo: ${noteTitle(d)}\nData: ${d.created_at}\nPartecipanti: ${people || 'n/d'}\n`;
    if (folders) s += `Cartelle Granola: ${folders}\n`;
    s += `\n${(d.summary_markdown || d.summary_text || '').trim()}\n`;
    const priv = (d.private_notes_markdown || '').trim();
    if (priv) s += `\nAppunti privati di ${this.cfg.userName}:\n${priv}\n`;
    return s;
  }

  async _extract(notes) {
    const existing = this.state.todos
      .filter(t => t.status !== 'done' || (t.doneAt && t.doneAt > addDays(today(), -7)))
      .slice(0, 200)
      .map(t => ({ id: t.id, title: t.title, project: t.project, due: t.due, status: t.status, noteId: t.source?.noteId || null }));

    const prompt = `Sei l'assistente personale di ${this.cfg.userName} (consulente, fa moltissime call). Oggi è ${todayLabel()}.
Estrai le azioni concrete dalle note di riunione qui sotto (riassunti generati da Granola).

REGOLE
- Azioni che deve fare ${this.cfg.userName} (assegnate a lui, o senza assegnatario ma chiaramente sue) -> status "open".
- Cose che ${this.cfg.userName} aspetta da altri e che deve seguire -> status "waiting" con "waitingOn".
- Ignora azioni di altri che non lo riguardano, discorsi generici, cose già fatte durante la call.
- Parti dalla sezione "Prossimi Passi" se c'è, ma controlla anche il resto della nota.
- NON creare duplicati: se un'azione corrisponde a un to-do già esistente (lista sotto), mettila in "updates" con il suo id
  (aggiorna scadenza/next step/stato se la nota aggiunge informazioni; status "done" se la nota dice che è stata fatta).
- title: imperativo, breve (max 10 parole). detail: contesto utile in 1-2 frasi (chi, perché).
- nextStep: il primo passo concreto e piccolo per sbloccarla (max 15 parole).
- due: YYYY-MM-DD se deducibile (es. "lunedì" -> data relativa alla data della nota), altrimenti null.
- priority: "alta" se scadenza entro 2 giorni, richiesta da cliente/responsabile o bloccante per altri; "bassa" se nice-to-have; altrimenti "media".
- project: nome breve del progetto/cliente. Riusa questi nomi se pertinenti: ${JSON.stringify(this._projects())}
- Note vecchie di più giorni: le azioni con scadenza passata restano valide, ma non inventare urgenze.

TO-DO ESISTENTI:
${JSON.stringify(existing)}

NOTE:
${notes.map(d => this._noteBlock(d)).join('\n')}

Rispondi SOLO con un oggetto JSON, nessun altro testo:
{"new":[{"noteId":"...","title":"...","detail":"...","nextStep":"...","project":"...","people":["..."],"due":null,"priority":"media","status":"open","waitingOn":null}],
 "updates":[{"id":"id esistente","noteId":"...","nextStep":"...","due":"...","priority":"...","status":"..."}]}`;

    const { result } = await runClaude(prompt, { model: this.cfg.model, cmd: this.cfg.claudeCmd, cwd: this.cfg.dataDir, timeoutMs: 300000 });
    const j = extractJSON(result);
    if (!j) throw new Error('Claude non ha restituito JSON valido durante l\'estrazione');

    const byId = Object.fromEntries(notes.map(d => [d.id, d]));
    const src = noteId => {
      const d = byId[noteId] || notes[0];
      return { type: 'granola', noteId: d.id, title: noteTitle(d), url: d.web_url || null, date: d.created_at };
    };
    let added = 0, updated = 0;
    for (const n of j.new || []) {
      if (!n || !n.title) continue;
      const t = this._newTodo(n, src(n.noteId));
      this.state.todos.unshift(t);
      added++;
    }
    for (const u of j.updates || []) {
      const i = this.state.todos.findIndex(t => t.id === u.id);
      if (i < 0) continue;
      const { id, noteId, ...patch } = u;
      const t = this._normalize(patch, this.state.todos[i]);
      t.lastMention = src(noteId);
      this.state.todos[i] = t;
      updated++;
    }
    return { added, updated };
  }

  // copia locale dei riassunti (usata dalla chat, anche se il sync Obsidian è fermo)
  _mirrorNote(d) {
    try {
      const date = isoDate(new Date(d.created_at));
      const file = path.join(this.notesDir, `${date} - ${safeName(noteTitle(d))}.md`);
      const people = (d.attendees || []).map(a => a.name || a.email).filter(Boolean).join(', ');
      const body = `# ${noteTitle(d)}\n\n- Data: ${d.created_at}\n- Partecipanti: ${people}\n- Granola: ${d.web_url || ''}\n- id: ${d.id}\n\n`
        + (d.summary_markdown || d.summary_text || '')
        + (d.private_notes_markdown ? `\n\n## Appunti privati\n\n${d.private_notes_markdown}` : '');
      fs.writeFileSync(file, body);
    } catch (e) { console.error('[mirrorNote]', e.message); }
  }

  // ---------- to-do per la chat (Ask Gengar) ----------
  chatTodos() {
    return this.state.todos
      .filter(t => t.status !== "done" || (t.doneAt && t.doneAt > addDays(today(), -7)))
      .map(t => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, due: t.due, project: t.project,
        nextStep: t.nextStep, detail: t.detail, people: t.people, waitingOn: t.waitingOn, fonte: t.source?.title || "manuale" }));
  }

  // applica le modifiche ai to-do proposte dalla chat (blocco <actions>)
  applyTodoActions(actions) {
    const n = this._applyActions(actions);
    if (n) { this.save(); this.emit("change"); }
    return n;
  }

  // ---------- appunti -> Obsidian ----------
  _vaultNotesDir() { return path.join(this.cfg.vaultPath, this.cfg.notesFolder); }

  // cartelle già presenti nel vault sotto "Appunti/"
  _vaultFolders() {
    try {
      return fs.readdirSync(this._vaultNotesDir(), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    } catch { return []; }
  }

  async fetchFolders() {
    let names = [];
    try {
      if (this.cfg.granolaApiKey && !this.cfg.mock) names = (await granola.listFolders(this.cfg.granolaApiKey)).map(f => f.title || f.name).filter(Boolean);
    } catch (e) { console.error('[folders]', e.message); }
    if (!names.length && this.cfg.vaultPath) { // fallback: cache del plugin Obsidian granola-sync
      try {
        const d = JSON.parse(fs.readFileSync(path.join(this.cfg.vaultPath, '.obsidian', 'plugins', 'granola-sync', 'data.json'), 'utf8'));
        names = Object.values(d._folderMapCache?.folders || {}).map(f => f.title).filter(Boolean);
      } catch {}
    }
    if (names.length) { this.state.folders = names; this.save(); }
    return this.allFolders();
  }

  allFolders() {
    const seen = new Map();
    for (const n of [...(this.state.folders || []), ...(this.cfg.vaultPath ? this._vaultFolders() : [])]) {
      if (!seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n);
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b, 'it'));
  }

  setDraft(d) { this.state.draft = { text: d.text || '', title: d.title || '', folder: d.folder || null }; this.save(); }

  // stima la cartella giusta per l'appunto (Haiku)
  async suggestFolder(text) {
    text = (text || '').trim();
    if (text.length < 15) return null;
    const folders = this.allFolders();
    const prompt = `Devi archiviare un appunto di ${this.cfg.userName} in una cartella.

CARTELLE DISPONIBILI (derivate dai progetti/clienti in Granola): ${JSON.stringify(folders)}

APPUNTO:
"""
${text.slice(0, 4000)}
"""

Scegli la cartella più adatta tra quelle disponibili, usando il nome ESATTO. Se nessuna è davvero pertinente, folder = null e proponi un nome breve per una nuova cartella (newFolder).
"confidence" è la tua sicurezza da 0 a 100. Proponi anche un titolo breve (max 6 parole, senza caratteri speciali).
Rispondi SOLO con JSON: {"folder": "nome esatto o null", "confidence": 0, "newFolder": "nome o null", "title": "..."}`;
    const { result } = await runClaude(prompt, { model: this.cfg.model, cmd: this.cfg.claudeCmd, cwd: this.cfg.dataDir, timeoutMs: 90000 });
    const j = extractJSON(result);
    if (!j) return null;
    const match = j.folder && folders.find(f => f.toLowerCase() === String(j.folder).toLowerCase());
    return {
      folder: match || null,
      confidence: Math.max(0, Math.min(100, Math.round(Number(j.confidence) || 0))),
      newFolder: match ? null : (j.newFolder || (j.folder && !match ? j.folder : null) || null),
      title: j.title ? String(j.title).slice(0, 80) : '',
    };
  }

  // salva l'appunto come file .md nel vault: <vault>/Appunti/<cartella>/<data ora - titolo>.md
  saveNote({ text, folder, title }) {
    text = (text || '').trim();
    folder = safeName(folder || '') || 'Generale';
    if (!text) throw new Error('Appunto vuoto');
    if (!this.cfg.vaultPath) throw new Error('Vault Obsidian non trovato');
    const now = new Date();
    title = safeName(title || '') || safeName(text.split(/\r?\n/)[0]).slice(0, 50) || 'Appunto';
    const dir = path.join(this._vaultNotesDir(), folder);
    fs.mkdirSync(dir, { recursive: true });
    const base = `${isoDate(now)} ${pad(now.getHours())}${pad(now.getMinutes())} - ${title}`;
    let file = path.join(dir, base + '.md'), i = 2;
    while (fs.existsSync(file)) file = path.join(dir, `${base} (${i++}).md`);
    const md = `---
tags: [appunto]
cartella: "${folder}"
creato: ${isoDate(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}
fonte: GengaNote
---
# ${title}

${text}
`;
    fs.writeFileSync(file, md);
    this.state.draft = { text: '', title: '', folder: null };
    this.save();
    return path.relative(this.cfg.vaultPath, file).replace(/\\/g, '/');
  }

  // Definizione dei sottoagenti (Haiku) usati da Ask Gengar.
  _agentsFile() {
    const file = path.join(this.cfg.dataDir, 'agents.json');
    const sources = [this.notesDir, this.cfg.vaultPath].filter(Boolean).map(p => `"${p}"`).join(' e ');
    const agents = {
      ricercatore: {
        description: 'Ricerca veloce nelle note delle chiamate Granola e nel second brain Obsidian. Usalo per trovare cosa è stato detto, chi ha promesso cosa, contesto su persone e progetti.',
        prompt: `Sei un ricercatore veloce. Cerca nelle cartelle ${sources} usando Grep/Glob/Read le informazioni richieste.
Le note giornaliere YYYY-MM-DD.md del vault sono enormi: usa Grep con contesto, non leggerle intere.
Restituisci solo i fatti trovati, in italiano, in elenco puntato, con data e titolo della chiamata come fonte. Se non trovi nulla dillo chiaramente. Non inventare.`,
        tools: ['Read', 'Grep', 'Glob'],
        model: this.cfg.subagentModel,
      },
    };
    try { fs.writeFileSync(file, JSON.stringify(agents, null, 2)); } catch {}
    return file;
  }

  _applyActions(actions) {
    let n = 0;
    for (const a of Array.isArray(actions) ? actions : []) {
      const { op, id, ...rest } = a || {};
      if (op === 'add' && rest.title) { this.state.todos.unshift(this._newTodo(rest, { type: 'chat' })); n++; }
      else if (op === 'update' && this.find(id)) { const i = this.state.todos.findIndex(t => t.id === id); this.state.todos[i] = this._normalize(rest, this.state.todos[i]); n++; }
      else if (op === 'done' && this.find(id)) { const i = this.state.todos.findIndex(t => t.id === id); this.state.todos[i] = this._normalize({ status: 'done' }, this.state.todos[i]); n++; }
    }
    return n;
  }

  // ---------- mirror nel vault Obsidian ----------
  _scheduleVaultMirror() {
    if (!this.cfg.vaultPath || !this.cfg.vaultTodoFile) return;
    clearTimeout(this._mirrorTimer);
    this._mirrorTimer = setTimeout(() => this._writeVaultMirror(), 2000);
  }

  _writeVaultMirror() {
    try {
      const T = this.state.todos;
      const line = t => {
        const bits = [];
        if (t.due) bits.push(`📅 ${t.due}`);
        if (t.project) bits.push(t.project);
        if (t.waitingOn) bits.push(`⏳ ${t.waitingOn}`);
        if (t.source?.title) bits.push(t.source.url ? `[${t.source.title}](${t.source.url})` : t.source.title);
        let s = `- [${t.status === 'done' ? 'x' : ' '}] **${t.title}**${bits.length ? ' — ' + bits.join(' · ') : ''}`;
        if (t.nextStep && t.status !== 'done') s += `\n    - → ${t.nextStep}`;
        return s;
      };
      const open = sortTodos(T.filter(t => t.status === 'open'), this);
      const urgent = open.filter(t => this.isUrgent(t));
      const stale = open.filter(t => this.isStale(t));
      const rest = open.filter(t => !this.isUrgent(t) && !this.isStale(t));
      const waiting = T.filter(t => t.status === 'waiting');
      const done = T.filter(t => t.status === 'done' && t.doneAt && t.doneAt > addDays(today(), -7));
      const d = new Date();
      const md = `---\ntags: [todo, assistente]\naggiornato: ${isoDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}\n---\n`
        + `# 🧠 To-Do\n\n> Generato automaticamente dal widget 🧠. Le modifiche fatte qui vengono sovrascritte: modifica dal widget.\n\n`
        + `## ⚠️ Urgenti\n${urgent.map(line).join('\n') || '_niente_'}\n\n`
        + `## 📌 Da fare\n${rest.map(line).join('\n') || '_niente_'}\n\n`
        + `## ⏳ In attesa di altri\n${waiting.map(line).join('\n') || '_niente_'}\n\n`
        + `## ✅ Fatti (ultimi 7 giorni)\n${done.map(line).join('\n') || '_niente_'}\n`;
      fs.writeFileSync(path.join(this.cfg.vaultPath, this.cfg.vaultTodoFile), md);
    } catch (e) { console.error('[vault mirror]', e.message); }
  }
}

function sortTodos(list, engine) {
  return [...list].sort((a, b) =>
    (engine.isUrgent(b) - engine.isUrgent(a))
    || ((a.rank != null && b.rank != null) ? a.rank - b.rank : (a.rank != null) !== (b.rank != null) ? (a.rank != null ? 1 : -1) : 0)
    || (PRIO[a.priority] - PRIO[b.priority])
    || ((a.due || '9999') .localeCompare(b.due || '9999'))
    || (b.createdAt || '').localeCompare(a.createdAt || ''));
}

module.exports = { Engine, sortTodos };
