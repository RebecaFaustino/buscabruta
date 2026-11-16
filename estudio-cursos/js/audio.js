// Análise de áudio: envelope (para forma de onda), detecção de silêncio e PCM 16 kHz para transcrição.
import { Input, ALL_FORMATS, BlobSource, AudioBufferSink } from '../vendor/mediabunny.min.mjs';

const ENV_RATE = 100; // pontos por segundo no envelope

// Último áudio decodificado (a análise e a transcrição usam o mesmo, sem decodificar duas vezes).
let lastPCM = { blob: null, pcm: null };

export async function decodePCM16k(blob, onProgress) {
  if (lastPCM.blob === blob && lastPCM.pcm) return lastPCM.pcm.slice();
  let pcm;
  try { pcm = await decodeStreaming(blob, onProgress); }
  catch (e) { console.warn('Leitura em partes indisponível, usando o método completo:', e?.message); pcm = await decodeWhole(blob); }
  lastPCM = { blob, pcm };
  return pcm.slice();
}

// Lê só a trilha de áudio, aos poucos (WebCodecs): não carrega o vídeo inteiro na memória.
async function decodeStreaming(blob, onProgress) {
  if (typeof AudioDecoder === 'undefined') throw new Error('sem WebCodecs');
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack();
  if (!track) throw new Error('sem trilha de áudio');
  if (!(await track.canDecode())) throw new Error('codec de áudio não suportado');
  const dur = await track.computeDuration();
  let out = new Float32Array(Math.ceil((dur + 2) * 16000));
  let n = 0, lastP = 0;
  for await (const { buffer, timestamp } of new AudioBufferSink(track).buffers()) {
    const sr = buffer.sampleRate, ch = buffer.numberOfChannels, len = buffer.length;
    const chans = Array.from({ length: ch }, (_, c) => buffer.getChannelData(c));
    const ratio = sr / 16000;
    const start = Math.max(0, Math.round(timestamp * 16000));
    const outLen = Math.floor(len / ratio);
    if (start + outLen > out.length) { const g = new Float32Array(Math.ceil((start + outLen) * 1.2)); g.set(out); out = g; }
    for (let i = 0; i < outLen; i++) {
      const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.min(len, Math.floor((i + 1) * ratio)));
      let s = 0;
      for (let c = 0; c < ch; c++) { const d = chans[c]; for (let j = a; j < b; j++) s += d[j]; }
      out[start + i] = s / ((b - a) * ch);
    }
    n = Math.max(n, start + outLen);
    if (onProgress && timestamp - lastP > 5) { lastP = timestamp; onProgress(Math.min(1, timestamp / dur)); }
  }
  input.dispose?.();
  if (!n) throw new Error('áudio vazio');
  return out.slice(0, n);
}

async function decodeWhole(blob) {
  const buf = await blob.arrayBuffer();
  const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 16000, 16000);
  const audio = await ctx.decodeAudioData(buf);
  // mixa para mono
  const n = audio.length;
  const out = new Float32Array(n);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const d = audio.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / audio.numberOfChannels;
  }
  return out; // 16 kHz mono
}

export function envelopeFrom(pcm, rate = 16000) {
  const step = Math.floor(rate / ENV_RATE);
  const len = Math.floor(pcm.length / step);
  const env = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let j = i * step, e = j + step; j < e; j++) s += pcm[j] * pcm[j];
    env[i] = Math.sqrt(s / step);
  }
  return env;
}

export async function analyze(blob) {
  const pcm = await decodePCM16k(blob);
  return { env: envelopeFrom(pcm), duration: pcm.length / 16000 };
}

// Retorna trechos com fala [{in,out}] a partir do envelope (cortes secos automáticos).
export function speechRanges(env, { silenceDb = -38, minSilence = 0.45, padding = 0.08, minSpeech = 0.25 } = {}) {
  const thr = Math.pow(10, silenceDb / 20);
  const ranges = [];
  let start = null, quiet = 0;
  const minQ = Math.round(minSilence * ENV_RATE);
  for (let i = 0; i < env.length; i++) {
    const loud = env[i] > thr;
    if (loud) {
      if (start === null) start = i;
      quiet = 0;
    } else if (start !== null) {
      quiet++;
      if (quiet >= minQ) { ranges.push([start, i - quiet + 1]); start = null; quiet = 0; }
    }
  }
  if (start !== null) ranges.push([start, env.length - quiet]);
  const dur = env.length / ENV_RATE;
  const out = [];
  for (const [a, b] of ranges) {
    let s = Math.max(0, a / ENV_RATE - padding), e = Math.min(dur, b / ENV_RATE + padding);
    if (e - s < minSpeech) continue;
    const last = out[out.length - 1];
    if (last && s <= last.out) last.out = e; else out.push({ in: s, out: e });
  }
  return out;
}

export function peakAt(env, t0, t1) {
  const a = Math.max(0, Math.floor(t0 * ENV_RATE)), b = Math.min(env.length, Math.ceil(t1 * ENV_RATE));
  let m = 0;
  for (let i = a; i < b; i++) if (env[i] > m) m = env[i];
  return m;
}
