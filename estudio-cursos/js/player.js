// Motor de reprodução da linha do tempo editada + composição (zoom, look, legendas, palavras-chave).
import { db } from './db.js';
import { LOOKS } from './presets.js';
import { timelineCaptions, srcToTimeline, isKeyword } from './captions.js';
import { playSfx } from './sfx.js';

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
    for (const s of lesson.sources) {
      if (this.videos.has(s.id)) continue;
      const v = document.createElement('video');
      v.preload = 'auto';
      v.playsInline = true;
      v.crossOrigin = 'anonymous';
      v.setAttribute('playsinline', '');
      v.style.cssText = 'width:2px;height:2px';
      v.src = await mediaURL(s.mediaId);
      videoShelf().appendChild(v);
      this.videos.set(s.id, v);
      if (this.ctx) this.wireAudio(v);
      await new Promise((r) => { if (v.readyState >= 2) r(); else { v.addEventListener('loadeddata', r, { once: true }); v.addEventListener('error', r, { once: true }); } });
    }
    this.logo = null;
    if (client.logoMediaId) {
      const img = new Image();
      img.src = await mediaURL(client.logoMediaId);
      await img.decode().catch(() => {});
      this.logo = img;
    }
    this.invalidate();
    this.T = Math.min(this.T, this.duration);
    await this.seek(this.T);
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
    this.chainIn = voiceChain(ctx, this.master);
    for (const v of this.videos.values()) this.wireAudio(v);
  }

  wireAudio(v) {
    if (v._src) return;
    v._src = this.ctx.createMediaElementSource(v);
    this.applyClean(v);
  }

  applyClean(v) {
    v._src.disconnect();
    v._src.connect(this.client?.cleanVoice ? this.chainIn : this.master);
  }

  refreshAudio() { if (this.ctx) for (const v of this.videos.values()) if (v._src) this.applyClean(v); }

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
    for (const v of this.videos.values()) v.pause();
  }

  async play() {
    if (!this.lesson?.clips.length || this.playing) return;
    this.ensureAudio();
    if (this.T >= this.duration - 0.05) this.T = 0;
    this.playing = true;
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
    if (this.playing) { this.T = this.duration; this.playing = false; }
    this.onTime(this.T);
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
  draw(canvas = this.canvas) {
    const g = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const cl = this.client || {};
    g.save();
    g.fillStyle = '#0d1414';
    g.fillRect(0, 0, W, H);
    if (!this.lesson?.clips.length) {
      g.fillStyle = '#7d8b8b'; g.font = `500 ${H * 0.035}px Inter, sans-serif`; g.textAlign = 'center';
      g.fillText('Importe um vídeo para começar', W / 2, H / 2);
      g.restore();
      return;
    }
    const T = this.T;
    const i = this.clipAt(T), c = this.lesson.clips[i];
    // na exportação quadro a quadro, o quadro vem decodificado (this.frame) em vez do <video>
    const fr = this.frame;
    const v = fr ? null : this.videos.get(c.srcId);
    const img = fr ? fr.img : v;
    const local = (T - this.starts[i]) / Math.max(0.001, c.out - c.in);
    if (img && (fr ? fr.w : v.videoWidth)) {
      let zoom = c.zoom || 1;
      if (cl.smoothZoom) zoom *= 1 + 0.035 * local;
      const vw = fr ? fr.w : v.videoWidth, vh = fr ? fr.h : v.videoHeight;
      const s = Math.max(W / vw, H / vh) * zoom;
      const dw = vw * s, dh = vh * s;
      const fx = cl.focusX ?? 0.5, fy = 0.38;
      const vertical = W / H < 0.8 && vw / vh > 1;
      const tx = vertical ? 0.5 : fx;
      let dx = W * tx - fx * dw, dy = H * fy - fy * dh;
      dx = Math.min(0, Math.max(W - dw, dx)); dy = Math.min(0, Math.max(H - dh, dy));
      g.filter = LOOKS[cl.look]?.filter || 'none';
      g.drawImage(img, dx, dy, dw, dh);
      g.filter = 'none';
    }
    const u = H / 1080; // unidade relativa
    const side = cl.expertSide === 'right' ? 'left' : 'right'; // lado das palavras-chave

    // Nome + CRM (lower third) do lado do expert
    if (cl.lowerThird && T > 3.4 && T < 9) {
      const a = Math.min(ease((T - 3.4) / 0.5), 1 - ease((T - 8.4) / 0.6));
      const x0 = cl.expertSide === 'right' ? W - 80 * u : 80 * u;
      const al = cl.expertSide === 'right' ? 'right' : 'left';
      const y0 = H * 0.66;
      g.globalAlpha = a;
      g.textAlign = al; g.textBaseline = 'alphabetic';
      g.font = `600 ${44 * u}px Inter, sans-serif`;
      const w1 = g.measureText(cl.name).width;
      g.font = `400 ${26 * u}px Inter, sans-serif`;
      const sub = [cl.specialty, cl.crm].filter(Boolean).join('  ·  ');
      const w = Math.max(w1, g.measureText(sub).width) + 56 * u;
      const off = (1 - a) * 30 * u * (al === 'left' ? -1 : 1);
      const bx = (al === 'left' ? x0 - 28 * u : x0 - w + 28 * u) + off;
      roundRect(g, bx, y0 - 60 * u, w, 110 * u, 14 * u, 'rgba(255,255,255,0.94)');
      g.fillStyle = cl.accent;
      g.fillRect(al === 'left' ? bx : bx + w - 6 * u, y0 - 60 * u, 6 * u, 110 * u);
      g.fillStyle = cl.primary;
      g.font = `600 ${44 * u}px Inter, sans-serif`;
      g.fillText(cl.name, x0 + off, y0);
      g.fillStyle = '#5b6b6b';
      g.font = `400 ${26 * u}px Inter, sans-serif`;
      g.fillText(sub, x0 + off, y0 + 36 * u);
      g.globalAlpha = 1;
    }

    // Cartões de palavra-chave ao lado do expert
    for (const k of this.cardsT) {
      const dt = T - k.T;
      if (dt < 0 || dt > k.dur) continue;
      const a = Math.min(ease(dt / 0.35), 1 - ease((dt - k.dur + 0.3) / 0.3));
      drawCard(g, k, a, side, W, H, u, cl);
    }

    // Legendas
    if (cl.captionStyle !== 'nenhuma') drawCaptions(g, this.caps, T, W, H, u, cl);

    // Marca d'água / logo
    if (cl.watermark && this.logo) {
      const lh = 64 * u, lw = lh * (this.logo.naturalWidth / this.logo.naturalHeight || 1);
      g.globalAlpha = 0.85;
      g.drawImage(this.logo, side === 'right' ? W - lw - 48 * u : 48 * u, 44 * u, lw, lh);
      g.globalAlpha = 1;
    }
    // Abertura com título da aula
    if (cl.openingTitle && T < 3.2) {
      const a = Math.min(ease(T / 0.4), 1 - ease((T - 2.6) / 0.6));
      g.globalAlpha = a * 0.92;
      g.fillStyle = cl.primary;
      g.fillRect(0, 0, W, H);
      g.globalAlpha = a;
      g.fillStyle = cl.accent;
      g.fillRect(W / 2 - 40 * u, H / 2 - 92 * u, 80 * u, 5 * u);
      g.fillStyle = cl.text || '#fff';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = `400 ${26 * u}px Inter, sans-serif`;
      g.fillText((this.meta?.module || '').toUpperCase(), W / 2, H / 2 - 50 * u);
      fitText(g, this.lesson.title, W * 0.8, 600, 66 * u);
      g.fillText(this.lesson.title, W / 2, H / 2 + 20 * u);
      g.font = `400 ${26 * u}px Inter, sans-serif`;
      g.globalAlpha = a * 0.8;
      g.fillText(cl.name || '', W / 2, H / 2 + 90 * u);
      g.globalAlpha = 1;
    }

    g.restore();
  }
}

function fitText(g, text, maxW, weight, size) {
  let s = size;
  do { g.font = `${weight} ${s}px Inter, sans-serif`; s -= 2; } while (g.measureText(text).width > maxW && s > 12);
}

function roundRect(g, x, y, w, h, r, fill) {
  g.beginPath();
  g.roundRect ? g.roundRect(x, y, w, h, r) : g.rect(x, y, w, h);
  g.fillStyle = fill;
  g.fill();
}

function drawCard(g, k, a, side, W, H, u, cl) {
  const text = k.text.toUpperCase();
  const maxW = W * 0.36;
  fitText(g, text, maxW - 80 * u, 700, 72 * u);
  const fs = parseFloat(g.font.split(' ')[1]);
  const tw = g.measureText(text).width;
  const w = Math.max(tw + 96 * u, 300 * u);
  const h = (k.sub ? 170 : 130) * u;
  const x = side === 'right' ? W - w - 90 * u : 90 * u;
  const y = H * 0.36 - h / 2;
  const off = (1 - a) * 50 * u * (side === 'right' ? 1 : -1);
  g.globalAlpha = a;
  g.shadowColor = 'rgba(0,0,0,0.18)'; g.shadowBlur = 40 * u; g.shadowOffsetY = 12 * u;
  roundRect(g, x + off, y, w, h, 20 * u, 'rgba(255,255,255,0.96)');
  g.shadowColor = 'transparent';
  g.fillStyle = cl.accent;
  g.fillRect(x + off + 48 * u, y + 30 * u, 44 * u, 5 * u);
  g.fillStyle = cl.primary;
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  g.font = `700 ${fs}px Inter, sans-serif`;
  g.fillText(text, x + off + 48 * u, y + 40 * u + fs);
  if (k.sub) {
    g.fillStyle = '#5b6b6b';
    g.font = `400 ${28 * u}px Inter, sans-serif`;
    g.fillText(k.sub, x + off + 48 * u, y + 40 * u + fs + 44 * u, w - 96 * u);
  }
  g.globalAlpha = 1;
}

function drawCaptions(g, caps, T, W, H, u, cl) {
  const p = caps.find((c) => T >= c.s && T <= c.e + 0.05);
  if (!p) return;
  const y = cl.captionPos === 'middle' ? H * 0.62 : H * 0.86;
  g.textAlign = 'left'; g.textBaseline = 'middle';
  let words = p.words;
  if (cl.captionStyle === 'palavra') {
    const at = words.findIndex((w) => T < w.e);
    const j = at < 0 ? words.length - 1 : at;
    const start = Math.floor(j / 3) * 3;
    words = words.slice(start, start + 3);
  }
  const fs = (cl.captionStyle === 'palavra' ? 64 : 48) * u;
  const weight = cl.captionStyle === 'palavra' ? 800 : 600;
  g.font = `${weight} ${fs}px Inter, sans-serif`;
  const space = g.measureText(' ').width;
  const parts = words.map((w) => ({ ...w, txt: cl.captionStyle === 'palavra' ? w.w.toUpperCase() : w.w, wid: 0 }));
  parts.forEach((p) => (p.wid = g.measureText(p.txt).width));
  const total = parts.reduce((a, p) => a + p.wid, 0) + space * (parts.length - 1);
  let x = W / 2 - total / 2;
  if (cl.captionStyle === 'bloco' || cl.captionStyle === 'karaoke') {
    roundRect(g, x - 28 * u, y - fs * 0.85, total + 56 * u, fs * 1.7, 14 * u, 'rgba(10,20,20,0.62)');
  }
  for (const p of parts) {
    const active = T >= p.s && T < p.e;
    const kw = isKeyword(p.w, cl);
    let scale = 1;
    if (cl.captionStyle === 'palavra' && active) scale = 1 + 0.12 * (1 - ease((T - p.s) / 0.18));
    if (cl.captionStyle === 'karaoke' && active) roundRect(g, x - 8 * u, y - fs * 0.62, p.wid + 16 * u, fs * 1.24, 8 * u, cl.accent);
    g.save();
    g.translate(x + p.wid / 2, y);
    g.scale(scale, scale);
    g.lineWidth = 8 * u; g.lineJoin = 'round';
    if (cl.captionStyle === 'palavra') { g.strokeStyle = 'rgba(0,0,0,0.75)'; g.strokeText(p.txt, -p.wid / 2, 0); }
    g.fillStyle = kw && !(cl.captionStyle === 'karaoke' && active) ? cl.accent : '#ffffff';
    if (cl.captionStyle === 'palavra' && T < p.s) g.globalAlpha = 0.55;
    g.fillText(p.txt, -p.wid / 2, 0);
    g.restore();
    x += p.wid + space;
  }
}
