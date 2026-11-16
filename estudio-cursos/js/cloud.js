// Nuvem ao vivo: projetos no banco do claude.ai (privado da usuária) e vídeos originais no armazenamento de arquivos.
// Sem a nuvem (aberto fora do claude.ai), tudo continua funcionando só neste aparelho.
const cap = (n) => (window.claude?.use ? window.claude.use(n).catch(() => null) : Promise.resolve(null));
const DEVICE = Math.random().toString(36).slice(2, 10);
const DOC_MAX = 180_000; // caracteres por documento (limite do banco: 256 KiB)
const RAW_MAX = 19.5 * 1024 * 1024; // arquivo direto até 20 MiB
const B64_PART = 13 * 1024 * 1024; // vídeos maiores: partes de 13 MiB codificadas em texto

let C = null;
const listeners = new Set();
export const cloud = {
  status: { state: 'off', text: 'Só neste aparelho', at: null },
  on: () => !!C,
  onStatus(fn) { listeners.add(fn); fn(cloud.status); return () => listeners.delete(fn); },
};
function setStatus(state, text) {
  cloud.status = { state, text, at: Date.now() };
  listeners.forEach((f) => { try { f(cloud.status); } catch {} });
}

export async function cloudInit() {
  const [db, user, assets] = await Promise.all([cap('db'), cap('user'), cap('assets')]);
  if (!db || !user) return null;
  const uid = await user.id().catch(() => null);
  if (!uid) return null;
  C = { db, assets, uid, col: db.collection(`data/users/${uid}`), lastLesson: new Map(), lastIndex: '' };
  setStatus('ok', 'Nuvem conectada');
  return C;
}

// ---------- compactação (gzip + base64) para caber nos documentos ----------
async function pack(obj) {
  const json = JSON.stringify(obj);
  if (typeof CompressionStream === 'undefined') return 'J' + json;
  const buf = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  let s = '', b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return 'G' + btoa(s);
}
async function unpack(str) {
  if (str[0] === 'J') return JSON.parse(str.slice(1));
  const bin = Uint8Array.from(atob(str.slice(1)), (c) => c.charCodeAt(0));
  const txt = await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  return JSON.parse(txt);
}
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

async function putBig(name, obj, extra = {}) {
  const s = await pack(obj);
  const parts = Math.max(1, Math.ceil(s.length / DOC_MAX));
  for (let i = 0; i < parts; i++) await C.col.doc(`${name}__${i}`).set({ d: s.slice(i * DOC_MAX, (i + 1) * DOC_MAX) });
  await C.col.doc(name).set({ parts, updatedAt: Date.now(), device: DEVICE, ...extra });
}
async function getBig(name) {
  const h = await C.col.doc(name).get();
  if (!h.exists) return null;
  const head = h.data();
  let s = '';
  for (let i = 0; i < head.parts; i++) s += (await C.col.doc(`${name}__${i}`).get()).data()?.d || '';
  return { head, obj: await unpack(s) };
}

// ---------- estado ----------
function splitState(state) {
  const lessons = [];
  const courses = state.courses.map((c) => ({
    ...c,
    modules: c.modules.map((m) => ({ ...m, lessons: m.lessons.map((l) => { lessons.push(l); return { id: l.id, title: l.title, ref: true }; }) })),
  }));
  return { index: { clients: state.clients, courses, media: state.media || {}, updatedAt: state.updatedAt }, lessons };
}

let pushing = null, again = false;
export function cloudPush(state) {
  if (!C) return;
  if (pushing) { again = true; return; }
  pushing = (async () => {
    setStatus('saving', 'Salvando na nuvem…');
    try {
      const { index, lessons } = splitState(state);
      for (const l of lessons) {
        const json = JSON.stringify({ ...l, render: null });
        const h = hash(json);
        if (C.lastLesson.get(l.id) === h) continue;
        await putBig(`aula_${l.id}`, JSON.parse(json));
        C.lastLesson.set(l.id, h);
      }
      const ij = JSON.stringify(index);
      if (ij !== C.lastIndex) { await putBig('estado', index, { lessons: lessons.map((l) => l.id) }); C.lastIndex = ij; }
      setStatus('ok', 'Salvo na nuvem');
    } catch (e) {
      console.warn('nuvem', e);
      setStatus('err', e?.code === 'not_granted' ? 'Permita o acesso à nuvem nas permissões da página' : 'Não foi possível salvar na nuvem agora');
    }
  })().finally(() => { pushing = null; if (again) { again = false; cloudPush(state); } });
}

// Baixa o estado da nuvem se for mais novo que o local. Retorna true se substituiu.
export async function cloudPull(state, { force = false } = {}) {
  if (!C) return false;
  try {
    const got = await getBig('estado');
    if (!got) return false;
    const { head, obj } = got;
    if (!force && (state.updatedAt || 0) >= (obj.updatedAt || 0)) return false;
    setStatus('saving', 'Atualizando da nuvem…');
    const lessonsById = {};
    for (const c of obj.courses) for (const m of c.modules) for (const l of m.lessons) {
      const local = state.courses.flatMap((k) => k.modules.flatMap((mm) => mm.lessons)).find((x) => x.id === l.id);
      const r = await getBig(`aula_${l.id}`).catch(() => null);
      lessonsById[l.id] = r ? { ...r.obj, render: local?.render || null } : local || { ...l, sources: [], clips: [], words: {}, cards: [] };
      C.lastLesson.set(l.id, hash(JSON.stringify({ ...lessonsById[l.id], render: null })));
    }
    obj.courses.forEach((c) => c.modules.forEach((m) => (m.lessons = m.lessons.map((l) => lessonsById[l.id]))));
    state.clients = obj.clients;
    state.courses = obj.courses;
    state.media = { ...(state.media || {}), ...(obj.media || {}) };
    state.updatedAt = obj.updatedAt;
    C.lastIndex = JSON.stringify(splitState(state).index);
    void head;
    setStatus('ok', 'Atualizado da nuvem');
    return true;
  } catch (e) {
    console.warn('nuvem', e);
    setStatus('err', 'Não foi possível ler a nuvem agora');
    return false;
  }
}

// Ao vivo: avisa quando outro aparelho salvou.
export function cloudWatch(onRemote) {
  if (!C) return () => {};
  let first = true;
  return C.col.doc('estado').onSnapshot((snap) => {
    if (first) { first = false; return; }
    const d = snap.data();
    if (d && d.device !== DEVICE) onRemote(d);
  }, (e) => console.warn('nuvem (ao vivo)', e));
}

// ---------- vídeos ----------
export async function cloudUploadMedia(id, blob, onProgress) {
  if (!C?.assets) return null;
  const type = blob.type || 'video/mp4';
  if (blob.size <= RAW_MAX) {
    const a = await C.assets.upload(new Blob([blob], { type }));
    onProgress?.(1);
    return { ids: [a.id], mode: 'raw', size: blob.size, type };
  }
  const ids = [];
  const n = Math.ceil(blob.size / B64_PART);
  for (let i = 0; i < n; i++) {
    const part = new Uint8Array(await blob.slice(i * B64_PART, (i + 1) * B64_PART).arrayBuffer());
    let s = '';
    for (let j = 0; j < part.length; j += 0x8000) s += String.fromCharCode.apply(null, part.subarray(j, j + 0x8000));
    const a = await C.assets.upload(new Blob([btoa(s)], { type: 'text/plain' }));
    ids.push(a.id);
    onProgress?.((i + 1) / n);
  }
  return { ids, mode: 'b64', size: blob.size, type };
}

export async function cloudFetchMedia(info) {
  if (!info?.ids?.length) return null;
  const bufs = [];
  for (const id of info.ids) {
    const r = await fetch('/_blob/' + id);
    if (!r.ok) throw new Error('Vídeo indisponível na nuvem (' + r.status + ')');
    if (info.mode === 'raw') bufs.push(await r.blob());
    else bufs.push(Uint8Array.from(atob(await r.text()), (c) => c.charCodeAt(0)));
  }
  return new Blob(bufs, { type: info.type || 'video/mp4' });
}

export async function cloudUsage() {
  if (!C?.assets) return null;
  try { return (await C.assets.list()).usage; } catch { return null; }
}
