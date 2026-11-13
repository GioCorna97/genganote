// Esegue un sync da terminale (utile per debug): npm run sync
const { loadConfig } = require('./config');
const { Engine } = require('./engine');

(async () => {
  const cfg = loadConfig();
  console.log('Vault:', cfg.vaultPath, '| Granola key:', cfg.granolaApiKey ? 'ok' : 'MANCANTE');
  const e = new Engine(cfg);
  let last = '';
  e.on('change', () => { if (e.syncProgress && e.syncProgress !== last) console.log('…', (last = e.syncProgress)); });
  const t0 = Date.now();
  const r = await e.sync();
  console.log('Risultato:', r, '| errore:', e.lastError, '|', Math.round((Date.now() - t0) / 1000) + 's');
  console.log('Stats:', e.stats());
  await new Promise(res => setTimeout(res, 2500)); // lascia scrivere il mirror nel vault
})();
