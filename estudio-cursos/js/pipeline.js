// Edição automática: importar → cortes secos → zoom → legenda → revisão por IA → destaques.
import { db } from './db.js';
import { uid, save , briefOf } from './state.js';
import { analyze, speechRanges, decodePCM16k } from './audio.js';
import { phrases, spread, suggestKeywords, autoCards } from './captions.js';

export const envs = new Map(); // srcId -> envelope de áudio

export function videoDuration(file) {
  return new Promise((r) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.playsInline = true;
    const url = URL.createObjectURL(file);
    const done = (d) => { URL.revokeObjectURL(url); r(d); };
    v.onloadedmetadata = () => {
      if (isFinite(v.duration)) return done(v.duration);
      // alguns arquivos (gravações do navegador) só revelam a duração após um salto
      v.currentTime = 1e7;
      v.ontimeupdate = () => { v.ontimeupdate = null; done(v.duration); };
    };
    v.onerror = () => done(0);
    v.src = url;
  });
}

export const isMedia = (f) => /^(video|audio)\//.test(f.type) || /\.(mp4|mov|m4v|webm|mkv|mp3|wav|m4a)$/i.test(f.name);

export async function importVideo(lesson, file) {
  const duration = await videoDuration(file);
  if (!duration || !isFinite(duration)) throw new Error(`Não foi possível ler “${file.name}”. Use um vídeo MP4 ou MOV.`);
  const mediaId = uid('vid');
  db.keep(mediaId, file); // grava em segundo plano
  const src = { id: uid('src'), mediaId, name: file.name, duration, size: file.size, mtime: file.lastModified || 0 };
  lesson.sources.push(src);
  lesson.clips.push({ id: uid('clip'), srcId: src.id, in: 0, out: duration, zoom: 1 });
  save();
  return src;
}

export async function getEnv(src, blob) {
  if (envs.has(src.id)) return envs.get(src.id);
  let env = await db.getMedia('env:' + src.id).catch(() => null);
  if (!env) {
    try {
      blob = blob || await db.getBlob(src.mediaId);
      env = (await analyze(blob)).env;
      await db.putMedia('env:' + src.id, env).catch(() => {});
    } catch (err) { console.warn(err); return null; }
  }
  envs.set(src.id, env);
  return env;
}

// Cortes secos: mantém só os trechos com fala. Retorna os segundos removidos.
export async function autoCutLesson(lesson, client) {
  const before = lesson.clips.reduce((a, c) => a + c.out - c.in, 0);
  const clips = [];
  for (const s of lesson.sources) {
    const env = await getEnv(s);
    if (!env) { clips.push({ id: uid('clip'), srcId: s.id, in: 0, out: s.duration, zoom: 1 }); continue; }
    for (const r of speechRanges(env, client)) clips.push({ id: uid('clip'), srcId: s.id, in: r.in, out: Math.min(r.out, s.duration), zoom: 1 });
  }
  if (!clips.length) throw new Error('Não encontrei fala neste vídeo. Confira se o áudio está gravado.');
  if (client.autoZoom) clips.forEach((c, i) => (c.zoom = i % 2 ? 1.15 : 1));
  lesson.clips = clips;
  save();
  return before - clips.reduce((a, c) => a + c.out - c.in, 0);
}

// ---------- Transcrição (Whisper no próprio aparelho) ----------
let worker;
function whisper(pcm, onMsg) {
  worker = worker || new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
  return new Promise((res, rej) => {
    worker.onmessage = (e) => {
      const m = e.data;
      onMsg?.(m);
      if (m.type === 'done') res(m);
      if (m.type === 'error') rej(new Error(m.message));
    };
    worker.onerror = (e) => rej(new Error(e.message || 'Falha ao iniciar a transcrição'));
    worker.postMessage({ pcm }, [pcm.buffer]);
  });
}

// Remove repetições típicas de alucinação ("o que você quer dizer é que o que você quer dizer…").
function cleanText(t) {
  let s = t.replace(/\s+/g, ' ').trim();
  for (let n = 6; n >= 2; n--) {
    const re = new RegExp(`((?:\\S+\\s+){${n - 1}}\\S+)(?:\\s+\\1){2,}`, 'gi');
    s = s.replace(re, '$1');
  }
  return s;
}

export async function transcribeLesson(lesson, onStatus) {
  for (const s of lesson.sources) {
    onStatus?.({ text: 'Lendo o áudio…' });
    const blob = await db.getBlob(s.mediaId);
    const pcm = await decodePCM16k(blob, (f) => onStatus?.({ text: `Lendo o áudio… ${Math.round(f * 100)}%`, progress: f * 0.1 }));
    const total = pcm.length / 16000;
    const out = await whisper(pcm, (m) => {
      if (m.type === 'load') onStatus?.({ text: `Preparando o transcritor… ${Math.round(m.progress || 0)}%`, progress: (m.progress || 0) / 100 });
      if (m.type === 'status') onStatus?.({ text: `${m.text} (pode levar alguns minutos)`, busy: true });
    });
    const env = await getEnv(s, blob);
    const speech = env ? speechRanges(env, { silenceDb: -45, minSilence: 0.8, padding: 0.2 }) : null;
    const words = [];
    for (const ch of out.chunks) {
      const a = ch.timestamp?.[0] ?? 0;
      const b = ch.timestamp?.[1] ?? Math.min(total, a + 4);
      const txt = cleanText(ch.text || '');
      if (!txt || /^\[.*\]$|^\(.*\)$/.test(txt)) continue;
      // descarta frases "inventadas" em trechos sem fala
      if (speech && !speech.some((r) => r.out > a && r.in < b)) continue;
      words.push(...spread(txt, a, Math.max(b, a + 0.3)));
    }
    lesson.words[s.id] = words;
  }
  save();
}

// ---------- Revisão de termos médicos com IA (quando disponível) ----------
export async function aiReviewLesson(lesson, client, smp, onStatus) {
  const items = [];
  for (const s of lesson.sources) phrases(lesson.words[s.id] || []).forEach((p) => items.push({ s, p, text: p.words.map((w) => w.w).join(' ') }));
  let changed = 0;
  for (let i = 0; i < items.length; i += 60) {
    onStatus?.({ text: `Revisando termos médicos ${Math.min(i + 60, items.length)}/${items.length}…`, progress: i / items.length });
    const batch = items.slice(i, i + 60);
    const out = await smp.json(`Você revisa legendas geradas automaticamente de uma aula em português do Brasil de ${client.name} (${client.specialty || 'medicina'}).
Corrija palavras mal reconhecidas pelo contexto, a grafia de termos médicos, nomes de medicamentos, siglas, acentuação e pontuação.
Não resuma, não acrescente informação e não mude o sentido. Mantenha cada frase no mesmo índice.
Palavras-chave do expert: ${client.keywords.join(', ') || 'nenhuma'}.${briefOf(client)}
Responda somente com um array JSON de ${batch.length} strings, na mesma ordem:
${JSON.stringify(batch.map((b) => b.text))}`, { modelTier: 'quick' });
    if (!Array.isArray(out) || out.length !== batch.length) continue;
    for (let j = batch.length - 1; j >= 0; j--) {
      const { s, p, text } = batch[j];
      const nt = String(out[j] || '').trim();
      if (!nt || nt === text) continue;
      const all = lesson.words[s.id], start = all.indexOf(p.words[0]);
      if (start < 0) continue;
      all.splice(start, p.words.length, ...spread(nt, p.s, p.e));
      changed++;
    }
  }
  save();
  return changed;
}

// Garante palavras-chave (sugere a partir da aula se o perfil não tiver) e cria os cartões.
export function keywordsAndCards(lesson, client) {
  if (!client.keywords.length) client.keywords.push(...suggestKeywords(lesson, client, 5));
  const manual = lesson.cards.filter((k) => k.manual);
  lesson.cards = [...manual, ...autoCards(lesson, client)];
  save();
  return lesson.cards.length;
}

// ---------- Edição pelo texto ----------
// Corta o trecho [a, b] (tempo da gravação) de todos os clipes dessa gravação. Retorna os segundos removidos.
export function cutSourceRange(lesson, srcId, a, b) {
  const out = [];
  let removed = 0;
  for (const c of lesson.clips) {
    if (c.srcId !== srcId || b <= c.in || a >= c.out) { out.push(c); continue; }
    removed += Math.min(b, c.out) - Math.max(a, c.in);
    if (a - c.in >= 0.08) out.push({ ...c, out: a });
    if (c.out - b >= 0.08) out.push({ ...c, id: uid('clip'), in: b });
  }
  lesson.clips = out;
  return removed;
}

const normW = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
const inTimeline = (lesson, srcId, p) => lesson.clips.some((c) => c.srcId === srcId && c.out > p.s + 0.05 && c.in < p.e - 0.05);

// Repetições de gravação ("regravou a frase"): uma frase seguida logo depois por outra que começa igual
// ou diz quase o mesmo. A primeira tentativa sai; fica a última.
export function findRetakes(lesson) {
  const found = [];
  for (const s of lesson.sources) {
    const ps = phrasesBySentence(lesson.words[s.id] || []).filter((p) => inTimeline(lesson, s.id, p));
    for (let i = 0; i < ps.length - 1; i++) {
      const A = normW(ps[i].text);
      if (A.length < 3) continue;
      for (const j of [i + 1, i + 2]) {
        const B = ps[j] && normW(ps[j].text);
        if (!B || B.length < 3 || ps[j].s - ps[i].e > 12) continue;
        const sameStart = A.slice(0, 3).join(' ') === B.slice(0, 3).join(' ');
        const setA = new Set(A), setB = new Set(B);
        const inter = [...setA].filter((w) => setB.has(w)).length;
        const sim = inter / Math.min(setA.size, setB.size);
        if ((sameStart && sim >= 0.5) || sim >= 0.8) { found.push({ srcId: s.id, s: ps[i].s, e: ps[j].s, text: ps.slice(i, j).map((p) => p.text).join(' ') }); i = j - 1; break; }
      }
    }
  }
  // Também pega a regravação emendada sem pausa: as mesmas 4 palavras de novo pouco depois
  // ("a insulina é um hormônio que… a insulina é um hormônio que controla…").
  for (const s of lesson.sources) {
    const ws = (lesson.words[s.id] || []).filter((w) => lesson.clips.some((c) => c.srcId === s.id && c.out > w.s && c.in < w.e));
    const tok = ws.map((w) => normW(w.w).join(''));
    for (let i = 0; i + 4 <= tok.length; i++) {
      const g = tok.slice(i, i + 4);
      if (!g.every(Boolean) || !g.some((t) => t.length > 3)) continue;
      for (let j = i + 4; j <= Math.min(i + 30, tok.length - 4); j++) {
        if (tok.slice(j, j + 4).join(' ') !== g.join(' ')) continue;
        const a = ws[i].s, b = ws[j].s;
        if (b - a > 15 || found.some((f) => f.srcId === s.id && a < f.e && b > f.s)) break;
        found.push({ srcId: s.id, s: a, e: b, text: ws.slice(i, j).map((w) => w.w).join(' ') });
        i = j - 1; break;
      }
    }
  }
  return found;
}

// Frases por pontuação/pausa (maiores que as linhas de legenda), para comparar tentativas.
function phrasesBySentence(words) {
  const out = [];
  let cur = [];
  const flush = () => { if (cur.length) out.push({ s: cur[0].s, e: cur[cur.length - 1].e, text: cur.map((w) => w.w).join(' ') }); cur = []; };
  for (let i = 0; i < words.length; i++) {
    const w = words[i], prev = words[i - 1];
    if (cur.length && w.s - prev.e > 0.7) flush();
    cur.push(w);
    if (/[.!?]$/.test(w.w) || cur.length >= 30) flush();
  }
  flush();
  return out;
}

export function removeRetakes(lesson) {
  const list = findRetakes(lesson);
  let secs = 0;
  for (const r of list) secs += cutSourceRange(lesson, r.srcId, r.s, r.e);
  return { n: list.length, secs };
}
