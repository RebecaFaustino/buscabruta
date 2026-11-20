// Aprende o estilo de um cliente a partir de 2 ou 3 vídeos já editados:
// cores (paleta), ritmo de cortes, quanto do vídeo tem fala e, quando o Claude está disponível,
// legenda, destaques, fontes e modelo, olhando alguns quadros. Tudo roda no aparelho; só os quadros
// reduzidos vão para o Claude (se a usuária permitir).
import { TEMPLATES, CAPTION_MODES } from './styles.js';
import { FONT_LIST, fontName } from './fonts.js';
import { analyze } from './audio.js';

const loadMB = () => import('../vendor/mediabunny.min.mjs');
const hex = (r, g, b) => '#' + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');

async function framesOf(file, onStep) {
  const { Input, ALL_FORMATS, BlobSource, VideoSampleSink } = await loadMB();
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error(`“${file.name}” não tem imagem de vídeo.`);
    const dur = await input.computeDuration();
    const span = Math.min(dur, 120); // analisa até 2 min de cada exemplo
    const n = Math.max(8, Math.min(180, Math.round(span * 1.5)));
    const sink = new VideoSampleSink(track);
    const small = document.createElement('canvas'); small.width = 64; small.height = 36;
    const sg = small.getContext('2d', { willReadFrequently: true });
    const grays = [], keep = [];
    const keepAt = new Set([0.12, 0.35, 0.6, 0.85].map((f) => Math.round(f * (n - 1))));
    let i = 0;
    const times = Array.from({ length: n }, (_, k) => (span * (k + 0.5)) / n);
    for await (const sample of sink.samplesAtTimestamps(times)) {
      if (sample) {
        const src = sample.toCanvasImageSource();
        sg.drawImage(src, 0, 0, 64, 36);
        const d = sg.getImageData(0, 0, 64, 36).data;
        const g = new Uint8Array(64 * 36);
        for (let p = 0; p < g.length; p++) g[p] = (d[p * 4] * 0.299 + d[p * 4 + 1] * 0.587 + d[p * 4 + 2] * 0.114) | 0;
        grays.push(g);
        if (keepAt.has(i)) {
          const w = 512, h = Math.round((512 * sample.displayHeight) / sample.displayWidth);
          const c = document.createElement('canvas'); c.width = w; c.height = h;
          c.getContext('2d').drawImage(src, 0, 0, w, h);
          keep.push(c);
        }
        sample.close();
      }
      i++;
      onStep?.(i / n);
    }
    // cortes: mudança grande de imagem entre amostras vizinhas
    let cuts = 0;
    for (let k = 1; k < grays.length; k++) {
      let s = 0; const a = grays[k], b = grays[k - 1];
      for (let p = 0; p < a.length; p++) s += Math.abs(a[p] - b[p]);
      if (s / a.length > 26) cuts++;
    }
    const vertical = track.displayHeight > track.displayWidth;
    return { dur: span, cuts, frames: keep, vertical };
  } finally { input.dispose?.(); }
}

// Paleta: cores marcantes (saturadas) e a cor escura dominante, por agrupamento simples (k-médias).
function paletteOf(canvases) {
  const px = [];
  for (const c of canvases) {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 4 * 7) px.push([d[i], d[i + 1], d[i + 2]]);
  }
  const satL = ([r, g, b]) => { const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255, l = (mx + mn) / 2; const s = mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1)); return [s, l]; };
  const vivid = px.filter((p) => { const [s, l] = satL(p); return s > 0.42 && l > 0.18 && l < 0.85; });
  const kmeans = (pts, k) => {
    if (pts.length < k) return [];
    let cs = Array.from({ length: k }, (_, i) => pts[Math.floor(((i + 0.5) * pts.length) / k)].slice());
    let lab = new Array(pts.length).fill(0);
    for (let it = 0; it < 10; it++) {
      for (let i = 0; i < pts.length; i++) { let b = 0, bd = Infinity; for (let j = 0; j < k; j++) { const dd = (pts[i][0] - cs[j][0]) ** 2 + (pts[i][1] - cs[j][1]) ** 2 + (pts[i][2] - cs[j][2]) ** 2; if (dd < bd) { bd = dd; b = j; } } lab[i] = b; }
      const sum = Array.from({ length: k }, () => [0, 0, 0, 0]);
      pts.forEach((p, i) => { const s = sum[lab[i]]; s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++; });
      cs = cs.map((c, j) => (sum[j][3] ? [sum[j][0] / sum[j][3], sum[j][1] / sum[j][3], sum[j][2] / sum[j][3]] : c));
    }
    const cnt = new Array(k).fill(0); lab.forEach((l) => cnt[l]++);
    return cs.map((c, j) => ({ c, n: cnt[j] })).filter((x) => x.n > pts.length * 0.03).sort((a, b) => b.n - a.n);
  };
  const vc = kmeans(vivid, 5);
  const dark = px.filter((p) => satL(p)[1] < 0.3);
  const dc = kmeans(dark, 2);
  const avgL = px.reduce((a, p) => a + satL(p)[1], 0) / (px.length || 1);
  const pal = [...vc.map((x) => hex(...x.c)), ...dc.slice(0, 1).map((x) => hex(...x.c))];
  return { pal: [...new Set(pal)], accent: vc[0] ? hex(...vc[0].c) : null, primary: dc[0] ? hex(...dc[0].c) : null, avgL, vividShare: vivid.length / (px.length || 1) };
}

export async function learnStyle(files, client, smp, onProg) {
  const all = [];
  let tCuts = 0, tDur = 0, speech = 0, envN = 0, pauses = [];
  for (let f = 0; f < files.length; f++) {
    const base = f / files.length, part = 1 / files.length;
    onProg?.(base, `Olhando o vídeo ${f + 1} de ${files.length}…`);
    const r = await framesOf(files[f], (x) => onProg?.(base + part * 0.75 * x, `Olhando o vídeo ${f + 1} de ${files.length}…`));
    all.push(r); tCuts += r.cuts; tDur += r.dur;
    onProg?.(base + part * 0.8, `Ouvindo o vídeo ${f + 1}…`);
    try {
      const { env } = await analyze(files[f]);
      const thr = Math.pow(10, -38 / 20);
      let run = 0;
      const lim = Math.min(env.length, 12000);
      for (let i = 0; i < lim; i++) { if (env[i] > thr) { speech++; if (run > 15) pauses.push(run / 100); run = 0; } else run++; }
      envN += lim;
    } catch { /* sem áudio */ }
  }
  const frames = all.flatMap((r) => r.frames);
  if (!frames.length) throw new Error('Não consegui ler imagens desses vídeos. Use MP4 ou MOV.');
  onProg?.(0.9, 'Juntando as cores…');
  const P = paletteOf(frames);
  const cutsPerMin = tDur ? (tCuts / tDur) * 60 : 0;
  const speechPct = envN ? Math.round((speech / envN) * 100) : 0;
  const medPause = pauses.length ? pauses.sort((a, b) => a - b)[Math.floor(pauses.length / 2)] : 0.6;

  // Sugestão feita no aparelho (sempre existe)
  const patch = {};
  if (P.primary) patch.primary = P.primary;
  if (P.accent) patch.accent = P.accent;
  patch.template = cutsPerMin >= 18 ? 'impacto' : P.avgL < 0.3 ? 'cinema' : P.vividShare > 0.12 ? 'suave' : 'clinico';
  patch.autoZoom = cutsPerMin >= 8;
  patch.minSilence = Math.max(0.25, Math.min(1, +(medPause * 0.8).toFixed(2)));
  if (all.some((r) => r.vertical)) patch.platform = 'reels';
  let notes = '', ai = false;

  // Com o Claude (opcional): olha os quadros e completa legenda, fontes e destaques
  if (smp) {
    const lim = await smp.limits?.().catch(() => null);
    if (lim?.images) {
      try {
        onProg?.(0.93, 'Pedindo a leitura do estilo ao Claude…');
        const pick = frames.filter((_, i) => i % Math.ceil(frames.length / Math.min(lim.images.maxCount || 6, 6)) === 0).slice(0, 6);
        const blobs = await Promise.all(pick.map((c) => new Promise((res) => c.toBlob(res, 'image/jpeg', 0.8))));
        const out = await smp.json(`Você é diretor de arte de vídeos de cursos para médicos. Estes quadros são de vídeos já editados do cliente "${client.name}" (${client.specialty || 'saúde'}).
Medidas do aparelho: ${cutsPerMin.toFixed(1)} cortes por minuto, ${speechPct}% do tempo com fala, cores marcantes encontradas: ${P.pal.join(', ') || 'nenhuma'}.
Descreva o estilo visual que se repete (legendas, cartões de destaque, cores, fontes) e escolha as opções do nosso editor que mais se parecem.
Responda só com JSON:
{"modelo": um de ${JSON.stringify(Object.keys(TEMPLATES))},
 "legenda": um de ${JSON.stringify(Object.keys(CAPTION_MODES).filter((k) => k !== 'auto'))},
 "posicao_legenda": "bottom" ou "middle",
 "cor_principal": "#RRGGBB", "cor_destaque": "#RRGGBB",
 "fonte_titulos": a mais parecida entre ${JSON.stringify(FONT_LIST)},
 "fonte_legenda": a mais parecida entre ${JSON.stringify(FONT_LIST)},
 "lado_expert": "left" ou "right",
 "observacoes": "até 2 frases em português simples sobre o estilo"}`, { images: blobs, modelTier: 'default' });
        if (out && typeof out === 'object') {
          ai = true;
          if (TEMPLATES[out.modelo]) patch.template = out.modelo;
          if (CAPTION_MODES[out.legenda] && out.legenda !== 'auto') patch.captionStyle = out.legenda;
          if (out.posicao_legenda === 'middle' || out.posicao_legenda === 'bottom') patch.captionPos = out.posicao_legenda;
          const h = (v) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).toLowerCase() : null);
          if (h(out.cor_principal)) patch.primary = h(out.cor_principal);
          if (h(out.cor_destaque)) patch.accent = h(out.cor_destaque);
          const ft = fontName(out.fonte_titulos), fb = fontName(out.fonte_legenda);
          if (FONT_LIST.includes(ft)) patch.fontTitle = ft;
          if (FONT_LIST.includes(fb)) patch.fontBody = fb;
          if (out.lado_expert === 'left' || out.lado_expert === 'right') patch.expertSide = out.lado_expert;
          notes = String(out.observacoes || '').slice(0, 300);
        }
      } catch (e) { console.warn('leitura de estilo pela IA', e); }
    }
  }
  if (patch.primary) {
    const n = parseInt(patch.primary.slice(1), 16), L = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    patch.text = L > 0.6 ? '#1f1530' : '#ffffff';
  }
  onProg?.(1, 'Pronto');
  return { patch, palette: P.pal, stats: { cutsPerMin, speechPct, medPause }, ai, notes };
}
