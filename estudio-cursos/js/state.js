import { db } from './db.js';

export const uid = (p = 'id') => p + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const state = { clients: [], courses: [] };

let saveTimer;
export function save() {
  if (state.storageError) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => db.set('state', JSON.parse(JSON.stringify(state))).catch((e) => console.warn('Não foi possível salvar', e)), 250);
}

export async function load() {
  let s = null;
  try { s = await db.get('state'); } catch (e) { console.warn(e); state.storageError = true; }
  if (s) Object.assign(state, s);
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
  save();
}

export function newClient(over = {}) {
  return {
    id: uid('cli'), name: 'Novo cliente', specialty: '', crm: '',
    primary: '#0f3d3e', accent: '#2bb3a3', text: '#ffffff',
    font: 'Inter', logoMediaId: null,
    expertSide: 'left', // expert à esquerda -> palavras-chave à direita
    keywords: [], captionStyle: 'karaoke', captionPos: 'bottom', look: 'clinico',
    platform: 'hotmart', lowerThird: true, watermark: true, openingTitle: true,
    cleanVoice: true, silenceDb: -38, minSilence: 0.45, padding: 0.08, autoZoom: true,
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
