// Transcrição local com Whisper (base, q8) via Transformers.js.
// Modelo e runtime são servidos junto do app (em partes de 12 MB) e montados aqui — nada vai para servidores.
import { pipeline, env } from '../vendor/transformers.min.js';

const MODEL = 'Xenova/whisper-base';
const MODEL_BASE = new URL('../models/Xenova/whisper-base/', import.meta.url).href;
const ORT_BASE = new URL('../vendor/ort/', import.meta.url).href;
const PARTS = {
  'onnx/encoder_model_quantized.onnx': 2,
  'onnx/decoder_model_merged_quantized.onnx': 5,
};
const WASM = 'ort-wasm-simd-threaded.jsep.wasm';
const WASM_PARTS = 2;
const TOTAL_BYTES = 99_000_000; // aproximado, para a barra de progresso

let loaded = 0;
const progress = (n) => { loaded += n; self.postMessage({ type: 'load', progress: Math.min(99, (loaded / TOTAL_BYTES) * 100) }); };

let store = null;
async function cacheStore() {
  if (store !== null) return store;
  try { store = await caches.open('estudio-cursos-modelos-v1'); } catch { store = false; }
  return store;
}

async function getBytes(url, parts) {
  const c = await cacheStore();
  if (c) {
    const hit = await c.match(url);
    if (hit) { const b = await hit.arrayBuffer(); progress(b.byteLength); return b; }
  }
  const bufs = [];
  for (let i = 0; i < parts; i++) {
    const r = await fetch(parts > 1 ? `${url}.part${i}.wasm` : url);
    if (!r.ok) throw new Error(`Arquivo do modelo indisponível (${r.status}): ${url}`);
    const b = await r.arrayBuffer();
    progress(b.byteLength);
    bufs.push(b);
  }
  const blob = new Blob(bufs);
  if (c && parts > 1) { try { await c.put(url, new Response(blob)); } catch {} }
  return blob.arrayBuffer();
}

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.remoteHost = 'https://modelos.local/';
env.useBrowserCache = false;
env.useCustomCache = true;
env.customCache = {
  async match(key) {
    const k = String(key?.url || key);
    const name = k.split(MODEL + '/')[1]?.replace(/^resolve\/main\//, '');
    if (!name) return undefined;
    if (!PARTS[name]) {
      const r = await fetch(MODEL_BASE + name);
      if (!r.ok) return undefined; // arquivo opcional que este modelo não tem
      const b = await r.arrayBuffer();
      progress(b.byteLength);
      return new Response(b, { headers: { 'content-length': String(b.byteLength) } });
    }
    const buf = await getBytes(MODEL_BASE + name, PARTS[name]);
    return new Response(buf, { headers: { 'content-length': String(buf.byteLength) } });
  },
  async put() {},
};
env.backends.onnx.wasm.wasmPaths = ORT_BASE;
env.backends.onnx.wasm.numThreads = 1;

let asr = null;
async function load() {
  if (asr) return asr;
  env.backends.onnx.wasm.wasmBinary = await getBytes(ORT_BASE + WASM, WASM_PARTS);
  asr = await pipeline('automatic-speech-recognition', MODEL, { dtype: 'q8', device: 'wasm' });
  return asr;
}

self.onmessage = async (e) => {
  const { pcm, opts = {} } = e.data;
  try {
    const t = await load();
    self.postMessage({ type: 'status', text: 'Transcrevendo a fala…' });
    const out = await t(pcm, {
      language: 'portuguese', task: 'transcribe',
      chunk_length_s: 30, stride_length_s: 5, return_timestamps: true,
      no_repeat_ngram_size: 4, ...opts,
    });
    self.postMessage({ type: 'done', chunks: out.chunks || [], text: out.text });
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
