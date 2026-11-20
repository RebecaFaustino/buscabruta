// Motion graphics no nível de After Effects, desenhado quadro a quadro (prévia e exportação 4K iguais):
// curvas de velocidade (Easy Ease, overshoot, elástico), transições entre takes, animações de entrada dos
// destaques e animações Lottie — o formato que o próprio After Effects exporta pelo plugin Bodymovin.

// ---------- Curvas de velocidade ----------
// Bézier cúbica como no editor de gráficos do After Effects (x1, y1, x2, y2).
function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t, sy = (t) => ((ay * t + by) * t + cy) * t;
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0; if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) { const d = dx(t); if (Math.abs(d) < 1e-6) break; t -= (sx(t) - x) / d; }
    return sy(Math.min(1, Math.max(0, t)));
  };
}
export const EASE = {
  easy: bezier(0.33, 0, 0.67, 1),          // Easy Ease (F9)
  out: bezier(0.16, 1, 0.3, 1),            // saída expo: entra rápido e assenta suave
  in: bezier(0.7, 0, 0.84, 0),
  back: bezier(0.34, 1.56, 0.64, 1),       // passa do ponto e volta (overshoot)
  elastic: (x) => (x <= 0 ? 0 : x >= 1 ? 1 : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
};
const clamp01 = (x) => Math.min(1, Math.max(0, x));

// ---------- Transições entre takes ----------
export const TRANSITIONS = {
  corte: 'Corte seco (padrão)',
  flash: 'Flash branco',
  zoom: 'Zoom punch (entra com impacto)',
  chicote: 'Chicote (whip pan)',
  desfoque: 'Desfoque suave',
  luz: 'Luz vazada (light leak)',
  glitch: 'Glitch digital',
};
// Estado da transição no instante T: quanto do efeito aplicar no vídeo e nas camadas por cima.
export function transitionAt(kind, T, starts, clips) {
  const fx = { scale: 1, dx: 0, blur: 0, flash: 0, leak: 0, glitch: 0 };
  if (!kind || kind === 'corte' || !clips?.length) return fx;
  let i = 0;
  while (i < clips.length - 1 && T >= starts[i + 1]) i++;
  const s = starts[i], e = s + (clips[i].out - clips[i].in);
  const tin = i > 0 ? T - s : Infinity, tout = i < clips.length - 1 ? e - T : Infinity;
  const D = 0.28;
  const pin = tin < D ? 1 - tin / D : 0, pout = tout < D ? 1 - tout / D : 0; // 1 = colado no corte
  const p = Math.max(pin, pout);
  if (!p) return fx;
  const eIn = EASE.out(pin), eOut = EASE.in(pout);
  switch (kind) {
    case 'flash': fx.flash = Math.max(pin > 0 ? Math.pow(pin, 1.6) : 0, pout > 0.55 ? Math.pow((pout - 0.55) / 0.45, 2) : 0) * 0.9; break;
    case 'zoom': fx.scale = 1 + 0.16 * Math.max(eIn * eIn, eOut * 0.6); fx.blur = 6 * Math.max(pin, pout * 0.6); break;
    case 'chicote': fx.dx = pout ? -eOut * 0.35 : eIn * 0.35; fx.blur = 14 * p; break;
    case 'desfoque': fx.blur = 18 * EASE.easy(p); fx.scale = 1 + 0.03 * p; break;
    case 'luz': fx.leak = Math.sin(Math.PI * Math.min(1, p)) * 0.85 + (p > 0.85 ? 0.15 : 0); break;
    case 'glitch': fx.glitch = p > 0.25 ? p : 0; fx.dx = p > 0.4 ? (((T * 997) % 1) - 0.5) * 0.04 * p : 0; break;
  }
  return fx;
}
// Camadas da transição desenhadas por cima do vídeo (antes de legendas e destaques).
export function drawTransitionOverlay(g, W, H, fx, T, accent) {
  if (fx.flash > 0.01) { g.save(); g.globalAlpha = fx.flash; g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, W, H); g.restore(); }
  if (fx.leak > 0.01) {
    g.save(); g.globalCompositeOperation = 'screen'; g.globalAlpha = fx.leak;
    const cx = W * (0.15 + 0.7 * ((T * 0.37) % 1)), gr = g.createRadialGradient(cx, H * 0.3, 0, cx, H * 0.3, W * 0.75);
    gr.addColorStop(0, 'rgba(255,200,120,0.95)'); gr.addColorStop(0.35, 'rgba(255,120,60,0.55)'); gr.addColorStop(1, 'rgba(255,60,40,0)');
    g.fillStyle = gr; g.fillRect(0, 0, W, H); g.restore();
  }
  if (fx.glitch > 0.01) {
    g.save();
    const n = 6, seed = Math.floor(T * 24);
    for (let k = 0; k < n; k++) {
      const r = Math.abs(Math.sin(seed * 12.9898 + k * 78.233)) % 1;
      const y = r * H, h = H * (0.02 + 0.05 * ((r * 7) % 1)), off = (((r * 13) % 1) - 0.5) * W * 0.08 * fx.glitch;
      try { g.drawImage(g.canvas, 0, y, W, h, off, y, W, h); } catch {}
    }
    g.globalCompositeOperation = 'screen'; g.globalAlpha = 0.25 * fx.glitch;
    g.fillStyle = accent || '#00E5FF'; g.fillRect(0, H * ((seed * 0.13) % 1), W, H * 0.015);
    g.restore();
  }
}

// ---------- Animação de entrada dos destaques ----------
export const CARD_ANIMS = {
  deslizar: 'Deslizar (padrão)',
  pop: 'Pop com elástico',
  mascara: 'Máscara (revela da lateral)',
  desfoque: 'Desfoque cinematográfico',
  digitar: 'Máquina de escrever',
  palavras: 'Palavra por palavra',
  circulo: 'Círculo desenhado à mão',
  queda: 'Queda 3D (gira e assenta)',
};
// Progresso de entrada (0→1) e saída (1→0) do destaque.
export function cardPhase(dt, dur) {
  return { pin: clamp01(dt / 0.55), pout: clamp01((dur - dt) / 0.35) };
}
export { clamp01 };

// ---------- Lottie (animações do After Effects) ----------
let lottieP = null;
export function loadLottieLib() {
  if (window.lottie) return Promise.resolve(window.lottie);
  if (!lottieP) lottieP = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = new URL('../vendor/lottie_canvas.min.js', import.meta.url).href;
    s.onload = () => (window.lottie ? res(window.lottie) : rej(new Error('Lottie não carregou')));
    s.onerror = () => { lottieP = null; rej(new Error('Não consegui carregar o motor de animações')); };
    document.head.appendChild(s);
  });
  return lottieP;
}

const anims = new Map(); // mediaId -> {anim, canvas, w, h, fr, frames} | Promise
// Prepara uma animação Lottie para desenhar quadro a quadro.
export async function ensureLottie(mediaId, getJSON) {
  if (anims.has(mediaId)) return anims.get(mediaId);
  const p = (async () => {
    const lottie = await loadLottieLib();
    const data = await getJSON(mediaId);
    const w = Math.max(16, Math.round(data.w || 512)), h = Math.max(16, Math.round(data.h || 512));
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const anim = lottie.loadAnimation({ renderer: 'canvas', loop: false, autoplay: false, animationData: data, rendererSettings: { context: canvas.getContext('2d'), clearCanvas: true, preserveAspectRatio: 'xMidYMid meet' } });
    await new Promise((r) => { if (anim.isLoaded) r(); else { anim.addEventListener('DOMLoaded', r); setTimeout(r, 3000); } });
    const v = { anim, canvas, w, h, fr: data.fr || 30, frames: Math.max(1, (data.op || 60) - (data.ip || 0)), ip: data.ip || 0 };
    anims.set(mediaId, v);
    return v;
  })().catch((e) => { anims.delete(mediaId); console.warn('Lottie', e); return null; });
  anims.set(mediaId, p);
  return p;
}
export const lottieReady = (id) => { const v = anims.get(id); return v && !(v instanceof Promise) ? v : null; };
export const lottieDuration = (data) => Math.max(0.2, ((data.op || 60) - (data.ip || 0)) / (data.fr || 30));

export const LOTTIE_POS = { tela: 'Tela cheia', centro: 'Centro', lado: 'Ao lado do expert', 'sup-dir': 'Canto superior direito', 'sup-esq': 'Canto superior esquerdo', 'inf-dir': 'Canto inferior direito', 'inf-esq': 'Canto inferior esquerdo' };

// Desenha uma animação Lottie no instante dt (segundos desde o início dela).
export function drawLottie(g, item, dt, W, H, sideRight) {
  const v = lottieReady(item.mediaId);
  if (!v) return;
  let f = dt * v.fr;
  f = item.loop ? f % v.frames : Math.min(v.frames - 0.01, f);
  try { v.anim.goToAndStop(v.ip + f, true); } catch { return; }
  const sc = item.scale ?? 1;
  let bw, bh;
  if (item.pos === 'tela') { const k = Math.max(W / v.w, H / v.h); bw = v.w * k; bh = v.h * k; }
  else { const k = Math.min((W * 0.32 * sc) / v.w, (H * 0.45 * sc) / v.h); bw = v.w * k; bh = v.h * k; }
  const m = W * 0.04;
  let x = (W - bw) / 2, y = (H - bh) / 2;
  switch (item.pos) {
    case 'sup-dir': x = W - bw - m; y = m; break;
    case 'sup-esq': x = m; y = m; break;
    case 'inf-dir': x = W - bw - m; y = H - bh - m * 2.2; break;
    case 'inf-esq': x = m; y = H - bh - m * 2.2; break;
    case 'lado': x = sideRight ? W - bw - m * 1.5 : m * 1.5; y = H * 0.36 - bh / 2; break;
  }
  const fade = Math.min(1, dt / 0.15, (item.dur - dt) / 0.2);
  g.save(); g.globalAlpha = Math.max(0, fade); g.drawImage(v.canvas, x, y, bw, bh); g.restore();
}

// Troca as cores de uma animação Lottie pelas cores da marca (mantém tons de cinza, branco e preto).
export function recolorLottie(data, palette) {
  const pal = (palette || []).map((h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255]).filter((c) => { const mx = Math.max(...c), mn = Math.min(...c); return mx - mn > 0.15; });
  if (!pal.length) return data;
  const map = new Map();
  const pick = (c) => {
    const key = c.slice(0, 3).map((x) => x.toFixed(3)).join(',');
    if (map.has(key)) return map.get(key);
    const nc = pal[map.size % pal.length];
    map.set(key, nc);
    return nc;
  };
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if ((o.ty === 'fl' || o.ty === 'st') && o.c && Array.isArray(o.c.k) && typeof o.c.k[0] === 'number') {
      const c = o.c.k, mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]);
      if (mx - mn > 0.15) { const nc = pick(c); o.c.k = [nc[0], nc[1], nc[2], c[3] ?? 1]; }
    }
    for (const k in o) walk(o[k]);
  };
  const copy = JSON.parse(JSON.stringify(data));
  walk(copy);
  return copy;
}
