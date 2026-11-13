// Dati sintetici per la modalità Mock (screenshot e video senza dati del cliente né personali).
// Tutto vive in <root>/data-mock: to-do, note "Granola", vault con appunti, chat di Ask Gengar.
// Aziende, persone e progetti sono inventati. Le date sono relative a oggi, quindi si rigenera una volta al giorno.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const day = n => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return d; };
const dd = n => isoDate(day(n));
const at = (n, h, m = 0) => { const d = day(n); d.setHours(h, m, 0, 0); return d.toISOString(); };
const id = () => crypto.randomUUID().slice(0, 8);

const MEETINGS = [
  { n: -6, title: 'Kickoff Progetto Atlas con Nordwind Logistics', body: `## Partecipanti
Marta Bianchi (Nordwind), Luca Ferri, Alex

## Punti chiave
- Obiettivo: ridurre del 15% i tempi di consegna nel nord Italia entro giugno.
- Prima fase: analisi dei dati di magazzino (8 settimane).
- Nordwind chiede una proposta economica entro la settimana.

## Azioni
- Alex: inviare la proposta economica.
- Luca: rivedere il capitolo costi.
- Marta: condividere i dati storici di magazzino.` },
  { n: -4, title: 'Allineamento pricing Aurora Retail', body: `## Partecipanti
Sara Conti (Aurora Retail), Alex

## Punti chiave
- Aurora vuole un modello di pricing dinamico per 40 negozi.
- Servono i dati di vendita Q3 per stimare l'elasticità.
- Sara manda un vocale con i dubbi sui margini.

## Azioni
- Sara: inviare i dati di vendita Q3.
- Alex: rispondere sui margini entro ieri.` },
  { n: -3, title: 'Workshop KPI Helios Energy', body: `## Partecipanti
Elena Greco (Helios Energy), Davide Russo, Alex

## Punti chiave
- Dashboard per il management con 5 KPI principali.
- Fonte dati: contatori smart + CRM.
- Il legale di Helios deve rivedere il contratto prima dell'avvio.

## Azioni
- Alex: bozza dei KPI da validare con Elena.
- Ufficio legale Helios: feedback sul contratto.` },
  { n: -2, title: 'Stato avanzamento Atlas', body: `## Partecipanti
Luca Ferri, Davide Russo, Alex

## Punti chiave
- Analisi magazzino al 40%.
- Steering committee giovedì: servono slide con avanzamento e rischi.
- Il piano di migrazione cloud è pronto per la revisione.

## Azioni
- Alex: preparare le slide per lo steering.
- Alex: rivedere il piano di migrazione di Davide.` },
  { n: -1, title: 'One-to-one con Paolo Marini (HR)', body: `## Punti chiave
- Due nuovi analisti entrano il mese prossimo.
- Budget formazione in approvazione.

## Azioni
- Alex: organizzare l'onboarding.
- Paolo: confermare il budget formazione.` },
];

function todos() {
  const g = (title) => ({ type: 'granola', title });
  const T = (o) => ({
    id: id(), title: '', detail: null, nextStep: null, project: null, people: [], due: null,
    priority: 'media', status: 'open', waitingOn: null, source: { type: 'manual' },
    createdAt: at(-5, 9), updatedAt: at(-1, 18), doneAt: null, ...o,
  });
  return [
    T({ title: 'Inviare la proposta economica a Nordwind Logistics', due: dd(0), priority: 'alta', project: 'Progetto Atlas',
      nextStep: 'Rivedere il capitolo costi con Luca', people: ['Luca Ferri', 'Marta Bianchi'],
      detail: 'Nordwind ha chiesto la proposta entro questa settimana. Includere le 8 settimane di analisi di magazzino.', source: g(MEETINGS[0].title) }),
    T({ title: 'Preparare le slide per lo steering committee di giovedì', due: dd(1), priority: 'alta', project: 'Progetto Atlas',
      nextStep: 'Raccogliere gli avanzamenti dai team', people: ['Luca Ferri', 'Davide Russo'], source: g(MEETINGS[3].title) }),
    T({ title: 'Rispondere a Sara sui margini del pricing', due: dd(-1), priority: 'alta', project: 'Aurora Retail',
      nextStep: 'Ascoltare il vocale e preparare 3 scenari di margine', people: ['Sara Conti'], source: { type: 'chat' } }),
    T({ title: 'Definire i KPI della dashboard per Helios Energy', due: dd(3), priority: 'media', project: 'Dashboard KPI',
      nextStep: 'Bozza di 5 KPI da validare con Elena', people: ['Elena Greco'], source: g(MEETINGS[2].title) }),
    T({ title: 'Rivedere il piano di migrazione cloud', due: dd(5), priority: 'media', project: 'Migrazione Cloud',
      nextStep: 'Leggere il documento di Davide e annotare i rischi', people: ['Davide Russo'], source: g(MEETINGS[3].title) }),
    T({ title: 'Organizzare l’onboarding dei due nuovi analisti', due: dd(7), priority: 'bassa', project: 'Onboarding Team',
      nextStep: 'Prenotare la sala e preparare gli accessi', source: g(MEETINGS[4].title) }),
    T({ title: 'Prenotare il treno per la trasferta a Milano', due: dd(10), priority: 'bassa', project: 'Personale' }),
    T({ title: 'Aggiornare il backlog del Progetto Atlas', due: dd(-6), priority: 'bassa', project: 'Progetto Atlas',
      nextStep: 'Chiudere le storie completate' }),
    T({ title: 'Ricevere i dati di vendita Q3 da Aurora Retail', status: 'waiting', waitingOn: 'Sara Conti', due: dd(2),
      project: 'Aurora Retail', source: g(MEETINGS[1].title) }),
    T({ title: 'Approvazione del budget formazione', status: 'waiting', waitingOn: 'Paolo Marini', due: dd(4),
      project: 'Onboarding Team', source: g(MEETINGS[4].title) }),
    T({ title: 'Feedback legale sul contratto Helios', status: 'waiting', waitingOn: 'Ufficio legale Helios', priority: 'alta',
      project: 'Dashboard KPI', source: g(MEETINGS[2].title) }),
    T({ title: 'Inviare il verbale del kickoff Atlas', status: 'done', doneAt: at(-1, 17), project: 'Progetto Atlas',
      source: g(MEETINGS[0].title) }),
    T({ title: 'Condividere il template di report settimanale', status: 'done', doneAt: at(-3, 11), project: 'Onboarding Team' }),
  ];
}

const CLUSTERS = ['Progetto Atlas', 'Aurora Retail', 'Dashboard KPI', 'Migrazione Cloud', 'Personale'];

const NOTES = [
  ['Progetto Atlas', -5, 'Rischi principali', '- Dati di magazzino incompleti per 2 depositi\n- Dipendenza dal fornitore WMS\n- Picco stagionale a dicembre'],
  ['Aurora Retail', -3, 'Idee pricing dinamico', 'Partire da 5 negozi pilota, misurare l’elasticità per categoria e poi estendere.'],
  ['Dashboard KPI', -2, 'Bozza KPI', '1. Consumo medio per cliente\n2. Tasso di letture mancanti\n3. Tempo di risoluzione ticket\n4. Margine per segmento\n5. Churn mensile'],
  ['Personale', -1, 'Libri da leggere', '- Thinking in Systems\n- The Pyramid Principle'],
];

function conversations() {
  const C = (o) => ({ id: 'c' + id(), pinned: false, cluster: null, vaultFile: null, suggestion: null, dismissed: false, ...o });
  return [
    C({ title: 'Prepara i punti per lo steering di giovedì', pinned: true, cluster: 'Progetto Atlas',
      createdAt: at(-1, 9, 30), updatedAt: at(-1, 9, 34), messages: [
        { role: 'user', text: 'Prepara i punti per lo steering di giovedì sul Progetto Atlas', ts: at(-1, 9, 30), files: [] },
        { role: 'assistant', model: 'sonnet', ts: at(-1, 9, 31), text: '**Steering Atlas · giovedì**\n\n- **Avanzamento:** analisi di magazzino al 40%, in linea con il piano.\n- **Rischi:** dati incompleti per 2 depositi, dipendenza dal fornitore WMS.\n- **Decisioni richieste:** priorità tra i depositi del nord e conferma del budget fase 2.\n- **Prossimi passi:** proposta economica a Nordwind entro oggi.' },
      ] }),
    C({ title: 'Riassumi il vocale di Sara sul pricing', cluster: 'Aurora Retail',
      createdAt: at(-1, 15), updatedAt: at(-1, 15, 3), messages: [
        { role: 'user', text: 'Riassumi il vocale di Sara sul pricing', ts: at(-1, 15), files: ['vocale-sara-pricing.ogg'] },
        { role: 'assistant', model: 'haiku', ts: at(-1, 15, 2), text: 'Sara chiede tre cose:\n\n1. Margine minimo garantito per le categorie fresche.\n2. Quante settimane servono per il pilota su 5 negozi.\n3. Se il modello funziona anche con le promozioni attive.\n\n_✅ 1 modifica/e applicata/e alla lista._' },
      ] }),
    C({ title: 'Come imposto la dashboard KPI per Helios?', suggestion: { cluster: 'Dashboard KPI', nuovo: false },
      createdAt: at(0, 9, 10), updatedAt: at(0, 9, 12), messages: [
        { role: 'user', text: 'Come imposto la dashboard KPI per Helios?', ts: at(0, 9, 10), files: [] },
        { role: 'assistant', model: 'sonnet', ts: at(0, 9, 11), text: 'Ti propongo questa struttura:\n\n- **In alto:** 5 KPI con trend sulle ultime 12 settimane.\n- **Al centro:** consumo per segmento di clientela.\n- **In basso:** ticket aperti e tempo di risoluzione.\n\nPrima di partire serve il feedback del legale sul contratto: è ancora tra le cose in attesa.' },
      ] }),
    C({ title: 'Idea per una cena veloce con 6 persone', dismissed: true,
      createdAt: at(-2, 19), updatedAt: at(-2, 19, 2), messages: [
        { role: 'user', text: 'Idea per una cena veloce con 6 persone', ts: at(-2, 19), files: [] },
        { role: 'assistant', model: 'haiku', ts: at(-2, 19, 1), text: 'Pasta al forno preparata in anticipo, insalata di stagione e un tiramisù: 40 minuti in tutto.' },
      ] }),
  ];
}

// Crea (o rigenera) i dati mock. Restituisce true se li ha rigenerati.
function ensureMockData(mcfg, { force = false } = {}) {
  const dir = mcfg.dataDir;
  if (path.basename(dir) !== 'data-mock') throw new Error('cartella mock inattesa: ' + dir); // protezione: mai toccare i dati veri
  const seedFile = path.join(dir, '.seed');
  let seed = null;
  try { seed = fs.readFileSync(seedFile, 'utf8').trim(); } catch {}
  if (!force && seed === dd(0)) return false;

  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });

  // note "Granola"
  for (const m of MEETINGS) {
    fs.writeFileSync(path.join(dir, 'notes', `${dd(m.n)} - ${m.title}.md`), `# ${m.title}\n${dd(m.n)}\n\n${m.body}\n`);
  }

  // vault con appunti per cluster
  for (const c of CLUSTERS) fs.mkdirSync(path.join(mcfg.vaultPath, mcfg.notesFolder, c), { recursive: true });
  for (const [c, n, title, body] of NOTES) {
    fs.writeFileSync(path.join(mcfg.vaultPath, mcfg.notesFolder, c, `${dd(n)} 1000 - ${title}.md`),
      `---\ntags: [appunto]\ncartella: "${c}"\ncreato: ${dd(n)} 10:00\nfonte: GengaNote\n---\n# ${title}\n\n${body}\n`);
  }

  // stato dei to-do
  const processedNotes = {};
  MEETINGS.forEach((m, i) => { processedNotes['mock-' + i] = at(m.n, 18); });
  const state = {
    todos: todos(), processedNotes,
    lastSync: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
    lastSyncResult: { notes: 1, added: 2, updated: 1 },
    folders: CLUSTERS, draft: { text: '', title: '', folder: null },
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));

  // chat di Ask Gengar
  const convs = conversations();
  fs.writeFileSync(path.join(dir, 'ask.json'), JSON.stringify({ activeId: convs[2].id, conversations: convs }));

  fs.writeFileSync(seedFile, dd(0));
  return true;
}

module.exports = { ensureMockData };
