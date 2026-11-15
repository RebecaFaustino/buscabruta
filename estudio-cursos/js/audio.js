// Análise de áudio: envelope (para forma de onda), detecção de silêncio e PCM 16 kHz para transcrição.
const ENV_RATE = 100; // pontos por segundo no envelope

export async function decodePCM16k(blob) {
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
