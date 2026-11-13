// "Ask Gengar": l'unica chat dell'app. Più conversazioni con storico, pin e cluster nel second brain.
// - Haiku di default; Sonnet/Opus sulle domande difficili (o scelta manuale)
// - legge e modifica i to-do (blocco <actions>), cerca nelle note Granola e nel vault (sottoagente "ricercatore")
// - allegati: immagini, PDF, testo -> letti da Claude (tool Read); audio/video -> trascritti in locale con Whisper
// - ogni scambio va nel log giornaliero <vault>/<askFolder>/AAAA-MM-GG.md
// - una conversazione può essere "archiviata" in un cluster: <vault>/<notesFolder>/<cluster>/<data - titolo>.md
// - se la chat è "vuota" (nessun cluster), dopo il primo scambio Haiku propone un cluster (accetta / scarta)
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { runClaude, extractJSON } = require('./claude');

const MODELS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
const BY_COMPLEXITY = { facile: 'haiku', media: 'sonnet', difficile: 'opus' };
const CONTEXT_TURNS = 10;   // ultimi messaggi passati al modello come contesto
const MAX_CONVERSATIONS = 300;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const AUDIO_EXT = new Set(['.ogg', '.opus', '.oga', '.m4a', '.mp3', '.wav', '.aac', '.flac', '.webm', '.mp4', '.mov', '.mpeg', '.mpga']);
const WEEKDAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];

const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayLabel = d => `${WEEKDAYS[d.getDay()]} ${isoDate(d)}, ore ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const safeName = s => String(s).replace(/[\\/:*?"<>|#^[\]]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 90) || 'chat';

class AskGengar {
  constructor(cfg, engine) {
    this.cfg = cfg;
    this.engine = engine;   // to-do, azioni sui to-do, elenco cluster
    this.file = path.join(cfg.dataDir, 'ask.json');
    this.attachDir = path.join(cfg.dataDir, 'attachments');
    this.notesDir = path.join(cfg.dataDir, 'notes');   // riassunti Granola (scritti dal sync)
    this.store = this._load();
    this.busy = false;
    this.busyId = null;
  }

  // ---------- persistenza ----------
  _load() {
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
    if (raw && Array.isArray(raw.conversations)) return { activeId: raw.activeId || null, conversations: raw.conversations };
    // formato vecchio (una sola chat): la porto in una conversazione
    const old = raw && Array.isArray(raw.history) ? raw.history : [];
    const conversations = old.length ? [this._mk({ messages: old, title: this._titleOf(old) })] : [];
    return { activeId: conversations[0]?.id || null, conversations };
  }

  _save() {
    try {
      this.store.conversations = this.store.conversations.slice(-MAX_CONVERSATIONS);
      fs.writeFileSync(this.file, JSON.stringify(this.store));
    } catch {}
  }

  _mk(extra = {}) {
    const now = new Date().toISOString();
    return {
      id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: 'Nuova chat', pinned: false, createdAt: now, updatedAt: now,
      cluster: null, vaultFile: null, suggestion: null, dismissed: false, messages: [],
      ...extra,
    };
  }

  _titleOf(messages) {
    const first = (messages.find(m => m.role === 'user') || {}).text || 'Nuova chat';
    return first.replace(/\s+/g, ' ').slice(0, 60) || 'Nuova chat';
  }

  _conv(id) { return this.store.conversations.find(c => c.id === id) || null; }

  _active() {
    let c = this._conv(this.store.activeId);
    if (!c) { c = this._mk(); this.store.conversations.push(c); this.store.activeId = c.id; }
    return c;
  }

  // ---------- stato per la UI ----------
  clusters() {
    const set = new Map();
    for (const n of [...this.engine.allFolders(), ...this.store.conversations.map(c => c.cluster).filter(Boolean)]) {
      if (!set.has(n.toLowerCase())) set.set(n.toLowerCase(), n);
    }
    return [...set.values()].sort((a, b) => a.localeCompare(b, 'it'));
  }

  snapshot() {
    const active = this._active();
    const list = this.store.conversations
      .map(c => ({ id: c.id, title: c.title, pinned: c.pinned, updatedAt: c.updatedAt, cluster: c.cluster }))
      .sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt > a.updatedAt ? 1 : -1));
    return {
      list, activeId: active.id, active, clusters: this.clusters(),
      busy: this.busy, busyId: this.busyId, vaultOk: !!this.cfg.vaultPath,
    };
  }

  // ---------- azioni sulle conversazioni ----------
  newChat() {
    const cur = this._conv(this.store.activeId);
    if (cur && !cur.messages.length) { this._save(); return this.snapshot(); } // già una chat vuota aperta: non ne creo un’altra
    const c = this._mk();
    this.store.conversations.push(c);
    this.store.activeId = c.id;
    this._save();
    return this.snapshot();
  }

  openChat(id) {
    if (this._conv(id)) { this.store.activeId = id; this._save(); }
    return this.snapshot();
  }

  setPinned(id, on) {
    const c = this._conv(id);
    if (c) { c.pinned = !!on; this._save(); }
    return this.snapshot();
  }

  // cluster null = chat vuota (la tolgo dal second brain)
  setCluster(id, cluster) {
    const c = this._conv(id);
    if (!c) return this.snapshot();
    c.cluster = cluster ? String(cluster).trim() || null : null;
    c.suggestion = null;
    if (!c.cluster) { this._removeFiled(c); }
    else this._fileConversation(c);
    this._save();
    return this.snapshot();
  }

  dismissSuggestion(id) {
    const c = this._conv(id);
    if (c) { c.suggestion = null; c.dismissed = true; this._save(); }
    return this.snapshot();
  }

  // ---------- second brain: archiviazione del cluster ----------
  _filePath(c) {
    const day = isoDate(new Date(c.createdAt));
    return path.join(this.cfg.vaultPath, this.cfg.notesFolder, safeName(c.cluster), `${day} - ${safeName(c.title)}.md`);
  }

  _removeFiled(c) {
    if (c.vaultFile && fs.existsSync(c.vaultFile)) { try { fs.unlinkSync(c.vaultFile); } catch {} }
    c.vaultFile = null;
  }

  _fileConversation(c) {
    if (!this.cfg.vaultPath || !c.cluster) return;
    try {
      const target = this._filePath(c);
      if (c.vaultFile && c.vaultFile !== target) this._removeFiled(c);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const body = c.messages.map(m => m.role === 'user'
        ? `**Tu:** ${m.text}${m.files?.length ? `\n_allegati: ${m.files.join(', ')}_` : ''}`
        : `**Gengar${m.model ? ` (${m.model})` : ''}:** ${m.text}`).join('\n\n');
      const md = `---
tags: [ask-gengar, chat]
cluster: "${c.cluster}"
creato: ${isoDate(new Date(c.createdAt))}
aggiornato: ${isoDate(new Date(c.updatedAt))}
fonte: Ask Gengar
---
# ${c.title}

${body}
`;
      fs.writeFileSync(target, md);
      c.vaultFile = target;
    } catch (e) {
      console.error('[ask file]', e.message);
    }
  }

  // ---------- allegati e trascrizione ----------
  _saveAttachment(f) {
    const data = Buffer.from(f.data);
    if (data.length > MAX_FILE_BYTES) throw new Error(`"${f.name}" supera i 200 MB`);
    fs.mkdirSync(this.attachDir, { recursive: true });
    const name = safeName(f.name);
    const file = path.join(this.attachDir, `${Date.now()}-${name}`);
    fs.writeFileSync(file, data);
    const kind = AUDIO_EXT.has(path.extname(name).toLowerCase()) ? 'audio' : 'file';
    return { name, path: file, kind };
  }

  // Trascrizione locale con Whisper: processo separato con Node di sistema (vedi src/transcribe.js).
  _transcribe(file) {
    return new Promise((resolve, reject) => {
      const child = spawn('node', [path.join(__dirname, 'transcribe.js'), file], { cwd: this.cfg.root, windowsHide: true });
      let out = '', err = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      const timer = setTimeout(() => { child.kill(); reject(new Error('trascrizione troppo lunga (oltre 60 minuti)')); }, 60 * 60 * 1000);
      child.on('error', e => { clearTimeout(timer); reject(new Error('impossibile avviare Node per la trascrizione: ' + e.message)); });
      child.on('close', () => {
        clearTimeout(timer);
        let j = null;
        try { j = JSON.parse(out.trim().split(/\r?\n/).pop()); } catch {}
        if (!j) return reject(new Error('trascrizione non riuscita: ' + (err || out).slice(0, 300)));
        if (j.error) return reject(new Error('trascrizione non riuscita: ' + j.error));
        resolve(j.text || '');
      });
    });
  }

  // ---------- modelli ----------
  // Un solo passaggio con Haiku: stima la difficoltà e se il messaggio è rilevante da tenere.
  async triage(text) {
    const prompt = `Classifica il messaggio qui sotto. Rispondi SOLO con un oggetto JSON, nient'altro:
{"complessita":"facile|media|difficile","rilevante":true|false}
- facile: saluti, domande semplici, curiosità, traduzioni brevi.
- media: spiegazioni, riassunti, consigli pratici, testi brevi, modifiche ai to-do.
- difficile: ragionamento complesso, analisi, priorità su molte cose, codice, decisioni importanti.
- rilevante: true se contiene informazioni, decisioni, lavoro o cose utili da ricordare; false per chiacchiere, prove, saluti.

MESSAGGIO:
${text}`;
    try {
      const r = await runClaude(prompt, { model: MODELS.haiku, cmd: this.cfg.claudeCmd, cwd: this.cfg.dataDir, timeoutMs: 60000 });
      const j = extractJSON(r.result) || {};
      return {
        complessita: BY_COMPLEXITY[j.complessita] ? j.complessita : 'media',
        rilevante: j.rilevante !== false,
      };
    } catch {
      return { complessita: 'media', rilevante: true };
    }
  }

  // Haiku propone il cluster per una chat ancora senza cluster. Restituisce {cluster, nuovo} o null.
  async _suggestCluster(c) {
    const clusters = this.engine.allFolders();
    const first = c.messages.find(m => m.role === 'user')?.text || '';
    const answer = c.messages.find(m => m.role === 'assistant')?.text || '';
    const prompt = `Devi scegliere dove archiviare una chat nel second brain di ${this.cfg.userName}.
CLUSTER ESISTENTI: ${JSON.stringify(clusters)}
PRIMO MESSAGGIO DELLA CHAT: ${first.slice(0, 1500)}
RISPOSTA: ${answer.slice(0, 1000)}

Se uno dei cluster esistenti è adatto, scegli quello. Altrimenti proponi un nome breve per un nuovo cluster.
Rispondi SOLO con JSON: {"cluster":"nome","nuovo":true|false}`;
    try {
      const r = await runClaude(prompt, { model: MODELS.haiku, cmd: this.cfg.claudeCmd, cwd: this.cfg.dataDir, timeoutMs: 60000 });
      const j = extractJSON(r.result) || {};
      if (!j.cluster || typeof j.cluster !== 'string') return null;
      const name = j.cluster.trim();
      const existing = clusters.find(x => x.toLowerCase() === name.toLowerCase());
      return { cluster: existing || name, nuovo: !existing };
    } catch {
      return null;
    }
  }

  // ---------- invio di un messaggio ----------
  // choice: 'auto' | 'haiku' | 'sonnet' | 'opus'; files: [{name, data: Uint8Array}]
  async ask(text, choice = 'auto', files = []) {
    text = (text || '').trim();
    if ((!text && !(files || []).length) || this.busy) return this.snapshot();
    this.busy = true;
    const conv = this._active();
    this.busyId = conv.id;
    const ts = new Date();
    try {
      const saved = (files || []).map(f => this._saveAttachment(f));
      const transcripts = [];
      for (const a of saved.filter(a => a.kind === 'audio')) {
        transcripts.push({ name: a.name, text: await this._transcribe(a.path) });
      }

      const recent = conv.messages.slice(-CONTEXT_TURNS)
        .map(m => `${m.role === 'user' ? 'Utente' : 'Gengar'}: ${m.text}`).join('\n');
      const msg = text || `(allegati: ${saved.map(a => a.name).join(', ')})`;
      const t = await this.triage(msg);
      const key = MODELS[choice] ? choice : BY_COMPLEXITY[t.complessita];
      if (!conv.messages.length) conv.title = this._titleOf([{ role: 'user', text: msg }]);
      conv.messages.push({ role: 'user', text: msg, ts: ts.toISOString(), files: saved.map(a => a.name) });
      conv.updatedAt = ts.toISOString();

      const vault = this.cfg.vaultPath;
      const todos = this.engine.chatTodos();
      const fileList = saved.filter(a => a.kind === 'file').map(a => `- ${a.path}  (${a.name})`).join('\n');
      const trList = transcripts.map(t => `[${t.name}]\n${t.text || '(silenzio o nessun parlato riconosciuto)'}`).join('\n\n');
      const prompt = `Sei Gengar, l'assistente personale di ${this.cfg.userName}: un consulente con moltissime call che fa fatica a starci dietro.
Il tuo compito: aiutarlo a capire cosa fare, in che ordine, a prepararlo alle cose, e rispondere a qualsiasi altra domanda.
Rispondi in italiano, chiaro, pratico, con elenchi quando servono. Niente premesse inutili.
Oggi è ${todayLabel(ts)}.

FONTI (sola lettura, con Read/Grep/Glob):
- Riassunti delle chiamate Granola: cartella "${this.notesDir}" (un file .md per chiamata, nome "YYYY-MM-DD - titolo.md"). È la fonte più aggiornata.
${vault ? `- Second brain Obsidian: "${vault}". Trascrizioni in "Granola/Transcripts". Le note giornaliere YYYY-MM-DD.md sono enormi: usa Grep, non leggerle intere.` : ''}
Cerca nelle fonti solo se la domanda lo richiede (persone, progetti, cosa è stato detto). Per le priorità bastano i to-do qui sotto.
${fileList ? `- Allegati dell'utente: leggili con il tool Read (funzionano anche immagini e PDF):\n${fileList}\n` : ''}
${trList ? `TRASCRIZIONI DEGLI AUDIO (fatte in locale con Whisper, possono avere errori):\n${trList}\n` : ''}
SEI L'ORCHESTRATORE: per ricerche nelle fonti delega al sottoagente "ricercatore" tramite il tool Agent;
se servono più ricerche indipendenti lancia più ricercatori in parallelo. Tu ragioni, sintetizzi e decidi.
Per un controllo puntuale e piccolo puoi usare Grep direttamente.

TO-DO ATTUALI (JSON):
${JSON.stringify(todos)}

Se l'utente ti chiede di aggiungere, modificare, completare o riprioritizzare to-do, fallo davvero: in fondo alla risposta aggiungi
<actions>[{"op":"add","title":"...","detail":"...","nextStep":"...","project":"...","due":"YYYY-MM-DD|null","priority":"alta|media|bassa","status":"open|waiting","waitingOn":null},
{"op":"update","id":"...", ...campi da cambiare},
{"op":"done","id":"..."}]</actions>
Ometti il blocco se non serve.

${recent ? `CONVERSAZIONE FINORA:\n${recent}\n\n` : ''}MESSAGGIO DI ${this.cfg.userName.toUpperCase()}:
${msg}`;

      const r = await runClaude(prompt, {
        model: MODELS[key], cmd: this.cfg.claudeCmd, cwd: this.cfg.dataDir, timeoutMs: 300000,
        tools: ['Read', 'Grep', 'Glob', 'Agent'],
        addDirs: [this.notesDir, this.attachDir, vault].filter(Boolean),
        agentsFile: this.engine._agentsFile(),
      });

      let answer = r.result || '(nessuna risposta)';
      let applied = 0;
      const m = answer.match(/<actions>([\s\S]*?)<\/actions>/);
      if (m) {
        answer = answer.replace(m[0], '').trim();
        try { applied = this.engine.applyTodoActions(JSON.parse(m[1])); } catch (e) { console.error('[ask actions]', e.message); }
      }
      if (applied) answer += `\n\n_✅ ${applied} modifica/e applicata/e alla lista._`;

      conv.messages.push({ role: 'assistant', text: answer, model: key, ts: new Date().toISOString() });
      conv.updatedAt = new Date().toISOString();
      this._logVault(msg, answer, key, t.rilevante, ts, saved.map(a => a.name));
      if (conv.cluster) this._fileConversation(conv);
      else if (!conv.dismissed && !conv.suggestion && conv.messages.length >= 2) {
        conv.suggestion = await this._suggestCluster(conv);
      }
    } catch (e) {
      conv.messages.push({ role: 'assistant', text: `⚠️ ${e.message}`, ts: new Date().toISOString() });
    } finally {
      this.busy = false;
      this.busyId = null;
      this._save();
    }
    return this.snapshot();
  }

  // Log giornaliero nel vault. I messaggi non rilevanti restano nel file ma con tag #non-rilevante.
  _logVault(q, a, model, rilevante, ts, files = []) {
    const vault = this.cfg.vaultPath;
    if (!vault) return;
    try {
      const dir = path.join(vault, this.cfg.askFolder || 'Ask Gengar');
      fs.mkdirSync(dir, { recursive: true });
      const day = isoDate(ts);
      const file = path.join(dir, day + '.md');
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, `---\ntags: [ask-gengar]\ndata: ${day}\n---\n# Ask Gengar · ${day}\n`);
      }
      const hhmm = `${pad(ts.getHours())}:${pad(ts.getMinutes())}`;
      const tag = rilevante ? '' : ' · #non-rilevante';
      const att = files.length ? `\n_allegati: ${files.join(', ')}_` : '';
      fs.appendFileSync(file, `\n## ${hhmm} · ${model}${tag}\n**Tu:** ${q}${att}\n\n**Gengar:** ${a}\n`);
    } catch (e) {
      console.error('[ask vault]', e.message);
    }
  }
}

module.exports = { AskGengar, MODELS };
