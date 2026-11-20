// Exportação quadro a quadro (WebCodecs): cada quadro é decodificado, composto e codificado no tempo exato.
// Não perde quadros (60 fps de verdade, 4K), não depende da tela ficar visível e costuma ser mais rápida que o tempo real.
import {
  Input, ALL_FORMATS, BlobSource, VideoSampleSink, AudioBufferSink,
  Output, Mp4OutputFormat, BufferTarget, StreamTarget, CanvasSource, AudioBufferSource,
  canEncodeAudio, getFirstEncodableVideoCodec,
} from '../vendor/mediabunny.min.mjs';
import { db, opfsFile, opfsRemove } from './db.js';
import { cleanVoice, voicePreset, presetChain } from './audiopro.js';
import { SFX } from './sfx.js';
import { buildMusic, scheduleMusic } from './music.js';
import { envs } from './pipeline.js';

export async function offlineCodecs(preset) {
  if (typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined' || typeof OfflineAudioContext === 'undefined') return null;
  const video = await getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], { width: preset.w, height: preset.h, bitrate: preset.vbr }).catch(() => null);
  const audio = (await canEncodeAudio('aac').catch(() => false)) ? 'aac' : (await canEncodeAudio('opus').catch(() => false)) ? 'opus' : null;
  return video && audio ? { video, audio } : null;
}

async function openSources(lesson) {
  const m = new Map();
  for (const s of lesson.sources) {
    const blob = await db.getBlob(s.mediaId);
    if (!blob) throw Object.assign(new Error(`O vídeo “${s.name}” não está neste aparelho. Toque em “Reencontrar vídeo” no aviso do topo da tela e escolha o arquivo.`), { code: 'missing' });
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    m.set(s.id, { input, video: await input.getPrimaryVideoTrack(), audio: await input.getPrimaryAudioTrack() });
  }
  return m;
}

// ================= Áudio em blocos =================
// Aulas longas (1 h ou mais) não cabem num único buffer de áudio: o som é montado em blocos de 30 s
// (com 1 s de pré-rolagem para o compressor não "pular" na emenda) e entregue ao codificador junto com a imagem.
const WIN = 30, PRE = 1;

// Agenda um valor ao longo do tempo num AudioParam, aceitando pontos antes do início do bloco.
function envelope(param, pts) {
  const at = (t) => { // valor da rampa linear no instante t
    if (t <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) if (t <= pts[i][0]) { const [t0, v0] = pts[i - 1], [t1, v1] = pts[i]; return t1 > t0 ? v0 + ((v1 - v0) * (t - t0)) / (t1 - t0) : v1; }
    return pts[pts.length - 1][1];
  };
  param.setValueAtTime(at(0), 0);
  for (const [t, v] of pts) if (t > 0) param.linearRampToValueAtTime(v, t);
}

function planVoice(player, cl) {
  const clips = player.lesson.clips, gains = takeGains(clips, cl);
  return clips.map((c, i) => {
    const prev = clips[i - 1], d0 = c.out - c.in;
    // Corte em J (como no Edvid): a voz do take seguinte entra até 150 ms antes da imagem
    const lead = cl.jcut !== false && i > 0 ? Math.min(0.15, c.in, 0.45 * (prev.out - prev.in), 0.45 * d0) : 0;
    const L = lead >= 0.03 ? lead : 0;
    return { c, at: player.starts[i] - L, a: c.in - L, d: d0 + L, L, k: gains[i] };
  });
}

// Renderiza [w0, w1) da linha do tempo. part: 'voice' (só voz tratada), 'bed' (trilha + efeitos) ou 'all'.
async function renderWindow({ player, srcs, plan, total, cl, music }, w0, w1, sr, ch, part) {
  const t0 = Math.max(0, w0 - PRE);
  const len = Math.max(1, Math.ceil((w1 - t0) * sr));
  const ctx = new OfflineAudioContext(ch, len, sr);
  const master = ctx.createGain(); master.connect(ctx.destination);
  if (part !== 'bed') {
    const vp = voicePreset(cl);
    const into = presetChain(ctx, master, vp);
    for (const p of plan) {
      if (p.at + p.d <= t0 || p.at >= w1) continue;
      const tr = srcs.get(p.c.srcId)?.audio;
      if (!tr || !(await tr.canDecode())) continue;
      const g = ctx.createGain();
      const rel = p.at - t0;
      envelope(g.gain, [[rel, 0], [rel + Math.max(0.012, p.L), p.k], [rel + p.d - 0.015, p.k], [rel + p.d, 0]]);
      g.connect(into);
      const sa = p.a + Math.max(0, t0 - p.at), sb = Math.min(p.c.out, p.a + (w1 - p.at));
      if (sb <= sa) continue;
      for await (const { buffer, timestamp } of new AudioBufferSink(tr).buffers(sa, sb)) {
        const node = ctx.createBufferSource();
        node.buffer = buffer; node.connect(g);
        const off = Math.max(0, sa - timestamp);
        const when = (p.at - t0) + (Math.max(timestamp, sa) - p.a);
        const dur = Math.min(buffer.duration - off, sb - Math.max(timestamp, sa));
        if (dur > 0) node.start(Math.max(0, when), off, dur);
      }
    }
  }
  if (part !== 'voice') {
    if (music) scheduleMusic(ctx, ctx.destination, music, { T: t0, total, vol: cl.musicVol ?? 0.35, when: 0 });
    if (cl.sfx) {
      const vol = cl.sfxVol ?? 0.5;
      const fx = (name, t, v) => {
        if (t >= total || t < t0 || t >= w1) return;
        const n = ctx.createBufferSource(); n.buffer = SFX[name].build(ctx);
        const g = ctx.createGain(); g.gain.value = v;
        n.connect(g).connect(ctx.destination); n.start(t - t0);
      };
      if (cl.openingTitle) fx('sino', 0.05, vol * 0.8);
      if (cl.lowerThird) fx('tique', 3.4, vol * 0.7);
      for (const k of player.cardsT || []) { fx('whoosh', k.T, vol); fx('pop', k.T + 0.18, vol * 0.6); }
    }
  }
  const buf = await ctx.startRendering();
  const skip = Math.round((w0 - t0) * sr);
  return { buf, skip };
}

// Passada rápida (16 kHz mono) só para medir o volume da aula inteira (padrão −14 LUFS).
async function measureLoudness(S, onP, signal) {
  let sum = 0, cnt = 0;
  for (let w0 = 0; w0 < S.total; w0 += WIN * 4) {
    if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
    const w1 = Math.min(S.total, w0 + WIN * 4);
    const { buf, skip } = await renderWindow(S, w0, w1, 16000, 1, 'all');
    const d = buf.getChannelData(0), blk = 6400;
    for (let i = skip; i + blk <= d.length; i += blk) { let q = 0; for (let j = i; j < i + blk; j++) q += d[j] * d[j]; q /= blk; if (q > 1e-5) { sum += q; cnt++; } }
    onP?.(w1 / S.total);
  }
  return cnt ? Math.sqrt(sum / cnt) : 0;
}

// Gera os blocos finais (48 kHz estéreo), já com limpeza de voz, volume padrão e limitador de pico.
async function* audioBlocks(player, srcs, total, onP, signal) {
  const cl = player.client;
  const music = cl.music && cl.music !== 'nenhuma' ? await buildMusic(cl.music) : null;
  const S = { player, srcs, plan: planVoice(player, cl), total, cl, music };
  const vp = voicePreset(cl);
  let gain = 1;
  if (cl.loudnorm !== false) {
    const rms = await measureLoudness(S, (f) => onP?.(f * 0.5), signal);
    gain = rms ? Math.min(4, 0.13 / rms) : 1; // medido: ≈ −14 LUFS na fala
  }
  const SR = 48000, knee = 0.7, room = 0.89 - knee;
  for (let w0 = 0; w0 < total; w0 += WIN) {
    if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
    const w1 = Math.min(total, w0 + WIN);
    const V = await renderWindow(S, w0, w1, SR, 1, 'voice');
    let voice = V.buf.getChannelData(0);
    if (vp.clean && (vp.denoise > 0 || vp.deess > 0)) voice = cleanVoice(voice, SR, { strength: vp.denoise, deess: vp.deess });
    const B = (music || cl.sfx) ? await renderWindow(S, w0, w1, SR, 2, 'bed') : null;
    const n = Math.round((w1 - w0) * SR);
    const out = new AudioBuffer({ numberOfChannels: 2, length: Math.max(1, n), sampleRate: SR });
    for (let c = 0; c < 2; c++) {
      const o = out.getChannelData(c), bed = B ? B.buf.getChannelData(c) : null;
      for (let i = 0; i < n; i++) {
        const y = ((voice[V.skip + i] || 0) + (bed ? bed[B.skip + i] || 0 : 0)) * gain, a = Math.abs(y);
        o[i] = a <= knee ? y : Math.sign(y) * (knee + room * Math.tanh((a - knee) / room));
      }
    }
    yield { buf: out, end: w1 };
  }
}

// Nivela o volume entre takes: cada clipe vai para perto da mediana de fala (no máximo ±6 dB).
function takeGains(clips, cl) {
  const lv = clips.map((c) => {
    const env = envs.get(c.srcId);
    if (!env) return null;
    let s = 0, n = 0;
    for (let k = Math.floor(c.in * 100); k < Math.min(env.length, Math.ceil(c.out * 100)); k++) if (env[k] > 0.01) { s += env[k] * env[k]; n++; }
    return n > 20 ? Math.sqrt(s / n) : null;
  });
  if (cl.levelTakes === false) return clips.map(() => 1);
  const ok = lv.filter((x) => x).sort((x, y) => x - y);
  if (ok.length < 2) return clips.map(() => 1);
  const med = ok[Math.floor(ok.length / 2)];
  return lv.map((x) => (x ? Math.max(0.5, Math.min(2, med / x)) : 1));
}

// ================= Exportação =================
// Arquivo de saída: direto no disco (pasta privada do navegador) quando possível — aulas de 1 h em 4K passam
// de 20 GB e não cabem na memória. Sem essa pasta, monta na memória (aulas curtas).
async function makeTarget(name) {
  const h = await opfsFile(name, true);
  if (h?.createWritable) {
    try {
      const w = await h.createWritable();
      return { target: new StreamTarget(w), fast: false, done: async () => { const f = await h.getFile(); f._opfs = name; return f; } };
    } catch (e) { console.warn('pasta privada indisponível, exportando na memória', e); }
  }
  const t = new BufferTarget();
  return { target: t, fast: 'in-memory', done: async () => new Blob([t.buffer], { type: 'video/mp4' }) };
}

export async function renderOffline(player, preset, codecs, { onProgress, signal, name = 'exportacao.mp4' } = {}) {
  player.stop();
  const total = player.duration;
  const W = preset.w, H = preset.h, fps = preset.fps;
  const srcs = await openSources(player.lesson);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const preview = player.canvas.getContext('2d');
  const t0 = performance.now();
  const eta = (f) => { const el = (performance.now() - t0) / 1000; if (f < 0.03 || el < 8) return ''; const left = el / f - el; return left > 90 ? ` · faltam ~${left > 5400 ? Math.round(left / 3600) + ' h' : Math.round(left / 60) + ' min'}` : ' · quase lá'; };

  // áudio primeiro mede o volume (rápido), depois vem em blocos junto com a imagem
  const blocks = audioBlocks(player, srcs, total, (f) => onProgress?.(f * 0.06, 'Medindo o volume da aula…'), signal);
  let first = await blocks.next();
  await opfsRemove(name);
  const T = await makeTarget(name);
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: T.fast }), target: T.target });
  const vSrc = new CanvasSource(canvas, { codec: codecs.video, bitrate: preset.vbr, keyFrameInterval: 2, latencyMode: 'quality' });
  output.addVideoTrack(vSrc, { frameRate: fps });
  const aSrc = new AudioBufferSource({ codec: codecs.audio, bitrate: 256_000 });
  output.addAudioTrack(aSrc);
  await output.start();

  let audioEnd = 0;
  const feedAudio = async (upto) => {
    while (!first.done && audioEnd < upto) {
      await aSrc.add(first.value.buf);
      audioEnd = first.value.end;
      first = await blocks.next();
    }
  };

  const step = 1 / fps;
  const nFrames = Math.max(1, Math.round(total * fps));
  const clips = player.lesson.clips;
  let n = 0;
  try {
    await feedAudio(1);
    for (let i = 0; i < clips.length && n < nFrames; i++) {
      const c = clips[i], start = player.starts[i], end = start + (c.out - c.in);
      const vt = srcs.get(c.srcId)?.video;
      const it = vt ? new VideoSampleSink(vt).samples(c.in, c.out) : null;
      let cur = null, next = it ? (await it.next()).value ?? null : null;
      while (n < nFrames && n * step < end - 1e-6) {
        if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
        const Tt = n * step, srcT = c.in + (Tt - start);
        while (next && next.timestamp <= srcT + 1e-4) {
          cur?.close(); cur = next;
          next = (await it.next()).value ?? null;
        }
        const show = cur || next;
        player.T = Tt;
        player.frame = show ? { img: show.toCanvasImageSource(), w: show.displayWidth, h: show.displayHeight } : null;
        player.draw(canvas);
        await vSrc.add(Tt, step);
        n++;
        if (n % fps === 0) await feedAudio(Tt + 2);
        if (n % 15 === 0) {
          const f = 0.06 + 0.92 * (n / nFrames);
          onProgress?.(f, `Gerando o vídeo… ${Math.floor(Tt / 60)}:${String(Math.floor(Tt % 60)).padStart(2, '0')} de ${Math.floor(total / 60)}:${String(Math.floor(total % 60)).padStart(2, '0')}${eta(n / nFrames)}`);
          preview.drawImage(canvas, 0, 0, player.canvas.width, player.canvas.height);
        }
      }
      cur?.close(); next?.close();
      await it?.return?.();
    }
    await feedAudio(Infinity);
    onProgress?.(0.99, 'Finalizando o arquivo…');
    await output.finalize();
  } catch (e) {
    await output.cancel?.().catch(() => {});
    await opfsRemove(name);
    throw e;
  } finally {
    player.frame = null;
    for (const s of srcs.values()) s.input.dispose?.();
  }
  return await T.done();
}

// Um quadro nítido do vídeo original (para a capa da aula). Decodifica direto do arquivo: funciona também no iPhone.
export async function grabFrame(lesson, srcId, t) {
  const src = lesson.sources.find((s) => s.id === srcId);
  const blob = src && await db.getBlob(src.mediaId);
  if (!blob) return null;
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;
    const sample = await new VideoSampleSink(track).getSample(Math.max(0, t));
    if (!sample) return null;
    const c = document.createElement('canvas');
    c.width = sample.displayWidth; c.height = sample.displayHeight;
    c.getContext('2d').drawImage(sample.toCanvasImageSource(), 0, 0, c.width, c.height);
    sample.close();
    return c;
  } finally { input.dispose?.(); }
}
