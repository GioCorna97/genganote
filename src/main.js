// Processo principale Electron: bolla 🧠 sempre in primo piano + pannello to-do/chat.
const { app, BrowserWindow, ipcMain, screen, Menu, shell, globalShortcut, powerMonitor } = require('electron');
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const { Engine } = require('./engine');
const { AskGengar } = require('./ask');
const { ensureMockData } = require('./mock');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

app.setName('GengaNote');
// rendering software: evita che Gengar "sparisca" quando la GPU perde i livelli delle finestre trasparenti
app.disableHardwareAcceleration();
if (process.platform === 'win32') app.setAppUserModelId('local.genganote');

const cfg = loadConfig();
// Due ambienti: "official" (dati veri) e "mock" (dati sintetici in data-mock/, per screenshot e video).
// Tutte le pagine leggono dall'ambiente attivo; all'avvio si parte sempre da "official".
const mockCfg = {
  ...cfg, dataDir: path.join(cfg.root, 'data-mock'), vaultPath: path.join(cfg.root, 'data-mock', 'vault'),
  granolaApiKey: 'mock', userName: 'Alex', vaultTodoFile: 'To-Do Assistente.md', mock: true,
};
const envs = {};
let mode = 'official';
let bTimer = null;
function makeEnv(name, c) {
  const engine = new Engine(c);
  engine.on('change', () => { if (name === mode) { clearTimeout(bTimer); bTimer = setTimeout(broadcast, 50); } });
  envs[name] = { cfg: c, engine, ask: new AskGengar(c, engine) };
}
makeEnv('official', cfg);
const E = () => envs[mode].engine;      // motore dell'ambiente attivo
const A = () => envs[mode].ask;         // Ask Gengar dell'ambiente attivo
const engine = envs.official.engine;   // il sync in background riguarda sempre i dati veri

function setMode(m) {
  m = m === 'mock' ? 'mock' : 'official';
  if (m === 'mock' && (ensureMockData(mockCfg) || !envs.mock)) makeEnv('mock', mockCfg);
  mode = m;
  broadcast();
  return mode;
}
const uiFile = path.join(cfg.dataDir, 'ui.json');
const BUBBLE = 80; // finestra della bolla: il personaggio è ~64px, il resto è margine per le scintille
const PANEL = { w: 430, h: 660 };

let bubble = null, panel = null, syncTimer = null;
let panelOpen = false, closeTimer = null, activeHotkey = null, activeHideHotkey = null;
let hidden = false, modeTimer = null;
const PEEK = { w: 62, h: 60 }; // Gengar che sbircia dall'angolo, appoggiato sulla taskbar

function peekBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - PEEK.w, y: wa.y + wa.height - PEEK.h, width: PEEK.w, height: PEEK.h };
}
function floatBounds() {
  const saved = readUI().bubble;
  const p = validPos(saved) ? saved : defaultBubblePos();
  return { x: p.x, y: p.y, width: BUBBLE, height: BUBBLE };
}

// nasconde Gengar nell'angolo sopra la taskbar / lo fa tornare in giro
function setHidden(h) {
  if (h === hidden) return;
  hidden = h;
  writeUI({ hidden: h });
  clearTimeout(modeTimer);
  if (h) {
    if (panelOpen) togglePanel(false);
    bubble.webContents.send('mode', 'leaving');              // si tuffa via con uno sbuffo
    modeTimer = setTimeout(() => { bubble.setBounds(peekBounds()); bubble.webContents.send('mode', 'peek'); checkBubbleScale(); }, 420);
  } else {
    bubble.webContents.send('mode', 'unpeeking');             // sprofonda sotto la taskbar
    modeTimer = setTimeout(() => { bubble.setBounds(floatBounds()); bubble.webContents.send('mode', 'float'); checkBubbleScale(); }, 300);
  }
}

// Alt+G: apri/chiudi il pannello; se Gengar è nascosto, lo ritira fuori
function onMainHotkey() { if (hidden) setHidden(false); else togglePanel(); }

const readUI = () => { try { return JSON.parse(fs.readFileSync(uiFile, 'utf8')); } catch { return {}; } };
const writeUI = o => { try { fs.writeFileSync(uiFile, JSON.stringify({ ...readUI(), ...o })); } catch {} };

function webPrefs() {
  return { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true };
}

function defaultBubblePos() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - BUBBLE - 16, y: wa.y + wa.height - BUBBLE - 120 };
}

function validPos(p) {
  if (!p || typeof p.x !== 'number') return false;
  return screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return p.x >= a.x - 10 && p.y >= a.y - 10 && p.x + BUBBLE <= a.x + a.width + 10 && p.y + BUBBLE <= a.y + a.height + 10;
  });
}

function createBubble() {
  hidden = !!readUI().hidden;
  const pos = hidden ? peekBounds() : floatBounds();
  bubble = new BrowserWindow({
    x: pos.x, y: pos.y, width: pos.width, height: pos.height,
    frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false, focusable: false, show: false,
    webPreferences: webPrefs(),
  });
  bubble.setAlwaysOnTop(true, 'screen-saver');
  bubble.setVisibleOnAllWorkspaces(true);
  bubble.loadFile(path.join(__dirname, 'renderer', 'bubble.html'));
  bubble.once('ready-to-show', () => bubble.showInactive());
  bubble.webContents.on('render-process-gone', () => { if (!bubble.isDestroyed()) bubble.reload(); });
  bubble.on('unresponsive', () => { if (!bubble.isDestroyed()) bubble.reload(); });
  bubble.webContents.on('did-finish-load', () => { bubbleScale = bubbleDisplayScale(); broadcast(); });
}

// Se Gengar passa su un monitor con scala diversa (es. esterno 100% -> portatile 200%), il rendering
// software di Electron ridisegna il badge ma perde le immagini di Gengar. Ricaricare la bolla
// (file locale, istantaneo) lo ridisegna alla nuova scala.
let bubbleScale = null;
function bubbleDisplayScale() { return screen.getDisplayMatching(bubble.getBounds()).scaleFactor; }
function checkBubbleScale() {
  if (!bubble || bubble.isDestroyed()) return;
  const s = bubbleDisplayScale();
  if (bubbleScale !== null && s !== bubbleScale) {
    bubbleScale = s;
    const b = bubble.getBounds();
    if (!hidden) bubble.setBounds({ x: b.x, y: b.y, width: BUBBLE, height: BUBBLE }); // annulla l'eventuale "gonfiamento"
    bubble.webContents.reload();
  }
}

function createPanel() {
  panel = new BrowserWindow({
    width: PANEL.w, height: PANEL.h, frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, hasShadow: true,
    webPreferences: webPrefs(),
  });
  panel.setAlwaysOnTop(true, 'floating');
  panel.loadFile(path.join(__dirname, 'renderer', 'panel.html'));
  panel.on('close', e => { if (!app.isQuitting) { e.preventDefault(); panel.hide(); } });
}

function placePanel() {
  const b = bubble.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const gap = 8;
  let x = b.x + b.width / 2 > wa.x + wa.width / 2 ? b.x - PANEL.w - gap : b.x + b.width + gap;
  let y = b.y + b.height / 2 > wa.y + wa.height / 2 ? b.y + b.height - PANEL.h : b.y;
  x = Math.max(wa.x + gap, Math.min(x, wa.x + wa.width - PANEL.w - gap));
  y = Math.max(wa.y + gap, Math.min(y, wa.y + wa.height - PANEL.h - gap));
  panel.setBounds({ x: Math.round(x), y: Math.round(y), width: PANEL.w, height: PANEL.h });
}

// da dove "esce" il pannello: centro della bolla, in coordinate relative alla card del pannello (inset 6px)
function panelOrigin() {
  const b = bubble.getBounds(), p = panel.getBounds();
  return { ox: Math.round(b.x + b.width / 2 - p.x - 6), oy: Math.round(b.y + b.height / 2 - p.y - 6) };
}

function togglePanel(force) {
  const show = force !== undefined ? force : !panelOpen;
  if (show === panelOpen) { if (show) panel.focus(); return; }
  panelOpen = show;
  clearTimeout(closeTimer);
  bubble.webContents.send('panel-open', show); // la bolla cambia personaggio (sorridente <-> con la coperta)
  if (show) {
    placePanel();
    panel.show();
    panel.focus();
    panel.webContents.send('panel-shown', panelOrigin());
  } else {
    panel.webContents.send('panel-closing', panelOrigin());
    closeTimer = setTimeout(() => { if (!panelOpen) panel.hide(); }, 260); // lascia finire l'animazione di chiusura
  }
}

function broadcast() {
  const s = { ...E().snapshot(), mode };
  for (const w of [bubble, panel]) if (w && !w.isDestroyed()) w.webContents.send('state', s);
}

// Su Windows Electron scrive la voce "Run" senza virgolette: con spazi nel percorso
// (es. "OneDrive - Contoso") all'accesso il comando si spezza e l'app non parte. Le mettiamo noi.
const q = s => `"${s}"`;
const LOGIN = () => ({ path: q(process.execPath), args: [q(path.resolve(cfg.root))] });
function autoStartEnabled() {
  return app.getLoginItemSettings(LOGIN()).openAtLogin;
}
function setAutoStart(on) {
  app.setLoginItemSettings({ openAtLogin: on, ...LOGIN(), name: 'GengaNote' });
}

function bubbleMenu() {
  return Menu.buildFromTemplate([
    { label: 'Apri / chiudi pannello' + (activeHotkey ? '   (' + activeHotkey.replace('Control', 'Ctrl') + ')' : ''), click: () => togglePanel() },
    { label: E().syncing ? 'Sync in corso…' : 'Sincronizza Granola ora', enabled: !E().syncing, click: () => E().sync() },
    { label: (hidden ? 'Fai tornare Gengar' : "Nascondi Gengar nell'angolo") + (activeHideHotkey ? '   (' + activeHideHotkey.replace('Control', 'Ctrl') + ')' : ''), click: () => setHidden(!hidden) },
    { type: 'separator' },
    { label: 'Modalità Mock (dati finti per screenshot)', type: 'checkbox', checked: mode === 'mock', click: mi => setMode(mi.checked ? 'mock' : 'official') },
    { label: 'Apri cartella dati', click: () => shell.openPath(envs[mode].cfg.dataDir) },
    ...(envs[mode].cfg.vaultPath && envs[mode].cfg.vaultTodoFile ? [{ label: 'Apri To-Do nel vault', click: () => shell.openPath(path.join(envs[mode].cfg.vaultPath, envs[mode].cfg.vaultTodoFile)) }] : []),
    { label: 'Avvia con Windows', type: 'checkbox', checked: autoStartEnabled(), click: mi => setAutoStart(mi.checked) },
    { label: 'Riposiziona bolla', click: () => { const p = defaultBubblePos(); writeUI({ bubble: p }); if (hidden) setHidden(false); else { bubble.setBounds({ ...p, width: BUBBLE, height: BUBBLE }); checkBubbleScale(); } } },
    { type: 'separator' },
    { label: 'Esci', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
}

// ---------- IPC ----------
let drag = null;
ipcMain.handle('bubble:mode', () => (hidden ? 'peek' : 'float'));
ipcMain.on('bubble:drag-start', () => {
  if (hidden) return; const [x, y] = bubble.getPosition(); drag = { x, y }; });
// setBounds con dimensione fissa (non setPosition): tra monitor con scala diversa Electron
// altrimenti "gonfia" la finestra e il contenuto si rompe
ipcMain.on('bubble:drag-move', (_e, dx, dy) => { if (drag && !hidden) bubble.setBounds({ x: Math.round(drag.x + dx), y: Math.round(drag.y + dy), width: BUBBLE, height: BUBBLE }); });
ipcMain.on('bubble:drag-end', () => {
  if (!drag) return;
  drag = null;
  const [x, y] = bubble.getPosition();
  writeUI({ bubble: { x, y } });
  if (panelOpen) placePanel();
  checkBubbleScale();
});
ipcMain.handle('bubble:panel-open', () => panelOpen); // dopo un ricaricamento la bolla riprende lo stato senza animazione
ipcMain.on('bubble:click', () => { if (hidden) setHidden(false); else togglePanel(); });
ipcMain.on('bubble:menu', () => bubbleMenu().popup({ window: bubble }));
ipcMain.on('panel:hide', () => togglePanel(false));

ipcMain.handle('state:get', () => ({ ...E().snapshot(), mode }));
ipcMain.handle('mode:set', (_e, m) => setMode(m));
ipcMain.handle('todo:add', (_e, text) => E().addManual(text));
ipcMain.handle('todo:update', (_e, id, patch) => E().update(id, patch));
ipcMain.handle('todo:toggle', (_e, id) => E().toggle(id));
ipcMain.handle('todo:remove', (_e, id) => E().remove(id));
ipcMain.handle('todo:reorder', (_e, ids) => E().setRanks(ids));
ipcMain.handle('sync:now', () => E().sync());
ipcMain.handle('ask:get', () => A().snapshot());
ipcMain.handle('ask:send', (_e, text, model, files) => A().ask(text, model, files));
ipcMain.handle('ask:new', () => A().newChat());
ipcMain.handle('ask:open', (_e, id) => A().openChat(id));
ipcMain.handle('ask:pin', (_e, id, on) => A().setPinned(id, on));
ipcMain.handle('ask:cluster', (_e, id, cluster) => A().setCluster(id, cluster));
ipcMain.handle('ask:dismiss', (_e, id) => A().dismissSuggestion(id));
ipcMain.handle('notes:suggest', (_e, text) => E().suggestFolder(text).catch(() => null));
ipcMain.handle('notes:save', (_e, n) => { try { return { ok: true, path: E().saveNote(n) }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('notes:draft', (_e, d) => E().setDraft(d));
ipcMain.handle('open:url', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });

// ---------- avvio ----------
app.whenReady().then(() => {
  createBubble();
  createPanel();

  // v3: riscrive una volta la voce di avvio (virgolette + nuovo nome GengaNote, toglie la vecchia
  // "Brain To-Do"); dopo rispetta la scelta dal menu
  if (readUI().autoStartConfigured !== 3) {
    app.setLoginItemSettings({ openAtLogin: false, ...LOGIN(), name: 'Brain To-Do' });
    if (cfg.autoStart) setAutoStart(true);
    writeUI({ autoStartConfigured: 3 });
  }

  // scorciatoia globale apri/chiudi (fallback se già occupata da un'altra app)
  for (const k of [cfg.hotkey, 'Alt+G', 'Control+Alt+B']) {
    try { if (globalShortcut.register(k, onMainHotkey)) { activeHotkey = k; break; } } catch {}
  }
  for (const k of [cfg.hideHotkey, 'Control+Alt+G', 'Control+Alt+H']) {
    if (!k || k === activeHotkey) continue;
    try { if (globalShortcut.register(k, () => setHidden(!hidden))) { activeHideHotkey = k; break; } } catch {}
  }
  console.log('[hotkey] pannello:', activeHotkey || 'nessuna', '| nascondi:', activeHideHotkey || 'nessuna');

  setTimeout(() => engine.sync(), 5000);
  syncTimer = setInterval(() => engine.sync(), cfg.syncMinutes * 60 * 1000);
  setInterval(broadcast, 60 * 1000); // aggiorna "x min fa" e urgenze al cambio giorno
});

// dopo standby / sblocco / cambio monitor: rimetti la bolla in primo piano, al posto giusto, e ridisegnala
function healBubble() {
  if (!bubble || bubble.isDestroyed()) return;
  bubble.setAlwaysOnTop(true, 'screen-saver');
  bubble.setBounds(hidden ? peekBounds() : floatBounds());
  if (!bubble.isVisible()) bubble.showInactive();
  bubble.webContents.invalidate();
  bubble.webContents.send('heal');
  checkBubbleScale();
}
app.whenReady().then(() => {
  for (const ev of ['resume', 'unlock-screen']) powerMonitor.on(ev, () => setTimeout(healBubble, 1500));
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, () => setTimeout(healBubble, 500));
  setInterval(() => { if (bubble && !bubble.isDestroyed() && !bubble.isVisible()) healBubble(); }, 10000);
});

app.on('second-instance', () => { if (hidden) setHidden(false); togglePanel(true); });
app.on('before-quit', () => { app.isQuitting = true; });
app.on('will-quit', () => { globalShortcut.unregisterAll(); clearInterval(syncTimer); });
app.on('window-all-closed', e => e.preventDefault());
