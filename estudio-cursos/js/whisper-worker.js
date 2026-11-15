// Transcrição local (no navegador) com Whisper via Transformers.js. O áudio nunca sai do computador.
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2';

let asr = null, modelId = null;

self.onmessage = async (e) => {
  const { pcm, model, words } = e.data;
  try {
    if (!asr || modelId !== model) {
      asr = await pipeline('automatic-speech-recognition', model, {
        dtype: 'q8',
        progress_callback: (p) => p.status === 'progress' && self.postMessage({ type: 'load', file: p.file, progress: p.progress }),
      });
      modelId = model;
    }
    self.postMessage({ type: 'status', text: 'Transcrevendo…' });
    const out = await asr(pcm, {
      language: 'portuguese', task: 'transcribe',
      chunk_length_s: 30, stride_length_s: 5,
      return_timestamps: words ? 'word' : true,
    });
    self.postMessage({ type: 'done', chunks: out.chunks || [], text: out.text });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
