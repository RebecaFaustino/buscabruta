// Efeitos sonoros sintetizados na hora (sem arquivos externos): suaves, no tom "consultório".
const cache = new WeakMap();

function make(ctx, dur, fn) {
  const sr = ctx.sampleRate, n = Math.floor(dur * sr);
  const b = ctx.createBuffer(1, n, sr), d = b.getChannelData(0);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  fn(d, sr, n, rnd);
  return b;
}

export const SFX = {
  whoosh: { name: 'Whoosh (destaque entrando)', build: (ctx) => make(ctx, 0.5, (d, sr, n, rnd) => {
    let lp = 0, bp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n, env = Math.sin(Math.PI * Math.min(1, t * 1.15)) ** 2;
      const k = 0.02 + 0.25 * t; // filtro que "abre" ao longo do som
      lp += k * (rnd() - lp); bp += 0.5 * (lp - bp);
      d[i] = (lp - bp) * env * 1.6;
    }
  }) },
  pop: { name: 'Pop (palavra-chave)', build: (ctx) => make(ctx, 0.16, (d, sr, n) => {
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr, f = 1100 - 2600 * t;
      ph += (2 * Math.PI * Math.max(200, f)) / sr;
      d[i] = Math.sin(ph) * Math.exp(-t * 32) * 0.55;
    }
  }) },
  sino: { name: 'Sino suave (abertura)', build: (ctx) => make(ctx, 1.6, (d, sr, n) => {
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      d[i] = (Math.sin(2 * Math.PI * 880 * t) * 0.5 + Math.sin(2 * Math.PI * 1320 * t) * 0.25 + Math.sin(2 * Math.PI * 2640 * t) * 0.08)
        * Math.exp(-t * 3.2) * Math.min(1, t * 200) * 0.45;
    }
  }) },
  tique: { name: 'Tique (nome na tela)', build: (ctx) => make(ctx, 0.08, (d, sr, n, rnd) => {
    for (let i = 0; i < n; i++) { const t = i / sr; d[i] = (Math.sin(2 * Math.PI * 2400 * t) * 0.6 + rnd() * 0.2) * Math.exp(-t * 70) * 0.5; }
  }) },
};

export function playSfx(ctx, out, name, vol = 0.5, when = 0) {
  if (!ctx || !SFX[name]) return;
  let m = cache.get(ctx);
  if (!m) cache.set(ctx, (m = {}));
  m[name] = m[name] || SFX[name].build(ctx);
  const src = ctx.createBufferSource();
  src.buffer = m[name];
  const g = ctx.createGain();
  g.gain.value = vol;
  src.connect(g).connect(out);
  src.start(ctx.currentTime + when);
}
