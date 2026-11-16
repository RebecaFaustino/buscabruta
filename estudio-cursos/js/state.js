import { db } from './db.js';
import { cloudPush } from './cloud.js';

export const uid = (p = 'id') => p + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const state = { clients: [], courses: [], media: {}, updatedAt: 0 };

let saveTimer, cloudTimer;
// Salva neste aparelho na hora e na nuvem ~2 s depois da última mudança.
export function save({ touch = true } = {}) {
  if (touch) state.updatedAt = Date.now();
  clearTimeout(saveTimer);
  if (!state.storageError) saveTimer = setTimeout(() => db.set('state', JSON.parse(JSON.stringify(state))).catch((e) => console.warn('Não foi possível salvar', e)), 250);
  if (touch) { clearTimeout(cloudTimer); cloudTimer = setTimeout(() => cloudPush(state), 2000); }
}

export async function load() {
  let s = null;
  try { s = await db.get('state'); } catch (e) { console.warn(e); state.storageError = true; }
  if (s) Object.assign(state, s);
  state.media = state.media || {};
  for (const c of state.clients) {
    if (c.sfx === undefined) c.sfx = true;
    if (c.sfxVol === undefined) c.sfxVol = 0.5;
    if (!c.template) { c.template = 'clinico'; c.look = 'auto'; c.captionStyle = 'auto'; }
  }
  if (!state.clients.length) seed();
}

function seed() {
  const c = newClient({
    name: 'Dra. Exemplo Silva', specialty: 'Endocrinologia', crm: 'CRM-SP 000000',
    keywords: ['metabolismo', 'insulina', 'hormônios', 'longevidade'],
  });
  const course = newCourse(c.id, 'Metabolismo Descomplicado');
  state.clients.push(c);
  state.courses.push(course);
  save({ touch: false }); // exemplo: não sobrescreve a nuvem
}

export function newClient(over = {}) {
  return {
    id: uid('cli'), name: 'Novo cliente', specialty: '', crm: '',
    primary: '#0f3d3e', accent: '#2bb3a3', text: '#ffffff',
    font: 'Inter', logoMediaId: null,
    expertSide: 'left', // expert à esquerda -> palavras-chave à direita
    keywords: [], template: 'clinico', captionStyle: 'auto', captionPos: 'bottom', look: 'auto', cardVariant: 'auto', shadow: 0.6, captionScale: 1,
    platform: 'hotmart', lowerThird: true, watermark: true, openingTitle: true,
    cleanVoice: true, sfx: true, sfxVol: 0.5, silenceDb: -38, minSilence: 0.45, padding: 0.08, autoZoom: true,
    ...over,
  };
}

export function newLesson(title = 'Nova aula') {
  return { id: uid('aula'), title, description: '', sources: [], clips: [], words: {}, cards: [], render: null };
}

export function newModule(title = 'Novo módulo') {
  return { id: uid('mod'), title, lessons: [newLesson('Aula 1')] };
}

export function newCourse(clientId, title = 'Novo curso') {
  return { id: uid('cur'), clientId, title, description: '', modules: [newModule('Módulo 1 — Introdução')] };
}

export const getClient = (id) => state.clients.find((c) => c.id === id);
export const getCourse = (id) => state.courses.find((c) => c.id === id);
export function findLesson(course, lessonId) {
  for (const m of course.modules) for (const l of m.lessons) if (l.id === lessonId) return { module: m, lesson: l };
  return {};
}

// Resumo do perfil vindo do Estúdio de Marketing (Notion), para orientar a IA em legendas, descrições, Reels e chat.
export function briefOf(c) {
  const m = c?.mkt;
  if (!m) return '';
  const l = [];
  if (m.tom) l.push(`Tom de voz: ${m.tom}`);
  if (m.publico) l.push(`Público: ${m.publico}`);
  if (m.proibidas) l.push(`Nunca use estes termos: ${m.proibidas}`);
  if (m.notas) l.push(`Particularidades do cliente: ${m.notas}`);
  return l.length ? `\nPerfil do cliente (Estúdio de Marketing):\n- ${l.join('\n- ')}\n` : '';
}
