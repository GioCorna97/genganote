// Configurazione: tutto auto-rilevato, sovrascrivibile da config.json nella root del progetto.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Trova il vault Obsidian aperto leggendo %APPDATA%\obsidian\obsidian.json
function detectVault() {
  const o = readJSON(path.join(process.env.APPDATA || '', 'obsidian', 'obsidian.json'));
  if (!o || !o.vaults) return null;
  const vaults = Object.values(o.vaults).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const v = vaults.find(x => x.open) || vaults[0];
  return v ? v.path : null;
}

function loadConfig() {
  const user = readJSON(path.join(ROOT, 'config.json')) || {};
  const vaultPath = user.vaultPath || detectVault();

  // API key Granola: config.json > env > riuso di quella del plugin Obsidian "granola-sync"
  let granolaApiKey = user.granolaApiKey || process.env.GRANOLA_API_KEY || null;
  if (!granolaApiKey && vaultPath) {
    const d = readJSON(path.join(vaultPath, '.obsidian', 'plugins', 'granola-sync', 'data.json'));
    granolaApiKey = d && d.apiKey ? d.apiKey : null;
  }

  return {
    root: ROOT,
    dataDir: path.join(ROOT, 'data'),
    vaultPath,
    granolaApiKey,
    userName: user.userName || 'User', // your name, used in the Claude prompts
    syncMinutes: user.syncMinutes ?? 15,
    firstSyncDaysBack: user.firstSyncDaysBack ?? 7,
    // Orchestratore + task difficili (chat, ragionamento sulle priorità)
    chatModel: user.chatModel || 'claude-opus-5-5',
    // Task veloci e semplici (estrazione azioni dalle call, arricchimento to-do, sottoagenti di ricerca)
    model: user.model || 'claude-haiku-5-5',
    subagentModel: user.subagentModel || 'haiku',
    claudeCmd: user.claudeCmd || 'claude',
    // file mirror dei to-do dentro il vault (null per disattivare)
    vaultTodoFile: user.vaultTodoFile === undefined ? 'To-Do Assistente.md' : user.vaultTodoFile,
    notesFolder: user.notesFolder || 'Appunti', // cartella del vault dove salvare gli appunti
    askFolder: user.askFolder || 'Ask Gengar',  // cartella del vault dove salvare lo storico di Ask Gengar
    autoStart: user.autoStart ?? true,
    hotkey: user.hotkey || 'Alt+G',                 // apri/chiudi pannello (G come Gengar)
    hideHotkey: user.hideHotkey || 'Control+Alt+G', // nascondi/mostra Gengar nell'angolo
  };
}

module.exports = { loadConfig, ROOT };
