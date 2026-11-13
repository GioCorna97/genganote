// Client minimale per la Granola public API (stessi endpoint del plugin Obsidian granola-sync).
const BASE = 'https://public-api.granola.ai/v1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(key, p) {
  for (let i = 0; ; i++) {
    const r = await fetch(BASE + p, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
    if ((r.status === 429 || r.status >= 500) && i < 3) { await sleep(1000 * 2 ** i); continue; }
    if (r.status === 401) throw new Error('Granola ha rifiutato la API key (401)');
    if (!r.ok) throw new Error(`Granola API ${r.status} su ${p}`);
    return r.json();
  }
}

async function listNotes(key, createdAfterISO) {
  const out = [];
  let cursor = null;
  do {
    const q = new URLSearchParams({ page_size: '30' });
    if (createdAfterISO) q.set('created_after', createdAfterISO);
    if (cursor) q.set('cursor', cursor);
    const j = await api(key, '/notes?' + q);
    out.push(...(j.notes || []));
    cursor = j.hasMore ? j.cursor : null;
  } while (cursor);
  return out;
}

async function listFolders(key) {
  const out = [];
  let cursor = null;
  do {
    const q = new URLSearchParams({ page_size: '30' });
    if (cursor) q.set('cursor', cursor);
    const j = await api(key, '/folders?' + q);
    out.push(...(j.folders || []));
    cursor = j.hasMore ? j.cursor : null;
  } while (cursor);
  return out;
}

const getNote = (key, id) => api(key, `/notes/${id}`);

module.exports = { listNotes, getNote, listFolders };
