// Wrapper minimale attorno a `claude -p` (Claude Code CLI, usa l'abbonamento: niente API key).
const { spawn, execFile } = require('child_process');

const quote = a => '"' + String(a).replace(/"/g, '\\"') + '"';

function cleanEnv() {
  const env = { ...process.env };
  // se lanciato da dentro una sessione Claude Code, evita che il figlio si comporti da "nested"
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_SSE_PORT;
  return env;
}

function killTree(child) {
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  else child.kill('SIGKILL');
}

/**
 * Esegue un prompt (passato via stdin) e restituisce { result, sessionId, cost }.
 * tools: [] = nessun tool; es. ['Read','Grep','Glob'] per la chat sul vault.
 */
function runClaude(prompt, {
  model = 'sonnet', tools = [], addDirs = [], resume = null, persist = false,
  cwd, timeoutMs = 240000, cmd = 'claude', agentsFile = null,
} = {}) {
  const args = ['-p', '--output-format', 'json', '--model', model,
    '--strict-mcp-config', '--setting-sources', '',
    '--tools', tools.join(',')];
  if (tools.length) args.push('--allowedTools', tools.join(','));
  for (const d of addDirs) args.push('--add-dir', d);
  if (agentsFile) args.push('--agents', agentsFile);
  if (resume) args.push('--resume', resume);
  if (!persist) args.push('--no-session-persistence');

  return new Promise((resolve, reject) => {
    const opts = { cwd, env: cleanEnv(), windowsHide: true };
    const child = process.platform === 'win32'
      ? spawn([cmd, ...args.map(quote)].join(' '), { ...opts, shell: true })
      : spawn(cmd, args, opts);

    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => { killTree(child); reject(new Error('Claude non ha risposto in tempo')); }, timeoutMs);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', () => {
      clearTimeout(timer);
      let j;
      try {
        const line = out.trim().split(/\r?\n/).filter(Boolean).pop();
        j = JSON.parse(line);
      } catch {
        return reject(new Error('Output di Claude non valido: ' + (err || out).slice(0, 300)));
      }
      if (j.is_error) return reject(new Error('Claude: ' + (j.result || j.subtype || 'errore')));
      resolve({ result: j.result || '', sessionId: j.session_id, cost: j.total_cost_usd });
    });
    child.stdin.end(prompt, 'utf8');
  });
}

// Estrae il primo oggetto JSON da una risposta testuale.
function extractJSON(text) {
  if (!text) return null;
  const tryParse = s => { try { return JSON.parse(s); } catch { return null; } };
  let j = tryParse(text.trim());
  if (j) return j;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && (j = tryParse(fence[1].trim()))) return j;
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) return tryParse(text.slice(a, b + 1));
  return null;
}

module.exports = { runClaude, extractJSON };
