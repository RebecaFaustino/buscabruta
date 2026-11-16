// Exportação: renderiza a linha do tempo editada em tempo real (canvas + áudio tratado) via MediaRecorder.
export function pickMime() {
  const opts = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return opts.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}


// Escolhe o melhor método: quadro a quadro (WebCodecs) quando o navegador suporta; senão, gravação em tempo real.
export async function renderLesson(player, preset, opts = {}) {
  const { offlineCodecs, renderOffline } = await import('./render-offline.js');
  const codecs = await offlineCodecs(preset);
  if (codecs) {
    try {
      const blob = await renderOffline(player, preset, codecs, { onProgress: (f, msg) => opts.onProgress?.(f, msg), signal: opts.signal });
      await player.seek(0);
      return blob;
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      console.warn('Exportação quadro a quadro falhou, usando gravação em tempo real:', e);
    }
  }
  return renderRealtime(player, preset, opts);
}

async function renderRealtime(player, preset, { onProgress, mute = true, signal } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = preset.w; canvas.height = preset.h;
  const mainCanvas = player.canvas;
  player.stop();
  player.ensureAudio();
  player.canvas = canvas;
  const stream = canvas.captureStream(preset.fps);
  for (const t of player.dest.stream.getAudioTracks()) stream.addTrack(t);
  const mimeType = pickMime();
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: preset.vbr, audioBitsPerSecond: 192_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((r) => (rec.onstop = r));
  if (mute) player.speaker.gain.value = 0;
  const prevTime = player.onTime, prevGap = player.onGap;
  player.onTime = (T) => { onProgress?.(T / player.duration); const ctx = mainCanvas.getContext('2d'); ctx.drawImage(canvas, 0, 0, mainCanvas.width, mainCanvas.height); };
  player.onGap = (gap) => { if (rec.state === 'inactive') return; gap ? rec.state === 'recording' && rec.pause() : rec.state === 'paused' && rec.resume(); };
  const abort = () => player.stop();
  signal?.addEventListener('abort', abort);
  try {
    player.T = 0;
    await player.seek(0);
    rec.start(1000);
    rec.pause();
    await player.play();
    if (rec.state !== 'inactive') rec.stop();
    await done;
  } finally {
    signal?.removeEventListener('abort', abort);
    player.speaker.gain.value = 1;
    player.canvas = mainCanvas;
    player.onTime = prevTime; player.onGap = prevGap;
    for (const t of stream.getVideoTracks()) t.stop();
  }
  if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
  const type = (mimeType || 'video/webm').split(';')[0];
  return new Blob(chunks, { type });
}

export const extOf = (blob) => (blob.type.includes('mp4') ? 'mp4' : 'webm');
