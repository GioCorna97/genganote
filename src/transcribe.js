// Trascrizione locale con Whisper (gratuita, offline dopo il primo download del modello).
// Gira come processo separato con Node di sistema: `node src/transcribe.js <file audio> [lingua]`
// Stampa su stdout un JSON { text } ; il log va su stderr.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MODEL = 'Xenova/whisper-small';

// Converte qualsiasi audio (ogg, m4a, mp3, opus, ...) in WAV mono 16 kHz con ffmpeg.
function toWav16k(input, out) {
  const ffmpeg = require('ffmpeg-static');
  const r = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', input, '-ac', '1', '-ar', '16000', '-f', 'wav', out]);
  if (r.status !== 0) throw new Error('ffmpeg non è riuscito a leggere il file: ' + String(r.stderr || '').slice(0, 300));
}

// Legge un WAV PCM 16 bit mono a 16 kHz (quello prodotto sopra) e restituisce Float32Array.
function readWavFloat32(file) {
  const buf = fs.readFileSync(file);
  let off = 12;
  while (off < buf.length - 8) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      const n = Math.floor(size / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(off + 8 + i * 2) / 32768;
      return out;
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('WAV senza chunk data');
}

async function transcribe(input, language = 'italian') {
  if (!fs.existsSync(input)) throw new Error('File non trovato: ' + input);
  const tmp = path.join(os.tmpdir(), `gengar-${process.pid}-${Date.now()}.wav`);
  try {
    toWav16k(input, tmp);
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = path.join(ROOT, 'data', 'models'); // modello scaricato una sola volta
    const asr = await pipeline('automatic-speech-recognition', MODEL);
    const audio = readWavFloat32(tmp);
    const out = await asr(audio, { language, task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
    return (out.text || '').trim();
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

module.exports = { transcribe };

if (require.main === module) {
  const [, , file, lang] = process.argv;
  transcribe(file, lang || 'italian')
    .then(text => process.stdout.write(JSON.stringify({ text })))
    .catch(e => { console.error('[transcribe]', e.message); process.stdout.write(JSON.stringify({ error: e.message })); process.exitCode = 1; });
}
