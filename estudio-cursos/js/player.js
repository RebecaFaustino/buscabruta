// Motor de reprodução da linha do tempo editada + composição (zoom, look, legendas, palavras-chave).
import { fontStack, ensureFont } from './fonts.js';
import { presetChain, voicePreset } from './audiopro.js';
import { gradeParams, gradeImage, ensureLut } from './grade.js';
import { db } from './db.js';
import { LOOKS } from './presets.js';
import { timelineCaptions, srcToTimeline, isKeyword } from './captions.js';
import { resolveStyle, FONTS } from './styles.js';
import { playSfx } from './sfx.js';
import { buildMusic, scheduleMusic } from './music.js';

const urlCache = new Map(); // mediaId -> objectURL
export async function mediaURL(mediaId) {
  if (!urlCache.has(mediaId)) {
    const b = await db.getBlob(mediaId);
    if (!b) return null;
    urlCache.set(mediaId, URL.createObjectURL(b));
  }
  return urlCache.get(mediaId);
}

// Safari/iOS só decodifica quadros de vídeos presentes no documento: mantemos um contêiner invisível.
let shelf;
function videoShelf() {
  if (!shelf) {
    shelf = document.createElement('div');
    shelf.setAttribute('aria-hidden', 'true');
    shelf.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:-1';
    document.body.appendChild(shelf);
  }
  return shelf;
}

// Tratamento de voz (passa-alta, menos "embolado", mais presença, compressor). Usado ao vivo e na exportação.
export function voiceChain(ctx, out) {
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 85;
  const mud = ctx.createBiquadFilter(); mud.type = 'peaking'; mud.frequency.value = 300; mud.gain.value = -2.5; mud.Q.value = 1;
  const pres = ctx.createBiquadFilter(); pres.type = 'peaking'; pres.frequency.value = 3200; pres.gain.value = 3; pres.Q.value = 0.9;
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -26; comp.ratio.value = 3.5; comp.attack.value = 0.005; comp.release.value = 0.2; comp.knee.value = 8;
  const makeup = ctx.createGain(); makeup.gain.value = 1.6;
  hp.connect(mud).connect(pres).connect(comp).connect(makeup).connect(out);
  return hp;
}

const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
const seeked = (v) => new Promise((r) => { const f = () => { v.removeEventListener('seeked', f); r(); }; v.addEventListener('seeked', f); });

export class Player {
  constructor(canvas) {
    this.canvas = canvas;
    // Na tela, o canvas fica dentro de uma "moldura" com o <video> real por baixo (prévia confiável no iPhone).
    if (canvas.isConnected) {
      const host = document.createElement('div');
      host.className = 'screen';
      canvas.replaceWith(host);
      host.appendChild(canvas);
      this.host = host;
    }
    this.videos = new Map(); // srcId -> video
    this.T = 0;
    this.playing = false;
    this.onTime = () => {};
    this.onGap = () => {};
    this.logo = null;
  }

  async setLesson(lesson, client) {
    this.stop();
    this.lesson = lesson;
    this.client = client;
    if (this.host && lesson.sources.some((s) => !this.videos.has(s.id))) this.host.classList.add('loading');
    try { await this.loadSources(lesson); } finally { this.host?.classList.remove('loading'); }
    await Promise.all([ensureFont(client.fontTitle), ensureFont(client.fontBody)]).catch(() => {});
    if (client.grade?.lutId) await ensureLut(client.grade.lutId, loadLutText);
    this.logo = null;
    if (client.logoMediaId) {
      const img = new Image();
      const u = await mediaURL(client.logoMediaId).catch(() => null);
      if (u) { img.src = u; await img.decode().catch(() => {}); this.logo = img; }
    }
    this.invalidate();
    this.T = Math.min(this.T, this.duration);
    await this.seek(this.T);
  }

  async loadSources(lesson) {
    for (const s of lesson.sources) {
      if (this.videos.has(s.id)) continue;
      const v = document.createElement('video');
      v.preload = 'auto';
      v.playsInline = true;
      v.crossOrigin = 'anonymous';
      v.setAttribute('playsinline', '');
      const url = await mediaURL(s.mediaId).catch((e) => { console.warn(e); return null; });
      if (!url) continue; // vídeo não está neste aparelho nem na nuvem: a tela mostra o aviso
      v.src = url;
      if (this.host) { v.className = 'live'; v.style.visibility = 'hidden'; this.host.insertBefore(v, this.canvas); }
      else { v.style.cssText = 'width:2px;height:2px'; videoShelf().appendChild(v); }
      this.videos.set(s.id, v);
      if (this.ctx) this.wireAudio(v);
      // no iPhone o vídeo só carrega depois de um toque: não espera mais que 2,5 s
      await new Promise((r) => { if (v.readyState >= 2) r(); else { v.addEventListener('loadeddata', r, { once: true }); v.addEventListener('error', r, { once: true }); setTimeout(r, 2500); } });
    }
  }

  invalidate() {
    if (!this.lesson) return;
    this.caps = timelineCaptions(this.lesson);
    const starts = [];
    let acc = 0;
    for (const c of this.lesson.clips) { starts.push(acc); acc += c.out - c.in; }
    this.starts = starts;
    this.total = acc;
    this.cardsT = this.lesson.cards.map((k) => ({ ...k, T: srcToTimeline(this.lesson.clips, k.srcId, k.t) })).filter((k) => k.T !== null);
  }

  get duration() { return this.total || 0; }

  clipAt(T) {
    const clips = this.lesson.clips;
    for (let i = 0; i < clips.length; i++) if (T < this.starts[i] + clips[i].out - clips[i].in) return i;
    return clips.length - 1;
  }

  // ---------- Áudio (voz limpa: passa-alta, presença e compressor) ----------
  // Chamado de forma síncrona no toque do usuário: libera a reprodução com som no iOS.
  unlock() {
    for (const v of this.videos.values()) {
      if (v._unlocked) continue;
      v._unlocked = true;
      const p = v.play();
      p?.then(() => { if (v !== this.active) v.pause(); }).catch(() => {});
    }
  }

  ensureAudio() {
    this.unlock();
    if (this.ctx) { this.ctx.resume(); return; }
    const ctx = this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = ctx.createGain();
    this.speaker = ctx.createGain();
    this.dest = ctx.createMediaStreamDestination();
    this.master.connect(this.speaker).connect(ctx.destination);
    this.master.connect(this.dest);
    // efeitos sonoros: entram no que você ouve e no vídeo exportado, sem passar pelo tratamento de voz
    this.sfxBus = ctx.createGain();
    this.sfxBus.connect(this.speaker);
    this.sfxBus.connect(this.dest);
    this.musicBus = ctx.createGain();
    this.musicBus.connect(this.speaker);
    this.musicBus.connect(this.dest);
    this.buildChain();
    for (const v of this.videos.values()) this.wireAudio(v);
  }

  wireAudio(v) {
    if (v._src) return;
    v._src = this.ctx.createMediaElementSource(v);
    this.applyClean(v);
  }

  applyClean(v) {
    v._src.disconnect();
    v._src.connect(voicePreset(this.client).clean ? this.chainIn : this.master);
  }

  buildChain() {
    try { this.chainIn?.disconnect(); } catch {}
    this._preset = voicePreset(this.client);
    this.chainIn = presetChain(this.ctx, this.master, this._preset);
  }
  refreshAudio() { if (!this.ctx) return; this.buildChain(); for (const v of this.videos.values()) if (v._src) this.applyClean(v); }

  fade(to, t = 0.012) { if (this.master) this.master.gain.setTargetAtTime(to, this.ctx.currentTime, t); }

  // ---------- Transporte ----------
  async seek(T) {
    if (!this.lesson || !this.lesson.clips.length) { this.T = 0; this.draw(); return; }
    this.T = Math.max(0, Math.min(T, this.duration - 0.001));
    const i = this.clipAt(this.T), c = this.lesson.clips[i];
    const v = this.videos.get(c.srcId);
    const target = c.in + (this.T - this.starts[i]);
    if (v && Math.abs(v.currentTime - target) > 0.01) { v.currentTime = target; await seeked(v); }
    this.draw();
    this.onTime(this.T);
  }

  stop() {
    this.playing = false;
    this.music?.stop(); this.music = null;
    for (const v of this.videos.values()) v.pause();
  }

  async play() {
    if (!this.lesson?.clips.length || this.playing) return;
    this.ensureAudio();
    if (this.T >= this.duration - 0.05) this.T = 0;
    this.playing = true;
    this.startMusic();
    const clips = this.lesson.clips;
    let i = this.clipAt(this.T);
    let prevV = null;
    while (this.playing && i < clips.length) {
      const c = clips[i], v = this.videos.get(c.srcId);
      this.active = v;
      const target = c.in + (this.T - this.starts[i]);
      const contiguous = prevV === v && !v.paused && Math.abs(v.currentTime - target) < 0.06;
      if (!contiguous) {
        if (prevV && prevV !== v) prevV.pause();
        this.fade(0);
        this.onGap(true);
        if (!v.paused) v.pause();
        if (Math.abs(v.currentTime - target) > 0.01) { v.currentTime = target; await seeked(v); }
        this.draw();
        await v.play().catch(() => {});
        this.onGap(false);
        this.fade(1);
      }
      await new Promise((res) => {
        const tick = () => {
          if (!this.playing) return res();
          const prevT = this.T;
          this.T = this.starts[i] + Math.max(0, v.currentTime - c.in);
          this.cueSfx(prevT, this.T);
          this.draw();
          this.onTime(this.T);
          if (v.currentTime >= c.out - 0.015 || v.ended) return res();
          requestAnimationFrame(tick);
        };
        tick();
      });
      prevV = v;
      i++;
      if (i < clips.length) this.T = this.starts[i];
    }
    if (prevV) prevV.pause();
    this.music?.stop(); this.music = null;
    if (this.playing) { this.T = this.duration; this.playing = false; }
    this.onTime(this.T);
  }

  async startMusic() {
    const cl = this.client;
    if (!cl?.music || cl.music === 'nenhuma' || !this.ctx) return;
    const buf = await buildMusic(cl.music);
    if (!buf || !this.playing) return;
    this.music?.stop();
    this.music = scheduleMusic(this.ctx, this.musicBus, buf, { T: this.T, total: this.duration, vol: cl.musicVol ?? 0.35 });
  }

  // Toca os efeitos cujo momento foi cruzado entre dois quadros.
  cueSfx(a, b) {
    const cl = this.client;
    if (!cl?.sfx || !this.ctx || b <= a || b - a > 0.5) return;
    const vol = cl.sfxVol ?? 0.5;
    const hit = (t) => t > a && t <= b;
    if (cl.openingTitle && hit(0.05)) playSfx(this.ctx, this.sfxBus, 'sino', vol * 0.8);
    if (cl.lowerThird && hit(3.4)) playSfx(this.ctx, this.sfxBus, 'tique', vol * 0.7);
    for (const k of this.cardsT || []) if (hit(k.T)) { playSfx(this.ctx, this.sfxBus, 'whoosh', vol); playSfx(this.ctx, this.sfxBus, 'pop', vol * 0.6, 0.18); }
  }

  // ---------- Composição ----------
  // Prévia ao vivo: o próprio <video> fica na tela (funciona no iPhone) e o canvas transparente desenha os grafismos por cima.
  liveVideo(c, local, st, graded) {
    const cl = this.client || {};
    for (const [id, v] of this.videos) {
      const on = id === c.srcId;
      if (v._on !== on) { v.style.visibility = on ? 'visible' : 'hidden'; v._on = on; }
    }
    const v = this.videos.get(c.srcId);
    if (!v) return;
    let zoom = c.zoom || 1;
    if (cl.smoothZoom) zoom *= 1 + 0.035 * local;
    const fx = cl.focusX ?? 0.5;
    const tf = `scale(${zoom.toFixed(4)})`, org = `${(fx * 100).toFixed(1)}% 38%`;
    if (v._tf !== tf) { v.style.transform = tf; v._tf = tf; }
    if (v._org !== org) { v.style.transformOrigin = org; v._org = org; }
    const flt = graded ? 'none' : lookFilter(cl, st);
    if (v._flt !== flt) { v.style.filter = flt; v._flt = flt; }
    // com color grading, o vídeo fica invisível e o quadro colorido é desenhado no canvas por cima
    const op = graded ? '0' : '1';
    if (v._op !== op) { v.style.opacity = op; v._op = op; }
    const pos = `${(fx * 100).toFixed(1)}% 38%`; // na prévia vertical, enquadra o rosto do expert
    if (v._pos !== pos) { v.style.objectPosition = pos; v._pos = pos; }
  }

  // Miniatura de um modelo: quadro atual + legenda e destaque de exemplo.
  drawSample(canvas, override) {
    const keep = { caps: this.caps, cardsT: this.cardsT };
    const T = this.T;
    const word = (this.client?.keywords || [])[0] || 'destaque';
    const words = ['Exemplo', 'de', 'legenda', 'com', word].map((w, i) => ({ w, s: T - 0.4 + i * 0.25, e: T - 0.15 + i * 0.25 }));
    this.caps = [{ s: T - 0.5, e: T + 2, text: '', words }];
    this.cardsT = [{ T: T - 1, dur: 4, text: word, sub: '' }];
    try { this.draw(canvas, override); } finally { Object.assign(this, keep); }
  }

  draw(canvas = this.canvas, styleOverride) {
    const g = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const cl = styleOverride ? { ...this.client, ...styleOverride } : (this.client || {});
    const st = resolveStyle(cl);
    const live = canvas === this.canvas && this.host && !this.frame && !styleOverride;
    g.save();
    if (live) g.clearRect(0, 0, W, H);
    else { g.fillStyle = '#0d1414'; g.fillRect(0, 0, W, H); }
    if (!this.lesson?.clips.length) {
      if (live) { g.fillStyle = '#0d1414'; g.fillRect(0, 0, W, H); }
      g.fillStyle = '#7d8b8b'; g.font = `500 ${H * 0.035}px ${FONTS.inter}`; g.textAlign = 'center';
      g.fillText('Importe um vídeo para começar', W / 2, H / 2);
      g.restore();
      return;
    }
    const T = this.T;
    const i = this.clipAt(T), c = this.lesson.clips[i];
    const local = (T - this.starts[i]) / Math.max(0.001, c.out - c.in);
    const gp = gradeParams(cl);
    if (live) this.liveVideo(c, local, st, !!gp);
    if (!live || gp) {
      // na exportação quadro a quadro, o quadro vem decodificado (this.frame) em vez do <video>
      const fr = this.frame;
      const v = fr ? null : this.videos.get(c.srcId);
      const img = fr ? fr.img : v;
      const vw = fr ? fr.w : v?.videoWidth, vh = fr ? fr.h : v?.videoHeight;
      if (img && vw) {
        let zoom = c.zoom || 1;
        if (cl.smoothZoom) zoom *= 1 + 0.035 * local;
        const sc = Math.max(W / vw, H / vh) * zoom;
        const dw = vw * sc, dh = vh * sc;
        const fx = cl.focusX ?? 0.5, fy = 0.38;
        const vertical = W / H < 0.8 && vw / vh > 1;
        const tx = vertical ? 0.5 : fx;
        let dx = W * tx - fx * dw, dy = H * fy - fy * dh;
        dx = Math.min(0, Math.max(W - dw, dx)); dy = Math.min(0, Math.max(H - dh, dy));
        try {
          const ok = live ? (img.readyState >= 2) : true;
          const gw = Math.min(vw, Math.ceil(dw)), gh = Math.round((gw * vh) / vw);
          const graded = gp && ok ? gradeImage(img, gw, gh, gp) : null;
          if (graded) g.drawImage(graded, dx, dy, dw, dh);
          else if (!live) { g.filter = lookFilter(cl, st); g.drawImage(img, dx, dy, dw, dh); }
          else if (gp && !ok) { /* aguardando o quadro */ }
        } catch (e) { /* quadro indisponível neste instante */ }
        g.filter = 'none';
      }
    }
    const u = H / 1080;
    const side = cl.expertSide === 'right' ? 'left' : 'right'; // lado dos destaques
    drawFrameFx(g, W, H, u, st, T);

    // Nome + CRM do lado do expert
    if (cl.lowerThird && T > 3.4 && T < 9) {
      const a = Math.min(ease((T - 3.4) / 0.5), 1 - ease((T - 8.4) / 0.6));
      drawLower(g, a, cl, st, W, H, u);
    }
    for (const k of this.cardsT || []) {
      const dt = T - k.T;
      if (dt < 0 || dt > k.dur) continue;
      const a = Math.min(ease(dt / 0.35), 1 - ease((dt - k.dur + 0.3) / 0.3));
      drawCard(g, k, a, side, W, H, u, st);
    }
    if (st.caption.mode !== 'nenhuma') drawCaptions(g, this.caps, T, W, H, u, st, cl);
    if (cl.watermark && this.logo) {
      const lh = 64 * u, lw = lh * (this.logo.naturalWidth / this.logo.naturalHeight || 1);
      g.globalAlpha = 0.85;
      g.drawImage(this.logo, side === 'right' ? W - lw - 48 * u : 48 * u, 44 * u + st.frame.letterbox * H, lw, lh);
      g.globalAlpha = 1;
    }
    if (cl.openingTitle && T < 3.2) {
      const a = Math.min(ease(T / 0.4), 1 - ease((T - 2.6) / 0.6));
      drawOpening(g, a, T, this.lesson.title, this.meta?.module || '', cl, st, W, H, u);
    }
    g.restore();
  }
}

// ---------------------------------------------------------------- prévia de estilo sem vídeo
// Cena ilustrada (consultório desfocado + expert de jaleco) usada nas miniaturas dos modelos:
// aparece na hora, em qualquer aparelho, mesmo antes de enviar um vídeo.
const sceneCache = {};
function sampleScene(side) {
  if (sceneCache[side]) return sceneCache[side];
  const W = 1280, H = 720;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  let gr = g.createLinearGradient(0, 0, W, H);
  gr.addColorStop(0, '#d9e2df'); gr.addColorStop(0.55, '#b9c8c4'); gr.addColorStop(1, '#8c9e9a');
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
  // luz de janela e objetos desfocados ao fundo
  const ox = side === 'right' ? 0.22 : 0.78;
  const blob = (x, y, r, col) => { const rg = g.createRadialGradient(x, y, 0, x, y, r); rg.addColorStop(0, col); rg.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = rg; g.fillRect(x - r, y - r, r * 2, r * 2); };
  blob(W * ox, H * 0.28, 330, 'rgba(255,255,255,0.75)');
  blob(W * (ox + 0.08), H * 0.72, 140, 'rgba(70,120,90,0.45)');
  blob(W * (ox - 0.1), H * 0.6, 110, 'rgba(200,170,120,0.35)');
  g.fillStyle = 'rgba(60,80,76,0.18)'; g.fillRect(W * ox - 190, H * 0.56, 380, 14);
  // expert
  const px = side === 'right' ? W * 0.68 : W * 0.32;
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.25)'; g.shadowBlur = 40;
  g.fillStyle = '#f4f6f6'; // jaleco
  g.beginPath();
  g.moveTo(px - 300, H); g.bezierCurveTo(px - 290, H * 0.72, px - 210, H * 0.62, px - 90, H * 0.6);
  g.lineTo(px + 90, H * 0.6); g.bezierCurveTo(px + 210, H * 0.62, px + 290, H * 0.72, px + 300, H); g.closePath(); g.fill();
  g.restore();
  g.fillStyle = '#3d5a80'; // camisa
  g.beginPath(); g.moveTo(px - 70, H * 0.6); g.lineTo(px, H * 0.84); g.lineTo(px + 70, H * 0.6); g.closePath(); g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.12)'; g.lineWidth = 4;
  g.beginPath(); g.moveTo(px - 70, H * 0.6); g.lineTo(px - 20, H); g.moveTo(px + 70, H * 0.6); g.lineTo(px + 20, H); g.stroke();
  g.strokeStyle = '#2c3e3b'; g.lineWidth = 7; // estetoscópio
  g.beginPath(); g.moveTo(px - 95, H * 0.62); g.bezierCurveTo(px - 120, H * 0.85, px - 30, H * 0.9, px - 40, H * 0.98); g.stroke();
  g.fillStyle = '#e2b394'; g.fillRect(px - 38, H * 0.5, 76, 70); // pescoço
  g.beginPath(); g.ellipse(px, H * 0.37, 92, 116, 0, 0, Math.PI * 2); g.fill(); // rosto
  g.fillStyle = '#3b2a22'; // cabelo
  g.beginPath(); g.ellipse(px, H * 0.3, 100, 86, 0, Math.PI, Math.PI * 2); g.fill();
  g.beginPath(); g.ellipse(px - 82, H * 0.38, 26, 70, 0.1, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.ellipse(px + 82, H * 0.38, 26, 70, -0.1, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#2b2b2b'; // olhos e sorriso
  g.beginPath(); g.ellipse(px - 32, H * 0.37, 8, 9, 0, 0, Math.PI * 2); g.ellipse(px + 32, H * 0.37, 8, 9, 0, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#a5614d'; g.lineWidth = 5; g.lineCap = 'round';
  g.beginPath(); g.arc(px, H * 0.42, 30, 0.2 * Math.PI, 0.8 * Math.PI); g.stroke();
  return (sceneCache[side] = c);
}

// Desenha a prévia de um estilo (modelo, cores, legenda, destaque, nome + CRM) sobre a cena ilustrada.
export function drawStylePreview(canvas, client, override = {}, { T = 4.6, title = 'Aula de exemplo' } = {}) {
  const cl = { ...client, ...override };
  const p = new Player(document.createElement('canvas'));
  const word = (cl.keywords || [])[0] || 'destaque';
  p.client = cl;
  p.lesson = { title, clips: [{ srcId: '_', in: 0, out: 20 }], cards: [], words: {}, sources: [] };
  p.starts = [0]; p.total = 20; p.T = T;
  const words = ['Hoje', 'vamos', 'falar', 'sobre', word].map((w, i) => ({ w, s: T - 0.9 + i * 0.22, e: T - 0.7 + i * 0.22 }));
  p.caps = [{ s: T - 1, e: T + 2, text: words.map((w) => w.w).join(' '), words }];
  p.cardsT = [{ T: T - 1, dur: 4, text: word, sub: '' }];
  p.frame = { img: sampleScene(cl.expertSide === 'right' ? 'right' : 'left'), w: 1280, h: 720 };
  p.draw(canvas);
}

// ---------------------------------------------------------------- utilitários de desenho
function lookFilter(cl, st) {
  if (cl.look && cl.look !== 'auto' && LOOKS[cl.look]) return LOOKS[cl.look].filter;
  return st.look || 'none';
}

const hasLS = typeof CanvasRenderingContext2D !== 'undefined' && 'letterSpacing' in CanvasRenderingContext2D.prototype;
function setFont(g, st, part, size, weight) {
  const f = String(part.font || '').startsWith('x:') ? fontStack(part.font.slice(2)) : (FONTS[part.font] || FONTS.inter);
  g.font = `${weight ?? part.weight ?? 600} ${Math.round(size)}px ${f}`;
  if (hasLS) g.letterSpacing = `${((part.tracking || 0) * size).toFixed(1)}px`;
}
function fam(k, fb = FONTS.inter) { return String(k || '').startsWith('x:') ? fontStack(k.slice(2)) : (FONTS[k] || fb); }
function resetLS(g) { if (hasLS) g.letterSpacing = '0px'; }

function fitText(g, text, maxW, weight, size, family = FONTS.inter) {
  let s = size;
  do { g.font = `${weight} ${s}px ${family}`; s -= 2; } while (g.measureText(text).width > maxW && s > 12);
  return s + 2;
}

function rr(g, x, y, w, h, r) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, Math.max(0, r)); else g.rect(x, y, w, h);
}
function roundRect(g, x, y, w, h, r, fill) { rr(g, x, y, w, h, r); g.fillStyle = fill; g.fill(); }

function shadow(g, st, u, strength = 1) {
  const k = st.shadow * strength;
  g.shadowColor = `rgba(0,0,0,${(0.28 * k).toFixed(3)})`;
  g.shadowBlur = 44 * u * k; g.shadowOffsetY = 14 * u * k;
}
function noShadow(g) { g.shadowColor = 'transparent'; g.shadowBlur = 0; g.shadowOffsetY = 0; }

function hexA(hex, a) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Moldura: faixas de cinema, vinheta, granulado e grade "blueprint"
let grainTile;
function drawFrameFx(g, W, H, u, st, T) {
  const f = st.frame;
  if (f.grid) {
    g.save();
    g.strokeStyle = 'rgba(160,190,255,0.10)'; g.lineWidth = Math.max(1, u);
    const step = 60 * u;
    g.beginPath();
    for (let x = 0; x <= W; x += step) { g.moveTo(x, 0); g.lineTo(x, H); }
    for (let y = 0; y <= H; y += step) { g.moveTo(0, y); g.lineTo(W, y); }
    g.stroke();
    g.restore();
  }
  if (f.vignette) {
    const gr = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) / 2);
    gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, `rgba(0,0,0,${f.vignette})`);
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
  }
  if (f.grain) {
    if (!grainTile) {
      grainTile = document.createElement('canvas'); grainTile.width = grainTile.height = 192;
      const gc = grainTile.getContext('2d'), id = gc.createImageData(192, 192);
      for (let i = 0; i < id.data.length; i += 4) { const v = Math.random() * 255; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; }
      gc.putImageData(id, 0, 0);
    }
    g.save();
    g.globalAlpha = f.grain; g.globalCompositeOperation = 'overlay';
    const p = g.createPattern(grainTile, 'repeat');
    const o = Math.floor((T * 24) % 8) * 23;
    g.translate(-o, -o * 0.7); g.fillStyle = p; g.fillRect(o, o * 0.7, W, H);
    g.restore();
  }
  if (f.letterbox) {
    const b = H * f.letterbox;
    g.fillStyle = '#000'; g.fillRect(0, 0, W, b); g.fillRect(0, H - b, W, b);
  }
}

function drawEyebrow(g, text, x, y, st, u, align, dark) {
  const size = 22 * u;
  g.save();
  g.font = `600 ${size}px ${FONTS.mono}`;
  if (hasLS) g.letterSpacing = `${(0.18 * size).toFixed(1)}px`;
  const w = g.measureText(text).width + 30 * u, h = size + 20 * u;
  const bx = align === 'right' ? x - w : x;
  roundRect(g, bx, y, w, h, h / 2, dark ? 'rgba(8,12,24,0.92)' : hexA(st.accent, 0.14));
  g.fillStyle = dark ? '#FFFFFF' : st.accent;
  g.textBaseline = 'middle'; g.textAlign = 'left';
  g.fillText(text, bx + 15 * u, y + h / 2 + 1);
  g.restore();
  return h;
}

// Cartões de destaque (variam por modelo)
function drawCard(g, k, a, side, W, H, u, st) {
  const cs = st.card;
  const text = cs.upper ? k.text.toUpperCase() : k.text.charAt(0).toUpperCase() + k.text.slice(1);
  const maxW = W * 0.38;
  let fs = cs.size * u;
  setFont(g, st, cs, fs);
  while (g.measureText(text).width > maxW - 90 * u && fs > 20) { fs -= 2; setFont(g, st, cs, fs); }
  const tw = g.measureText(text).width;
  const padX = 48 * u, padY = 34 * u;
  const eb = cs.eyebrow && cs.variant !== 'minimal' ? 60 * u : 0;
  const subH = k.sub ? 44 * u : 0;
  const w = Math.max(tw + padX * 2, 280 * u);
  const h = fs * 1.05 + padY * 2 + subH;
  const right = side === 'right';
  const x = right ? W - w - 90 * u : 90 * u;
  const y = H * 0.34 - h / 2 + eb / 2;
  const off = (1 - a) * 50 * u * (right ? 1 : -1);
  const X = x + off;
  g.save();
  g.globalAlpha = a;
  if (eb) drawEyebrow(g, cs.eyebrow, right ? X + w : X, y - eb, st, u, right ? 'right' : 'left', cs.variant === 'dark');
  let fg = st.primary, subFg = '#5B6B6B';
  switch (cs.variant) {
    case 'dark':
      shadow(g, st, u); roundRect(g, X, y, w, h, cs.radius * u, hexA(st.primary, 0.94)); noShadow(g);
      g.strokeStyle = 'rgba(255,255,255,0.10)'; g.lineWidth = 1.5 * u; rr(g, X, y, w, h, cs.radius * u); g.stroke();
      roundRect(g, X + padX, y + padY - 14 * u, 40 * u, 6 * u, 3 * u, st.accent);
      fg = '#FFFFFF'; subFg = 'rgba(255,255,255,0.7)'; break;
    case 'glass':
      shadow(g, st, u, 1.3); roundRect(g, X, y, w, h, cs.radius * u, 'rgba(255,255,255,0.80)'); noShadow(g);
      g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 2 * u; rr(g, X, y, w, h, cs.radius * u); g.stroke();
      roundRect(g, X + padX, y + padY - 14 * u, 34 * u, 6 * u, 3 * u, st.accent); break;
    case 'outline':
      roundRect(g, X, y, w, h, cs.radius * u, 'rgba(0,0,0,0.38)');
      g.strokeStyle = st.accent; g.lineWidth = 2 * u; rr(g, X + 8 * u, y + 8 * u, w - 16 * u, h - 16 * u, 0); g.stroke();
      fg = st.text; subFg = hexA(st.text, 0.75); break;
    case 'minimal':
      roundRect(g, X + padX, y + padY - 10 * u, 70 * u, 3 * u, 0, st.accent);
      g.shadowColor = 'rgba(0,0,0,0.55)'; g.shadowBlur = 18 * u;
      fg = st.text; subFg = hexA(st.text, 0.8); break;
    case 'tag':
      g.translate(X + w / 2, y + h / 2); g.rotate(-0.035); g.translate(-(X + w / 2), -(y + h / 2));
      shadow(g, st, u, 1.2); roundRect(g, X, y, w, h, cs.radius * u, st.accent); noShadow(g);
      fg = '#111111'; subFg = 'rgba(0,0,0,0.7)'; break;
    case 'bar':
      roundRect(g, X, y, w, h, cs.radius * u, 'rgba(10,10,10,0.82)');
      g.fillStyle = st.accent; g.fillRect(right ? X + w - 10 * u : X, y, 10 * u, h);
      fg = '#FFFFFF'; subFg = 'rgba(255,255,255,0.75)'; break;
    default: // light
      shadow(g, st, u); roundRect(g, X, y, w, h, cs.radius * u, 'rgba(255,255,255,0.96)'); noShadow(g);
      roundRect(g, X + padX, y + padY - 14 * u, 44 * u, 6 * u, 3 * u, st.accent);
  }
  setFont(g, st, cs, fs);
  g.fillStyle = fg; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  g.fillText(text, X + padX, y + padY + fs * 0.92);
  noShadow(g); resetLS(g);
  if (k.sub) {
    g.fillStyle = subFg; g.font = `400 ${28 * u}px ${FONTS.inter}`;
    g.fillText(k.sub, X + padX, y + padY + fs + 36 * u, w - padX * 2);
  }
  g.restore();
}

// Nome + CRM
function drawLower(g, a, cl, st, W, H, u) {
  const right = cl.expertSide === 'right';
  const sub = [cl.specialty, cl.crm].filter(Boolean).join('  ·  ');
  const y0 = H * 0.66 - st.frame.letterbox * H * 0.5;
  const nameSize = 44 * u, subSize = 26 * u;
  g.save();
  g.globalAlpha = a;
  const nameFont = st.lower === 'line' ? `300 ${nameSize * 1.05}px ${fam(st.card.font, FONTS.inter)}` : `700 ${nameSize}px ${st.card.font?.startsWith?.('x:') ? fam(st.card.font) : FONTS.tight}`;
  g.font = nameFont;
  const w1 = g.measureText(cl.name || '').width;
  g.font = `500 ${subSize}px ${st.lower === 'dark' ? FONTS.mono : FONTS.inter}`;
  const w2 = g.measureText(sub).width;
  const w = Math.max(w1, w2) + 64 * u, h = (sub ? 114 : 80) * u;
  const off = (1 - a) * 30 * u * (right ? 1 : -1);
  const x = (right ? W - 80 * u - w : 80 * u) + off;
  const y = y0 - 62 * u;
  let nameColor = st.primary, subColor = '#5B6B6B';
  if (st.lower === 'dark') {
    shadow(g, st, u, 0.8); roundRect(g, x, y, w, h, 16 * u, hexA(st.primary, 0.94)); noShadow(g);
    nameColor = '#FFFFFF'; subColor = st.accent;
  } else if (st.lower === 'line') {
    g.fillStyle = st.accent; g.fillRect(x + 32 * u, y + h + 4 * u, 90 * u, 2 * u);
    g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 16 * u;
    nameColor = st.text; subColor = hexA(st.text, 0.8);
  } else if (st.lower === 'bar') {
    roundRect(g, x, y, w, h, 4 * u, 'rgba(10,10,10,0.82)');
    g.fillStyle = st.accent; g.fillRect(right ? x + w - 10 * u : x, y, 10 * u, h);
    nameColor = '#FFFFFF'; subColor = 'rgba(255,255,255,0.78)';
  } else {
    shadow(g, st, u, 0.8); roundRect(g, x, y, w, h, 14 * u, 'rgba(255,255,255,0.95)'); noShadow(g);
    g.fillStyle = st.accent; g.fillRect(right ? x + w - 7 * u : x, y, 7 * u, h);
  }
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  g.font = nameFont; g.fillStyle = nameColor;
  if (hasLS && st.lower === 'line') g.letterSpacing = `${0.08 * nameSize}px`;
  g.fillText(st.lower === 'line' ? (cl.name || '').toUpperCase() : cl.name || '', x + 32 * u, y + 56 * u);
  resetLS(g);
  if (sub) {
    g.font = `500 ${subSize}px ${st.lower === 'dark' ? FONTS.mono : FONTS.inter}`; g.fillStyle = subColor;
    g.fillText(sub, x + 32 * u, y + 94 * u);
  }
  g.restore();
}

// Abertura com o título da aula
function drawOpening(g, a, T, title, module, cl, st, W, H, u) {
  g.save();
  const kind = st.opening;
  const bg = kind === 'cinema' ? '#000000' : kind === 'editorial' ? '#F4F1EA' : st.primary;
  const fg = kind === 'editorial' ? '#211F2E' : kind === 'cinema' ? '#F4F1EA' : (st.text || '#FFFFFF');
  g.globalAlpha = a * (kind === 'cinema' ? 0.96 : 0.93);
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  g.globalAlpha = a;
  if (kind === 'grid') {
    g.strokeStyle = 'rgba(160,190,255,0.14)'; g.lineWidth = Math.max(1, u);
    const step = 60 * u; g.beginPath();
    for (let x = 0; x <= W; x += step) { g.moveTo(x, 0); g.lineTo(x, H); }
    for (let y = 0; y <= H; y += step) { g.moveTo(0, y); g.lineTo(W, y); }
    g.stroke();
  }
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const rise = (1 - ease(T / 0.6)) * 18 * u;
  if (kind === 'cinema') {
    g.font = `300 ${22 * u}px ${FONTS.inter}`;
    if (hasLS) g.letterSpacing = `${8 * u}px`;
    g.fillStyle = hexA(fg, 0.7); g.fillText(module.toUpperCase(), W / 2, H / 2 - 70 * u + rise);
    const s = fitText(g, title.toUpperCase(), W * 0.8, 300, 64 * u, fam(st.card.font, FONTS.tight));
    g.font = `300 ${s}px ${fam(st.card.font, FONTS.tight)}`;
    if (hasLS) g.letterSpacing = `${0.22 * s}px`;
    g.fillStyle = fg; g.fillText(title.toUpperCase(), W / 2, H / 2 + rise);
    if (hasLS) g.letterSpacing = `${6 * u}px`;
    g.font = `400 ${22 * u}px ${FONTS.inter}`; g.fillStyle = hexA(fg, 0.6);
    g.fillText((cl.name || '').toUpperCase(), W / 2, H / 2 + 80 * u + rise);
  } else {
    if (kind === 'grid' || kind === 'editorial') {
      const label = (module || 'AULA').toUpperCase();
      g.font = `600 ${22 * u}px ${FONTS.mono}`;
      if (hasLS) g.letterSpacing = `${4 * u}px`;
      const lw = g.measureText(label).width + 40 * u, lh = 50 * u;
      if (kind === 'grid') roundRect(g, W / 2 - lw / 2, H / 2 - 130 * u + rise, lw, lh, lh / 2, 'rgba(8,12,24,0.9)');
      g.fillStyle = kind === 'grid' ? '#FFFFFF' : st.accent;
      g.fillText(label, W / 2, H / 2 - 105 * u + rise);
      resetLS(g);
    } else {
      g.fillStyle = st.accent; g.fillRect(W / 2 - 40 * u, H / 2 - 92 * u + rise, 80 * u, 5 * u);
      g.font = `500 ${24 * u}px ${FONTS.inter}`; g.fillStyle = hexA(fg, 0.8);
      if (hasLS) g.letterSpacing = `${3 * u}px`;
      g.fillText(module.toUpperCase(), W / 2, H / 2 - 52 * u + rise);
      resetLS(g);
    }
    const tf = kind === 'editorial' && !String(st.card.font).startsWith('x:') ? FONTS.tight : fam(st.card.font, FONTS.tight);
    const wt = kind === 'editorial' ? 800 : 700;
    const s = fitText(g, title, W * 0.82, wt, (kind === 'editorial' ? 84 : 70) * u, tf);
    g.font = `${wt} ${s}px ${tf}`;
    if (hasLS && kind === 'editorial') g.letterSpacing = `${-0.03 * s}px`;
    g.fillStyle = fg; g.fillText(title, W / 2, H / 2 + 14 * u + rise);
    resetLS(g);
    g.font = `400 ${26 * u}px ${FONTS.inter}`; g.fillStyle = hexA(fg, 0.75);
    g.fillText(cl.name || '', W / 2, H / 2 + 92 * u + rise);
  }
  resetLS(g);
  g.restore();
}

// Legendas (variam por modelo)
function drawCaptions(g, caps, T, W, H, u, st, cl) {
  const p = caps.find((c) => T >= c.s && T <= c.e + 0.05);
  if (!p) return;
  const cs = st.caption;
  const lb = st.frame.letterbox * H;
  const y = cl.captionPos === 'middle' ? H * 0.62 : (lb ? H - lb / 2 : H * (cs.mode === 'palavra' ? 0.8 : 0.86));
  let words = p.words;
  if (cs.mode === 'palavra') {
    const at = words.findIndex((w) => T < w.e);
    const j = at < 0 ? words.length - 1 : at;
    const start = Math.floor(j / 3) * 3;
    words = words.slice(start, start + 3);
  }
  let fs = (lb ? Math.min(cs.size, lb / u * 0.42) : cs.size) * u;
  setFont(g, st, cs, fs);
  // espaço entre palavras: fontes condensadas (ex.: Anton) têm espaço estreito demais, e no modo palavra a ativa cresce 14%
  let space = 0;
  const parts = words.map((w) => ({ ...w, txt: cs.upper ? w.w.toUpperCase() : w.w }));
  let total = 0;
  const measure = () => { space = Math.max(g.measureText(' ').width, fs * (cs.mode === 'palavra' ? 0.5 : 0.24)); parts.forEach((pp) => (pp.wid = g.measureText(pp.txt).width)); total = parts.reduce((a, pp) => a + pp.wid, 0) + space * (parts.length - 1); };
  measure();
  while (total > W * 0.86 && fs > 16) { fs -= 2; setFont(g, st, cs, fs); measure(); }
  let x = W / 2 - total / 2;
  g.textAlign = 'left'; g.textBaseline = 'middle';
  const boxFill = cs.box === 'light' ? 'rgba(255,255,255,0.94)' : cs.box === 'dark' ? 'rgba(10,15,20,0.66)' : null;
  if (boxFill && cs.mode !== 'palavra') {
    if (st.shadow && cs.box === 'light') shadow(g, st, u, 0.6);
    roundRect(g, x - 26 * u, y - fs * 0.85, total + 52 * u, fs * 1.7, (cs.box === 'light' ? fs * 0.85 : 14 * u), boxFill);
    noShadow(g);
  }
  const base = cs.color || (cs.box === 'light' ? st.primary : '#FFFFFF');
  for (const pp of parts) {
    const active = T >= pp.s && T < pp.e;
    const kw = isKeyword(pp.w, cl);
    let scale = 1;
    if (cs.mode === 'palavra' && active) scale = 1 + 0.14 * (1 - ease((T - pp.s) / 0.18));
    if (cs.active === 'bg' && active && cs.mode === 'karaoke') roundRect(g, x - 8 * u, y - fs * 0.62, pp.wid + 16 * u, fs * 1.24, 8 * u, st.accent);
    g.save();
    g.translate(x + pp.wid / 2, y);
    g.scale(scale, scale);
    if (cs.mode === 'palavra') {
      g.lineWidth = 10 * u; g.lineJoin = 'round'; g.strokeStyle = 'rgba(0,0,0,0.9)';
      g.strokeText(pp.txt, -pp.wid / 2, 0);
    } else if (!boxFill) {
      g.shadowColor = 'rgba(0,0,0,0.75)'; g.shadowBlur = 12 * u; g.shadowOffsetY = 2 * u;
    }
    let color = base;
    if (cs.mode === 'palavra') color = active || kw ? st.accent : '#FFFFFF';
    else if (cs.active === 'bg' && active && cs.mode === 'karaoke') color = onColor(st.accent); // texto legível sobre a cor de destaque (ex.: lima, azul-claro)
    else if ((cs.active === 'color' && active && cs.mode !== 'limpa') || kw) color = cs.box === 'light' && !kw ? st.accent : st.accent;
    g.fillStyle = color;
    if (cs.mode === 'palavra' && T < pp.s) g.globalAlpha = 0.55;
    g.fillText(pp.txt, -pp.wid / 2, 0);
    g.restore();
    x += pp.wid + space;
  }
  resetLS(g);
}

// Preto ou branco, o que for mais legível sobre a cor dada.
function onColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return '#FFFFFF';
  const n = parseInt(m[1], 16), lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.4 ? '#111111' : '#FFFFFF';
}

// LUT guardado no aparelho (ou na nuvem) como texto .cube
export async function loadLutText(id) {
  const b = await db.getBlob(id);
  if (!b) throw new Error('LUT não encontrado neste aparelho');
  return await b.text();
}
