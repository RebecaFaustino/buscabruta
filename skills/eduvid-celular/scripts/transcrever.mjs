// Uso: node transcrever.mjs audio16k.f32 saida.json
import { pipeline, env } from '@huggingface/transformers';
import { readFileSync, writeFileSync } from 'node:fs';
env.allowRemoteModels = false;
env.localModelPath = new URL('./models/', `file://${process.cwd()}/`).pathname;
const raw = readFileSync(process.argv[2]);
const pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
const asr = await pipeline('automatic-speech-recognition', 'Xenova/whisper-base', { dtype: 'q8' });
const out = await asr(pcm, { language: 'portuguese', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5, return_timestamps: true, no_repeat_ngram_size: 4 });
writeFileSync(process.argv[3], JSON.stringify(out.chunks.map((c) => ({ s: c.timestamp[0] ?? 0, e: c.timestamp[1], texto: c.text.trim() })), null, 1));
