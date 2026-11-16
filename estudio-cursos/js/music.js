// Trilha sonora de fundo composta na hora (sem arquivos, sem direitos autorais): um trecho de 16 s que se repete
// sem emenda. Fica baixinha sob a voz, entra suave no começo e sai suave no fim.
export const TRACKS = {
  nenhuma: { name: 'Sem trilha' },
  calma: { name: 'Calma · piano e pad suave', bpm: 70, chords: [[48, 55, 64, 71], [45, 52, 60, 67], [41, 48, 57, 64], [43, 50, 59, 64]] },
  inspira: { name: 'Inspiradora · arpejo leve', bpm: 96, chords: [[48, 55, 60, 64], [43, 50, 55, 59], [45, 52, 57, 60], [41, 48, 53, 57]] },
  corporativa: { name: 'Corporativa · pulso moderno', bpm: 110, chords: [[45, 52, 57, 60], [41, 48, 53, 57], [48, 55, 60, 64], [43, 50, 55, 59]] },
};

const LOOP = 16; // segundos (4 acordes de 4 s)
const SR = 44100;
const cache = new Map();
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

export function buildMusic(kind) {
  const t = TRACKS[kind];
  if (!t?.chords || typeof OfflineAudioContext === 'undefined') return Promise.resolve(null);
  if (!cache.has(kind)) cache.set(kind, render(t).catch((e) => { cache.delete(kind); console.warn('trilha', e); return null; }));
  return cache.get(kind);
}

async function render(t) {
  // renderiza 20 s e dobra a cauda dos últimos 4 s no começo: o laço fica contínuo
  const ctx = new OfflineAudioContext(2, SR * (LOOP + 4), SR);
  const bus = ctx.createGain(); bus.gain.value = 0.6;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5200;
  bus.connect(lp).connect(ctx.destination);
  const beat = 60 / t.bpm;

  const pad = (notes, at, dur) => {
    for (const m of notes) for (const det of [-6, 6]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = hz(m); o.detune.value = det;
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900; f.Q.value = 0.3;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(0.018, at + 1.2);
      g.gain.setValueAtTime(0.018, at + dur - 0.2); g.gain.linearRampToValueAtTime(0, at + dur + 1.4);
      o.connect(f).connect(g).connect(bus); o.start(at); o.stop(at + dur + 1.5);
    }
  };
  const pluck = (m, at, vol = 0.09, decay = 1.6) => {
    for (const [type, mul, v] of [['triangle', 1, 1], ['sine', 2, 0.35]]) {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = hz(m) * mul;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(vol * v, at + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, at + decay);
      o.connect(g).connect(bus); o.start(at); o.stop(at + decay + 0.05);
    }
  };
  const kick = (at) => {
    const o = ctx.createOscillator(); o.frequency.setValueAtTime(120, at); o.frequency.exponentialRampToValueAtTime(42, at + 0.18);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.32, at); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
    o.connect(g).connect(ctx.destination); o.start(at); o.stop(at + 0.32);
  };
  const noise = ctx.createBuffer(1, SR * 0.05, SR);
  { const d = noise.getChannelData(0); let s = 3; for (let i = 0; i < d.length; i++) { s = (s * 16807) % 2147483647; d[i] = (s / 2147483647 * 2 - 1) * (1 - i / d.length); } }
  const hat = (at, v = 0.05) => {
    const n = ctx.createBufferSource(); n.buffer = noise;
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000;
    const g = ctx.createGain(); g.gain.value = v;
    n.connect(f).connect(g).connect(ctx.destination); n.start(at);
  };

  t.chords.forEach((ch, i) => {
    const at = i * 4;
    pad(ch, at, 4);
    pluck(ch[0] - 12, at, 0.07, 3.5); // baixo
    if (t === TRACKS.calma) {
      [0, 1.5, 2.5].forEach((o, j) => pluck(ch[(j + 1) % 4] + 12, at + o, 0.06, 2.4));
    } else {
      for (let k = 0; k * beat / 2 < 4 - 1e-6; k++) pluck(ch[[0, 2, 1, 3, 2, 1, 3, 2][k % 8]] + 12, at + k * beat / 2, t === TRACKS.inspira ? 0.055 : 0.045, 0.7);
    }
    if (t === TRACKS.corporativa) for (let k = 0; k * beat < 4 - 1e-6; k++) { kick(at + k * beat); hat(at + k * beat + beat / 2); }
  });

  const full = await ctx.startRendering();
  const out = new AudioBuffer({ numberOfChannels: 2, length: SR * LOOP, sampleRate: SR });
  for (let c = 0; c < 2; c++) {
    const src = full.getChannelData(c), dst = out.getChannelData(c);
    dst.set(src.subarray(0, SR * LOOP));
    const tail = src.subarray(SR * LOOP);
    for (let i = 0; i < tail.length; i++) dst[i] += tail[i];
  }
  // nivela as trilhas: mesma intensidade média (≈ −18 dBFS), sem estourar
  let sum = 0, peak = 0;
  for (let c = 0; c < 2; c++) for (const x of out.getChannelData(c)) { sum += x * x; peak = Math.max(peak, Math.abs(x)); }
  const rms = Math.sqrt(sum / (out.length * 2)) || 1;
  const k = Math.min(0.125 / rms, 0.98 / (peak || 1));
  for (let c = 0; c < 2; c++) { const d = out.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= k; }
  return out;
}

// Volume da trilha num instante (entra em 1,5 s e sai nos 2,5 s finais).
export function musicGain(T, total, vol) {
  const fadeIn = Math.min(1, T / 1.5), fadeOut = Math.min(1, Math.max(0, (total - T) / 2.5));
  return vol * fadeIn * fadeOut;
}

// Agenda a trilha num contexto de áudio (ao vivo ou na exportação) a partir do instante T da aula.
export function scheduleMusic(ctx, out, buffer, { T = 0, total, vol, when = ctx.currentTime }) {
  const src = ctx.createBufferSource();
  src.buffer = buffer; src.loop = true;
  const g = ctx.createGain();
  const pts = [T];
  for (const p of [1.5, total - 2.5, total]) if (p > T && p <= total) pts.push(p);
  pts.sort((a, b) => a - b);
  g.gain.setValueAtTime(musicGain(T, total, vol), when);
  for (const p of pts.slice(1)) g.gain.linearRampToValueAtTime(musicGain(p, total, vol), when + (p - T));
  src.connect(g).connect(out);
  src.start(when, T % buffer.duration);
  src.stop(when + Math.max(0, total - T));
  return { stop: () => { try { src.stop(); } catch {} src.disconnect(); g.disconnect(); } };
}
