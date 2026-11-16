// Exportação quadro a quadro (WebCodecs): cada quadro é decodificado, composto e codificado no tempo exato.
// Não perde quadros (60 fps de verdade, 4K), não depende da tela ficar visível e costuma ser mais rápida que o tempo real.
import {
  Input, ALL_FORMATS, BlobSource, VideoSampleSink, AudioBufferSink,
  Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource,
  canEncodeAudio, getFirstEncodableVideoCodec,
} from '../vendor/mediabunny.min.mjs';
import { db } from './db.js';
import { voiceChain } from './player.js';
import { SFX } from './sfx.js';
import { buildMusic, scheduleMusic } from './music.js';

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
    if (!blob) throw new Error(`O vídeo “${s.name}” não está neste aparelho. Importe de novo.`);
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    m.set(s.id, { input, video: await input.getPrimaryVideoTrack(), audio: await input.getPrimaryAudioTrack() });
  }
  return m;
}

// Mixa a aula editada (voz tratada + micro-fades nos cortes + efeitos sonoros) num AudioBuffer.
async function renderAudio(player, srcs, total, onProgress, signal) {
  const SR = 48000;
  const len = Math.max(1, Math.ceil(total * SR));
  const ctx = new OfflineAudioContext(2, len, SR);
  const master = ctx.createGain();
  master.connect(ctx.destination);
  const cl = player.client;
  const into = cl.cleanVoice ? voiceChain(ctx, master) : master;
  const clips = player.lesson.clips;
  for (let i = 0; i < clips.length; i++) {
    if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
    const c = clips[i], at = player.starts[i], d = c.out - c.in;
    const tr = srcs.get(c.srcId)?.audio;
    if (!tr || !(await tr.canDecode())) continue;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(1, at + 0.012);
    g.gain.setValueAtTime(1, Math.max(at + 0.012, at + d - 0.015));
    g.gain.linearRampToValueAtTime(0, at + d);
    g.connect(into);
    for await (const { buffer, timestamp } of new AudioBufferSink(tr).buffers(c.in, c.out)) {
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(g);
      const off = Math.max(0, c.in - timestamp);
      const when = at + Math.max(0, timestamp - c.in);
      const dur = Math.min(buffer.duration - off, at + d - when);
      if (dur > 0) node.start(when, off, dur);
    }
    onProgress?.(i / clips.length);
  }
  if (cl.music && cl.music !== 'nenhuma') {
    const buf = await buildMusic(cl.music);
    if (buf) scheduleMusic(ctx, ctx.destination, buf, { T: 0, total, vol: cl.musicVol ?? 0.35, when: 0 });
  }
  if (cl.sfx) {
    const vol = cl.sfxVol ?? 0.5;
    const fx = (name, t, v) => {
      if (t >= total) return;
      const n = ctx.createBufferSource(); n.buffer = SFX[name].build(ctx);
      const g = ctx.createGain(); g.gain.value = v;
      n.connect(g).connect(ctx.destination); n.start(Math.max(0, t));
    };
    if (cl.openingTitle) fx('sino', 0.05, vol * 0.8);
    if (cl.lowerThird) fx('tique', 3.4, vol * 0.7);
    for (const k of player.cardsT || []) { fx('whoosh', k.T, vol); fx('pop', k.T + 0.18, vol * 0.6); }
  }
  return ctx.startRendering();
}

export async function renderOffline(player, preset, codecs, { onProgress, signal } = {}) {
  player.stop();
  const total = player.duration;
  const W = preset.w, H = preset.h, fps = preset.fps;
  const srcs = await openSources(player.lesson);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const preview = player.canvas.getContext('2d');

  const audio = await renderAudio(player, srcs, total, (f) => onProgress?.(f * 0.1, 'Mixando o áudio…'), signal);

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const vSrc = new CanvasSource(canvas, { codec: codecs.video, bitrate: preset.vbr, keyFrameInterval: 2 });
  output.addVideoTrack(vSrc, { frameRate: fps });
  const aSrc = new AudioBufferSource({ codec: codecs.audio, bitrate: 192_000 });
  output.addAudioTrack(aSrc);
  await output.start();

  const step = 1 / fps;
  const nFrames = Math.max(1, Math.round(total * fps));
  const clips = player.lesson.clips;
  let n = 0;
  try {
    for (let i = 0; i < clips.length && n < nFrames; i++) {
      const c = clips[i], start = player.starts[i], end = start + (c.out - c.in);
      const vt = srcs.get(c.srcId)?.video;
      const it = vt ? new VideoSampleSink(vt).samples(c.in, c.out) : null;
      let cur = null, next = it ? (await it.next()).value ?? null : null;
      while (n < nFrames && n * step < end - 1e-6) {
        if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
        const T = n * step, srcT = c.in + (T - start);
        while (next && next.timestamp <= srcT + 1e-4) {
          cur?.close(); cur = next;
          next = (await it.next()).value ?? null;
        }
        const show = cur || next;
        player.T = T;
        player.frame = show ? { img: show.toCanvasImageSource(), w: show.displayWidth, h: show.displayHeight } : null;
        player.draw(canvas);
        await vSrc.add(T, step);
        n++;
        if (n % 10 === 0) {
          onProgress?.(0.1 + 0.88 * (n / nFrames), 'Gerando o vídeo…');
          preview.drawImage(canvas, 0, 0, player.canvas.width, player.canvas.height);
        }
      }
      cur?.close(); next?.close();
      await it?.return?.();
    }
    // o AudioBuffer tem exatamente a duração da aula
    await aSrc.add(audio);
    onProgress?.(0.99, 'Finalizando o arquivo…');
    await output.finalize();
  } catch (e) {
    await output.cancel?.().catch(() => {});
    throw e;
  } finally {
    player.frame = null;
    for (const s of srcs.values()) s.input.dispose?.();
  }
  return new Blob([output.target.buffer], { type: codecs.video === 'avc' ? 'video/mp4' : 'video/mp4' });
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
