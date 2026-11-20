// Tratamento de voz profissional (no estilo das ferramentas da Adobe — Podcast Enhance / Audition):
// redução de ruído espectral (mede o ruído de fundo do próprio trecho), de-esser espectral (suaviza os "s"
// chiados), e presets de cadeia de voz. Roda na exportação, em blocos, sem pesar a prévia.

// FFT radix-2 in-place (re, im)
function fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inv ? 2 : -2) * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

// Limpa a voz (mono). strength 0–1: quanto de ruído tirar. deess 0–1: quanto suavizar os sibilantes.
export function cleanVoice(x, sr, { strength = 0.7, deess = 0.5 } = {}) {
  const N = 2048, H = 512, bins = N / 2 + 1;
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const frames = Math.max(1, Math.ceil((x.length - N) / H) + 1);
  if (x.length < N * 2) return x;
  // 1ª passada: espectro de cada quadro (magnitude) para estimar o ruído (10º percentil por faixa)
  const mags = new Float32Array(frames * bins);
  const re = new Float32Array(N), im = new Float32Array(N);
  for (let f = 0; f < frames; f++) {
    const o = f * H;
    for (let i = 0; i < N; i++) { re[i] = (x[o + i] || 0) * win[i]; im[i] = 0; }
    fft(re, im, false);
    for (let k = 0; k < bins; k++) mags[f * bins + k] = Math.hypot(re[k], im[k]);
  }
  const noise = new Float32Array(bins);
  const col = new Float32Array(frames);
  for (let k = 0; k < bins; k++) {
    for (let f = 0; f < frames; f++) col[f] = mags[f * bins + k];
    const sorted = col.slice().sort();
    noise[k] = sorted[Math.floor(frames * 0.1)] * 1.3;
  }
  const sib0 = Math.floor((5200 / sr) * N), sib1 = Math.min(bins - 1, Math.floor((9500 / sr) * N));
  // 2ª passada: ganho por faixa (Wiener suavizado no tempo) + de-esser, e soma com sobreposição
  const out = new Float32Array(x.length), norm = new Float32Array(x.length);
  const gPrev = new Float32Array(bins).fill(1);
  const gMin = 1 - 0.9 * strength; // até −20 dB de redução
  const alpha = 1.2 + 2.4 * strength;
  for (let f = 0; f < frames; f++) {
    const o = f * H;
    for (let i = 0; i < N; i++) { re[i] = (x[o + i] || 0) * win[i]; im[i] = 0; }
    fft(re, im, false);
    let eAll = 0, eSib = 0;
    for (let k = 1; k < bins; k++) { const m = mags[f * bins + k]; const e = m * m; eAll += e; if (k >= sib0 && k <= sib1) eSib += e; }
    const sibRatio = eAll > 0 ? eSib / eAll : 0;
    const deGain = deess > 0 && sibRatio > 0.28 ? Math.max(0.35, 1 - deess * (sibRatio - 0.28) * 2.2) : 1;
    for (let k = 0; k < bins; k++) {
      const m = mags[f * bins + k] + 1e-9;
      let g = 1 - (alpha * noise[k] * noise[k]) / (m * m);
      g = Math.max(gMin, Math.min(1, g));
      // suaviza no tempo: cai devagar e sobe rápido (evita o "ruído musical")
      g = g < gPrev[k] ? 0.55 * gPrev[k] + 0.45 * g : g;
      gPrev[k] = g;
      if (k >= sib0 && k <= sib1) g *= deGain;
      re[k] *= g; im[k] *= g;
      if (k > 0 && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; }
    }
    fft(re, im, true);
    for (let i = 0; i < N; i++) { const j = o + i; if (j >= out.length) break; out[j] += re[i] * win[i]; norm[j] += win[i] * win[i]; }
  }
  for (let i = 0; i < out.length; i++) out[i] = norm[i] > 1e-6 ? out[i] / norm[i] : x[i];
  return out;
}

// Presets de voz (escolha com um clique no painel de Estilo → Áudio).
export const VOICE_PRESETS = {
  estudio: { name: 'Estúdio (padrão Adobe Podcast)', clean: true, denoise: 0.75, deess: 0.55, hp: 85, mud: -3, pres: 3, air: 2.5, thr: -24, ratio: 3.5, makeup: 1.7 },
  natural: { name: 'Natural (tratamento leve)', clean: true, denoise: 0.4, deess: 0.3, hp: 75, mud: -1.5, pres: 1.5, air: 1, thr: -22, ratio: 2.5, makeup: 1.35 },
  locucao: { name: 'Locução / rádio (voz encorpada)', clean: true, denoise: 0.6, deess: 0.6, hp: 70, mud: -2, pres: 3.5, air: 2, thr: -28, ratio: 4.5, makeup: 2.0, body: 2.5 },
  ambiente: { name: 'Sala com eco / ruído forte', clean: true, denoise: 0.95, deess: 0.5, hp: 110, mud: -4, pres: 3, air: 1, thr: -24, ratio: 3.5, makeup: 1.7 },
  nenhum: { name: 'Sem tratamento (áudio original)', clean: false, denoise: 0, deess: 0 },
};
export const voicePreset = (cl) => VOICE_PRESETS[cl?.voicePreset] || (cl?.cleanVoice === false ? VOICE_PRESETS.nenhum : VOICE_PRESETS.estudio);

// Cadeia de voz (EQ, compressor, ganho) do preset — usada na prévia e na exportação.
export function presetChain(ctx, out, p) {
  if (!p.clean) return out;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = p.hp; hp.Q.value = 0.7;
  const body = ctx.createBiquadFilter(); body.type = 'lowshelf'; body.frequency.value = 160; body.gain.value = p.body || 0;
  const mud = ctx.createBiquadFilter(); mud.type = 'peaking'; mud.frequency.value = 280; mud.gain.value = p.mud; mud.Q.value = 1.1;
  const pres = ctx.createBiquadFilter(); pres.type = 'peaking'; pres.frequency.value = 3200; pres.gain.value = p.pres; pres.Q.value = 1.0;
  const air = ctx.createBiquadFilter(); air.type = 'highshelf'; air.frequency.value = 9000; air.gain.value = p.air;
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = p.thr; comp.ratio.value = p.ratio; comp.attack.value = 0.008; comp.release.value = 0.2; comp.knee.value = 6;
  const makeup = ctx.createGain(); makeup.gain.value = p.makeup;
  hp.connect(body).connect(mud).connect(pres).connect(air).connect(comp).connect(makeup).connect(out);
  return hp;
}
