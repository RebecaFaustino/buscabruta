// Linha do tempo do editor, no padrão do Edvid (editor de vídeo por conversa, MIT):
// faixas com ícone (Legendas, Destaques, Vídeo, Voz, Trilha), régua MM:SS, agulha laranja, clipes "Take 01…",
// alças de aparar só no clipe selecionado, encaixe magnético (8 px), navalha (C), exclusão com fechamento (Delete),
// desfazer/refazer, zoom 1×–8× (Ctrl + roda / pinça / + − 0) e marcação IN/OUT para cortar um trecho.
// Feita em DOM: a agulha anda sem redesenhar as faixas (leve no celular).

const LABEL = 46; // coluna dos ícones das faixas (px)
const MIN_CLIP = 0.04;
const SNAP_PX = 8;
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

const ICON = {
  captions: '<rect x="2.5" y="4" width="11" height="8" rx="1.5"/><path d="M5 9.5h2.5M9 9.5h2M5 7h6"/>',
  text: '<path d="M3.5 4.5h9M8 4.5v8M6 12.5h4"/>',
  video: '<rect x="2" y="4.5" width="8.5" height="7" rx="1.5"/><path d="m10.5 7 3.5-2v6l-3.5-2"/>',
  voice: '<path d="M2.5 8h1M5 5.5v5M7.5 3.5v9M10 6v4M12.5 7.5v1"/>',
  anim: '<path d="M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3M4.3 4.3l1.6 1.6M10.1 10.1l1.6 1.6M11.7 4.3l-1.6 1.6M5.9 10.1l-1.6 1.6"/>',
  music: '<path d="M6 11.5V4l6.5-1.5V10"/><circle cx="4.5" cy="11.5" r="1.5"/><circle cx="11" cy="10" r="1.5"/>',
  undo: '<path d="M5.5 4 3 6.5 5.5 9"/><path d="M3 6.5h6.5a3.5 3.5 0 0 1 0 7H7"/>',
  redo: '<path d="M10.5 4 13 6.5 10.5 9"/><path d="M13 6.5H6.5a3.5 3.5 0 0 0 0 7H9"/>',
  cut: '<circle cx="4.5" cy="11.5" r="2"/><circle cx="11.5" cy="11.5" r="2"/><path d="m5.8 10 6.7-8M10.2 10 3.5 2"/>',
  back: '<path d="M7.5 4.5 4 8l3.5 3.5M12 4.5 8.5 8l3.5 3.5"/>',
  fwd: '<path d="M8.5 4.5 12 8l-3.5 3.5M4 4.5 7.5 8 4 11.5"/>',
  play: '<path d="M5 3.5v9l7.5-4.5z" fill="currentColor"/>',
  pause: '<path d="M5 3.5v9M11 3.5v9" stroke-width="2.4"/>',
  vol: '<path d="M3 6.5h2.5L9 4v8L5.5 9.5H3z"/><path d="M11 6a3 3 0 0 1 0 4"/>',
  mute: '<path d="M3 6.5h2.5L9 4v8L5.5 9.5H3z"/><path d="m11 6.5 3 3M14 6.5l-3 3"/>',
  trash: '<path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.6 8.5h4.8l.6-8.5"/>',
  zoomc: '<circle cx="7" cy="7" r="4"/><path d="m10 10 3.5 3.5M5.5 7h3M7 5.5v3"/>',
  card: '<rect x="2.5" y="4" width="11" height="8" rx="2"/><path d="M5 8h6"/>',
  left: '<path d="M9.5 4 5.5 8l4 4"/>',
  right: '<path d="M6.5 4 10.5 8l-4 4"/>',
};
const svg = (k, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round">${ICON[k]}</svg>`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const mmss = (t) => { t = Math.max(0, Math.floor(t + 1e-6)); const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, ss = String(t % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`; };
const tc = (t, fps = 30) => { t = Math.max(0, t); const f = Math.floor((t % 1) * fps + 1e-6); return `${mmss(t)}:${String(f).padStart(2, '0')}`; };

export function createTimeline(host, o) {
  // o: { lesson, player, client, envs, musicName(), onTool(name), snapshot(), changed(), undo(), redo(), canUndo(), canRedo(), cutRange(a, b) }
  const { lesson, player } = o;
  const st = { zoom: 1, sel: -1, inPt: null, outPt: null, muted: false, drag: null };

  host.innerHTML = `
    <section class="tlx" aria-label="Linha do tempo">
      <div class="tlx-bar">
        <span class="tlx-badge" id="tlxBadge">Vídeos em sequência</span>
        <div class="tlx-hist" aria-label="Histórico de edições">
          <button class="tlx-ib" data-x="undo" title="Desfazer (Ctrl+Z)" aria-label="Desfazer">${svg('undo')}</button>
          <button class="tlx-ib" data-x="redo" title="Refazer (Shift+Ctrl+Z)" aria-label="Refazer">${svg('redo')}</button>
        </div>
        <div class="tlx-tools">
          <button class="tlx-ib" data-tool="zoom" title="Zoom do clipe (Z)" aria-label="Zoom do clipe">${svg('zoomc')}</button>
          <button class="tlx-ib" data-tool="card" title="Destaque na agulha (K)" aria-label="Adicionar destaque">${svg('card')}</button>
          <button class="tlx-ib" data-tool="left" title="Mover clipe para trás" aria-label="Mover clipe para trás">${svg('left')}</button>
          <button class="tlx-ib" data-tool="right" title="Mover clipe para frente" aria-label="Mover clipe para frente">${svg('right')}</button>
          <button class="tlx-ib" data-tool="delete" title="Excluir clipe (Delete)" aria-label="Excluir clipe">${svg('trash')}</button>
        </div>
        <span class="tlx-tc" id="timeLbl"><b>00:00:00</b> / 00:00:00</span>
      </div>
      <div class="tlx-scroll" id="tlxScroll">
        <div class="tlx-content" id="tlxContent">
          <div class="tlx-ruler" id="tlxRuler"></div>
          <div class="tlx-tracks" id="tlxTracks"></div>
          <div class="tlx-range" id="tlxRange" hidden></div>
          <div class="tlx-ph" id="tlxPh"><i></i></div>
        </div>
      </div>
      <div class="tlx-transport">
        <div class="tlx-tl">
          <button class="tlx-pill" data-x="in" title="Marcar início do trecho (I)">IN</button>
          <button class="tlx-pill" data-x="out" title="Marcar fim do trecho (O)">OUT</button>
          <button class="tlx-ib" data-tool="split" title="Dividir o take na agulha (C)" aria-label="Dividir na agulha">${svg('cut')}</button>
          <button class="tlx-pill go" data-x="cutRange" id="tlxCutRange" hidden title="Cortar o trecho marcado do vídeo">Cortar trecho</button>
        </div>
        <div class="tlx-tc2">
          <button class="tlx-skip" data-x="back" title="Voltar 5 segundos" aria-label="Voltar 5 segundos">${svg('back')}<small>5s</small></button>
          <button class="tlx-play" id="playBtn" title="Reproduzir (Espaço)" aria-label="Reproduzir">${svg('play')}</button>
          <button class="tlx-skip" data-x="fwd" title="Avançar 5 segundos" aria-label="Avançar 5 segundos"><small>5s</small>${svg('fwd')}</button>
        </div>
        <div class="tlx-tr">
          <div class="tlx-zoom">
            <button data-x="zout" title="Reduzir zoom (-)" aria-label="Reduzir zoom">−</button>
            <span id="tlxZoomLbl">1×</span>
            <button data-x="zin" title="Aumentar zoom (+)" aria-label="Aumentar zoom">+</button>
            <button data-x="fit" title="Ver a linha do tempo inteira (0)">Fit</button>
          </div>
          <button class="tlx-ib" data-x="mute" title="Silenciar" aria-label="Silenciar" id="tlxMute">${svg('vol')}</button>
        </div>
      </div>
    </section>`;

  const $ = (s) => host.querySelector(s);
  const scroll = $('#tlxScroll'), content = $('#tlxContent'), ruler = $('#tlxRuler'), tracks = $('#tlxTracks'), ph = $('#tlxPh'), range = $('#tlxRange');
  const dur = () => player.duration || 0;
  const laneW = () => Math.max(1, content.clientWidth - LABEL);
  const xOf = (t) => LABEL + (dur() ? (t / dur()) * laneW() : 0);
  const tOf = (x) => Math.max(0, Math.min(dur(), ((x - LABEL) / laneW()) * dur()));
  const spp = () => (dur() ? dur() / laneW() : 0); // segundos por pixel

  // ---------- desenho ----------
  function setWidth() { content.style.width = `${Math.round(st.zoom * 100)}%`; $('#tlxZoomLbl').textContent = `${st.zoom.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}×`; }

  function drawRuler() {
    const d = dur();
    if (!d) { ruler.innerHTML = ''; return; }
    const perView = Math.max(4, scroll.clientWidth / 110); // ~1 rótulo a cada 110 px visíveis
    const target = d / (st.zoom * perView);
    const step = STEPS.find((s) => s >= target) || 900;
    let html = '';
    for (let t = 0; xOf(t) < xOf(d) - 56; t += step) html += `<span class="tk" style="left:${xOf(t)}px"><em>${mmss(t)}</em></span>`;
    html += `<span class="tk end" style="left:${xOf(d)}px"><em>${mmss(d)}</em></span>`;
    ruler.innerHTML = html;
  }

  function wave(c) {
    const env = o.envs.get(c.srcId);
    if (!env) return '';
    const n = Math.max(8, Math.min(240, Math.round((c.out - c.in) * 8)));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const a = c.in + ((c.out - c.in) * i) / n, b = c.in + ((c.out - c.in) * (i + 1)) / n;
      let m = 0;
      for (let k = Math.floor(a * 100); k < Math.ceil(b * 100) && k < env.length; k++) if (env[k] > m) m = env[k];
      pts.push(Math.min(15, Math.sqrt(m) * 26));
    }
    let top = '', bot = '';
    pts.forEach((h, i) => { const x = ((i / n) * 100).toFixed(2); top += `${i ? 'L' : 'M'}${x} ${(16 - h).toFixed(1)}`; bot = `L${x} ${(16 + h).toFixed(1)}` + bot; });
    return `<svg class="wv" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true"><path d="${top}${bot}Z"/></svg>`;
  }

  function block(cls, t0, t1, label, extra = '') {
    const l = xOf(t0) - LABEL, w = Math.max(2, xOf(t1) - xOf(t0));
    if (w < 18) cls += ' tiny';
    return `<div class="${cls}" style="left:${l}px;width:${w}px" ${extra}><span class="lb">${label}</span></div>`;
  }

  // Só desenha o que está perto da parte visível (aulas de 1 h têm milhares de legendas e cortes).
  let vis = [0, Infinity];
  function visibleRange() {
    const d = dur();
    if (!d) return [0, Infinity];
    const a = tOf(scroll.scrollLeft - scroll.clientWidth), b = tOf(scroll.scrollLeft + 2 * scroll.clientWidth);
    return [a, b <= a ? Infinity : b];
  }
  const inView = (t0, t1) => t1 >= vis[0] && t0 <= vis[1];
  let lastSL = -1e9;
  scroll.addEventListener('scroll', () => {
    if (Math.abs(scroll.scrollLeft - lastSL) < scroll.clientWidth * 0.5) return;
    requestAnimationFrame(() => { drawTracks(); drawRuler(); });
  }, { passive: true });

  function drawTracks() {
    const clips = lesson.clips, starts = player.starts || [];
    vis = visibleRange(); lastSL = scroll.scrollLeft;
    const rows = [];
    const track = (kind, tone, title, inner) => rows.push(`<div class="tlx-track" data-kind="${kind}"><div class="tlx-lab ${tone}" title="${title}">${svg(ICON[kind] ? kind : 'video')}</div><div class="tlx-lane">${inner}</div></div>`);
    const caps = player.caps || [];
    if (caps.length) track('captions', 'teal', 'Legendas', caps.filter((p) => inView(p.s, p.e)).map((p) => block('chip capt', p.s, p.e, esc(p.text))).join(''));
    const cards = player.cardsT || [];
    if (cards.length) track('text', 'orange', 'Destaques', cards.filter((k) => inView(k.T, k.T + (k.dur || 3))).map((k) => block('chip head', k.T, k.T + (k.dur || 3), esc(k.text))).join(''));
    const lots = player.lottiesT || [];
    if (lots.length) track('anim', 'olive', 'Animações (After Effects)', lots.filter((k) => inView(k.T, k.T + k.dur)).map((k) => block('chip mus', k.T, k.T + k.dur, esc(k.name))).join(''));
    track('video', 'orange', 'Vídeo', clips.map((c, i) => {
      const t0 = starts[i] ?? 0, t1 = t0 + (c.out - c.in);
      if (!inView(t0, t1) && i !== st.sel) return '';
      const z = (c.zoom || 1) > 1.01 ? ` · ${Math.round(c.zoom * 100)}%` : '';
      const sel = i === st.sel;
      const handles = sel ? '<b class="hd l" data-h="in" title="Ajustar início do take (arraste)"></b><b class="hd r" data-h="out" title="Ajustar fim do take (arraste)"></b>' : '';
      const wpx = xOf(t1) - xOf(t0), num = String(i + 1).padStart(2, '0');
      return block(`clip vid${i % 2 ? ' alt' : ''}${sel ? ' sel' : ''}`, t0, t1, wpx >= 64 ? `Take ${num}${z}` : num, `data-i="${i}"`).replace('</div>', `${handles}</div>`);
    }).join(''));
    track('voice', 'teal', 'Voz', clips.map((c, i) => {
      const t0 = starts[i] ?? 0, t1 = t0 + (c.out - c.in);
      if (!inView(t0, t1)) return '';
      return `<div class="clip aud${i === st.sel ? ' link' : ''}${xOf(t1) - xOf(t0) < 18 ? ' tiny' : ''}" data-i="${i}" style="left:${xOf(t0) - LABEL}px;width:${Math.max(2, xOf(t1) - xOf(t0))}px">${wave(c)}</div>`;
    }).join(''));
    const mus = o.musicName?.();
    if (mus && dur()) track('music', 'olive', 'Trilha', block('chip mus', 0, dur(), `Trilha sonora · ${esc(mus)}`));
    tracks.innerHTML = rows.join('') || '<p class="tlx-empty">Importe um vídeo para começar.</p>';
  }

  function drawRange() {
    const a = st.inPt, b = st.outPt;
    const ok = a != null && b != null && b - a > 0.05;
    $('#tlxCutRange').hidden = !ok;
    host.querySelector('[data-x="in"]').classList.toggle('on', a != null);
    host.querySelector('[data-x="out"]').classList.toggle('on', b != null);
    if (a == null && b == null) { range.hidden = true; return; }
    const s = a ?? b, e = b ?? a;
    range.hidden = false;
    range.style.left = `${xOf(Math.min(s, e))}px`;
    range.style.width = `${Math.max(1, xOf(Math.max(s, e)) - xOf(Math.min(s, e)))}px`;
    range.classList.toggle('single', !ok);
  }

  function drawHead() {
    ph.style.left = `${xOf(player.T)}px`;
    const fps = 30;
    $('#timeLbl').innerHTML = `<b>${tc(player.T, fps)}</b> / ${tc(dur(), fps)}`;
    const pb = $('#playBtn');
    if (pb._p !== player.playing) { pb._p = player.playing; pb.innerHTML = svg(player.playing ? 'pause' : 'play'); pb.title = player.playing ? 'Pausar (Espaço)' : 'Reproduzir (Espaço)'; pb.setAttribute('aria-label', player.playing ? 'Pausar' : 'Reproduzir'); }
    host.querySelector('[data-x="undo"]').disabled = !o.canUndo();
    host.querySelector('[data-x="redo"]').disabled = !o.canRedo();
    $('#tlxBadge').textContent = lesson.render ? 'Vídeo final pronto' : 'Prévia das edições';
  }

  function draw() { setWidth(); drawRuler(); drawTracks(); drawRange(); drawHead(); }

  function follow() {
    if (!player.playing) return;
    const x = xOf(player.T);
    if (x > scroll.scrollLeft + scroll.clientWidth - 60 || x < scroll.scrollLeft + LABEL) scroll.scrollLeft = x - LABEL - 20;
  }

  // ---------- zoom ----------
  // aulas longas: permite aproximar até ~20 s por tela (1 h → até 180×)
  const maxZ = () => Math.max(8, Math.min(400, dur() / 20));
  function setZoom(z, anchorClientX) {
    z = Math.round(Math.max(1, Math.min(maxZ(), z)) * 100) / 100;
    if (z === st.zoom) return;
    const r = scroll.getBoundingClientRect();
    const ax = anchorClientX != null ? anchorClientX - r.left : xOf(player.T) - scroll.scrollLeft;
    const t = tOf(scroll.scrollLeft + ax);
    st.zoom = z;
    setWidth();
    draw();
    scroll.scrollLeft = Math.max(0, xOf(t) - ax);
  }
  scroll.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return; // roda normal rola; Ctrl+roda (ou pinça no trackpad) dá zoom
    e.preventDefault();
    setZoom(st.zoom * Math.exp(-e.deltaY * 0.01), e.clientX);
  }, { passive: false });

  // ---------- encaixe magnético ----------
  function snap(t, exclude) {
    const thr = SNAP_PX * spp();
    const cands = [0, player.T, dur()];
    (player.starts || []).forEach((s, i) => { if (i !== exclude) { cands.push(s, s + lesson.clips[i].out - lesson.clips[i].in); } });
    let best = t, bd = thr;
    for (const c of cands) { const dd = Math.abs(c - t); if (dd < bd) { bd = dd; best = c; } }
    return best;
  }

  // ---------- ponteiro ----------
  function seekTo(t) { player.seek(Math.max(0, Math.min(dur() - 0.001, t))); }

  content.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    const r = content.getBoundingClientRect();
    const x = e.clientX - r.left;
    const hd = e.target.closest('.hd');
    const clipEl = e.target.closest('.clip');
    const onRuler = e.target.closest('.tlx-ruler');
    const touch = e.pointerType !== 'mouse';

    if (hd) return startTrim(e, +hd.closest('.clip').dataset.i, hd.dataset.h);
    if (x < LABEL && !onRuler) return; // coluna de ícones

    // toque fora da régua: espera para saber se foi toque (posiciona/seleciona) ou arrasto (rola)
    if (touch && !onRuler) {
      const x0 = e.clientX, y0 = e.clientY, sl = scroll.scrollLeft;
      const up = (ev) => {
        content.removeEventListener('pointerup', up);
        if (Math.abs(ev.clientX - x0) > 8 || Math.abs(ev.clientY - y0) > 8 || Math.abs(scroll.scrollLeft - sl) > 4) return;
        select(clipEl ? +clipEl.dataset.i : -1);
        seekTo(tOf(x));
      };
      content.addEventListener('pointerup', up);
      return;
    }
    // mouse (ou dedo na régua): clica e arrasta para percorrer
    e.preventDefault();
    select(clipEl ? +clipEl.dataset.i : -1);
    const was = player.playing; if (was) player.stop();
    content.setPointerCapture(e.pointerId);
    seekTo(tOf(x));
    const mv = (ev) => seekTo(tOf(ev.clientX - content.getBoundingClientRect().left));
    const up = () => { content.removeEventListener('pointermove', mv); content.removeEventListener('pointerup', up); content.removeEventListener('pointercancel', up); if (was) player.play(); };
    content.addEventListener('pointermove', mv); content.addEventListener('pointerup', up); content.addEventListener('pointercancel', up);
  });

  function startTrim(e, i, edge) {
    e.preventDefault(); e.stopPropagation();
    const c = lesson.clips[i]; if (!c) return;
    const src = lesson.sources.find((s) => s.id === c.srcId);
    const max = src?.duration ?? c.out;
    const orig = { in: c.in, out: c.out };
    const start0 = player.starts[i];
    const sppNow = spp(), x0 = e.clientX;
    o.snapshot();
    player.stop();
    content.setPointerCapture(e.pointerId);
    st.drag = { i, edge };
    const mv = (ev) => {
      const dt = (ev.clientX - x0) * sppNow;
      if (edge === 'in') {
        // início: o corte anda e o resto da linha do tempo acompanha (sem buraco)
        const want = orig.in + dt;
        c.in = Math.max(0, Math.min(c.out - MIN_CLIP, want));
      } else {
        const endT = snap(start0 + (orig.out - orig.in) + dt, i);
        c.out = Math.max(c.in + MIN_CLIP, Math.min(max, orig.in + (endT - start0)));
      }
      player.invalidate(); draw();
    };
    const end = (cancel) => {
      content.removeEventListener('pointermove', mv); content.removeEventListener('pointerup', up); content.removeEventListener('pointercancel', cn);
      removeEventListener('keydown', esc);
      st.drag = null;
      if (cancel) { c.in = orig.in; c.out = orig.out; o.dropSnapshot?.(); }
      o.changed();
      seekTo(edge === 'in' ? player.starts[i] : Math.min(player.T, dur()));
    };
    const up = () => end(false), cn = () => end(true);
    const esc = (ev) => { if (ev.key === 'Escape') end(true); };
    content.addEventListener('pointermove', mv); content.addEventListener('pointerup', up); content.addEventListener('pointercancel', cn);
    addEventListener('keydown', esc);
  }

  function select(i) { st.sel = i; o.onSelect?.(i); drawTracks(); }

  // ---------- botões ----------
  host.addEventListener('click', (e) => {
    const b = e.target.closest('[data-x],[data-tool]');
    if (!b || b.disabled) return;
    if (b.dataset.tool) return o.onTool(b.dataset.tool);
    action(b.dataset.x);
  });
  function action(x) {
    if (x === 'undo') o.undo();
    else if (x === 'redo') o.redo();
    else if (x === 'back') seekTo(player.T - 5);
    else if (x === 'fwd') seekTo(player.T + 5);
    else if (x === 'zin') setZoom(st.zoom * 1.5);
    else if (x === 'zout') setZoom(st.zoom / 1.5);
    else if (x === 'fit') { setZoom(1); scroll.scrollLeft = 0; }
    else if (x === 'in') { st.inPt = player.T; if (st.outPt != null && st.outPt <= st.inPt) st.outPt = null; drawRange(); }
    else if (x === 'out') { st.outPt = player.T; if (st.inPt != null && st.inPt >= st.outPt) st.inPt = null; drawRange(); }
    else if (x === 'cutRange') {
      const a = st.inPt, b = st.outPt;
      if (a == null || b == null || b - a < 0.05) return;
      st.inPt = st.outPt = null;
      o.cutRange(a, b);
    } else if (x === 'mute') {
      st.muted = !st.muted;
      player.ensureAudio?.();
      if (player.speaker) player.speaker.gain.value = st.muted ? 0 : 1;
      const m = $('#tlxMute'); m.innerHTML = svg(st.muted ? 'mute' : 'vol'); m.title = st.muted ? 'Ativar áudio' : 'Silenciar'; m.classList.toggle('on', st.muted);
    }
  }

  // ---------- teclado ----------
  function onKey(e) {
    if (e.target.matches?.('input, textarea, select, [contenteditable]')) return false;
    const k = e.key, mod = e.ctrlKey || e.metaKey;
    if (mod && (k === 'z' || k === 'Z')) { e.preventDefault(); e.shiftKey ? o.redo() : o.undo(); return true; }
    if (mod && (k === 'y' || k === 'Y')) { e.preventDefault(); o.redo(); return true; }
    if (mod) return false;
    if (k === '+' || k === '=') { action('zin'); return true; }
    if (k === '-' || k === '_') { action('zout'); return true; }
    if (k === '0') { action('fit'); return true; }
    if (k === 'i' || k === 'I') { action('in'); return true; }
    if (k === 'o' || k === 'O') { action('out'); return true; }
    if (k === 'c' || k === 'C') { o.onTool('split'); return true; }
    if (k === 'Escape' && (st.inPt != null || st.outPt != null)) { st.inPt = st.outPt = null; drawRange(); return true; }
    return false;
  }

  const ro = new ResizeObserver(() => draw());
  ro.observe(scroll);

  return {
    draw, drawHead, follow, onKey,
    get sel() { return st.sel; }, set sel(i) { st.sel = i; drawTracks(); },
    fit() { setZoom(1); scroll.scrollLeft = 0; },
    // vista inicial: no celular (ou aula longa) aproxima até ~6 px por segundo, para os takes não ficarem finos demais
    initialView() {
      const lane1 = Math.max(1, scroll.clientWidth - LABEL), d = dur();
      const z = d ? Math.max(1, Math.min(maxZ(), ((d > 900 ? 2 : 6) * d) / lane1)) : 1;
      st.zoom = Math.round(z * 100) / 100; draw(); scroll.scrollLeft = 0;
    },
    dispose() { ro.disconnect(); },
  };
}
