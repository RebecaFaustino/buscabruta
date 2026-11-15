// Legendas: palavras com tempo (no tempo do vídeo de origem), agrupadas em frases.
import { MED_TERMS } from './presets.js';

export const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w\s-]/g, '').trim();

export function phrases(words, maxWords = 6, maxChars = 34) {
  const out = [];
  let cur = [];
  const flush = () => { if (cur.length) out.push({ s: cur[0].s, e: cur[cur.length - 1].e, words: cur }); cur = []; };
  for (let i = 0; i < words.length; i++) {
    const w = words[i], prev = words[i - 1];
    if (cur.length && (w.s - prev.e > 0.6)) flush();
    cur.push(w);
    const chars = cur.map((x) => x.w).join(' ').length;
    if (cur.length >= maxWords || chars >= maxChars || /[.!?;:]$/.test(w.w)) flush();
  }
  flush();
  return out;
}

// Converte o tempo de origem para o tempo da linha do tempo editada (ou null se foi cortado).
export function srcToTimeline(clips, srcId, t) {
  let acc = 0;
  for (const c of clips) {
    if (c.srcId === srcId && t >= c.in && t < c.out) return acc + (t - c.in);
    acc += c.out - c.in;
  }
  return null;
}

// Legendas finais no tempo editado: [{s,e,text,words:[{w,s,e}]}]
export function timelineCaptions(lesson) {
  const out = [];
  let acc = 0;
  for (const c of lesson.clips) {
    const ws = (lesson.words[c.srcId] || []).filter((w) => w.e > c.in && w.s < c.out)
      .map((w) => ({ ...w, s: acc + Math.max(w.s, c.in) - c.in, e: acc + Math.min(w.e, c.out) - c.in }));
    for (const p of phrases(ws)) out.push({ s: p.s, e: p.e, text: p.words.map((w) => w.w).join(' '), words: p.words });
    acc += c.out - c.in;
  }
  return out;
}

const pad = (n, l = 2) => String(n).padStart(l, '0');
const ts = (t) => { const ms = Math.round(t * 1000); return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`; };
export const srt = (caps) => caps.map((c, i) => `${i + 1}\n${ts(c.s)} --> ${ts(c.e)}\n${c.text}\n`).join('\n');
export const vtt = (caps) => 'WEBVTT\n\n' + caps.map((c) => `${ts(c.s).replace(',', '.')} --> ${ts(c.e).replace(',', '.')}\n${c.text}\n`).join('\n');

// Importa SRT/VTT e distribui as palavras proporcionalmente dentro de cada bloco.
export function parseSubs(text) {
  const words = [];
  const re = /(\d{1,2}:)?(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}:)?(\d{2}):(\d{2})[,.](\d{3})[^\n]*\n([\s\S]*?)(?=\n\s*\n|$)/g;
  const toS = (h, m, s, ms) => (parseInt(h || '0') * 3600) + parseInt(m) * 60 + parseInt(s) + parseInt(ms) / 1000;
  let m;
  while ((m = re.exec(text.replace(/\r/g, '')))) {
    const s = toS(m[1], m[2], m[3], m[4]), e = toS(m[5], m[6], m[7], m[8]);
    words.push(...spread(m[9].replace(/<[^>]+>/g, '').trim(), s, e));
  }
  return words;
}

export function spread(text, s, e) {
  const toks = text.split(/\s+/).filter(Boolean);
  const total = toks.reduce((a, t) => a + t.length + 1, 0) || 1;
  let t = s;
  return toks.map((w) => { const d = (e - s) * (w.length + 1) / total; const o = { w, s: t, e: t + d }; t += d; return o; });
}

export function isKeyword(word, client) {
  const n = norm(word);
  if (!n) return false;
  return (client.keywords || []).some((k) => {
    const nk = norm(k);
    return nk && (n === nk || (nk.length > 4 && n.startsWith(nk.slice(0, -1))));
  });
}

// Sugere palavras-chave: termos médicos + palavras longas mais frequentes.
export function suggestKeywords(lesson, client, limit = 12) {
  const freq = new Map();
  const stop = new Set('para como mais porque quando muito entao isso essa esse esses essas voce voces sobre entre depois antes ainda tambem coisa coisas gente fazer feito pode podem poder estar estou estamos sendo tenho temos tinha aqui agora sempre nunca outro outra outros outras mesmo mesma tudo todos todas cada qual quais onde vamos vai vou falar falando dizer disse hoje olha entao realmente exemplo assim ficar fica deixa deixar coisa porque mudam muda afeta controla controlar idade tempo muito pouco grande maior menor'.split(' '));
  const med = new Set(MED_TERMS.map(norm));
  for (const ws of Object.values(lesson.words)) for (const w of ws) {
    const n = norm(w.w);
    if (stop.has(n) || (n.length < 7 && !med.has(n))) continue;
    freq.set(n, (freq.get(n) || 0) + (med.has(n) ? 4 : 1));
  }
  const have = new Set((client.keywords || []).map(norm));
  return [...freq.entries()].filter(([k]) => !have.has(k)).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k]) => k);
}

// Gera cartões de destaque automaticamente quando a palavra-chave é falada.
export function autoCards(lesson, client, dur = 2.8) {
  const cards = [];
  for (const [srcId, ws] of Object.entries(lesson.words)) {
    let lastT = -99;
    for (const w of ws) {
      if (isKeyword(w.w, client) && w.s - lastT > dur + 1.5) {
        cards.push({ id: 'card_' + Math.random().toString(36).slice(2, 9), srcId, t: w.s, dur, text: w.w.replace(/[^\p{L}\p{N}\s-]/gu, ''), sub: '' });
        lastT = w.s;
      }
    }
  }
  return cards;
}
