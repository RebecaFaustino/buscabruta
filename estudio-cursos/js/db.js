// Persistência local: IndexedDB guarda estado (JSON) e vídeos (Blobs).
const DB_NAME = 'estudio-cursos';
const DB_VER = 1;
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('media')) db.createObjectStore('media');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const req = fn(s);
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
  });
}

// Arquivos escolhidos nesta sessão ficam na memória (o objeto File, sem cópia) enquanto a cópia
// permanente é gravada no IndexedDB em segundo plano — vídeos de 1 GB+ levam minutos para gravar.
const live = new Map();
const pending = new Map();

export const db = {
  keep(id, blob) {
    live.set(id, blob);
    const p = tx('media', 'readwrite', (s) => s.put(blob, id)).then(() => true, (e) => { console.warn('Não foi possível guardar o vídeo neste aparelho', e); return false; });
    pending.set(id, p);
    p.finally(() => pending.delete(id));
    return p;
  },
  async getBlob(id) {
    return live.get(id) || (await tx('media', 'readonly', (s) => s.get(id)).catch(() => null));
  },
  isSaving: () => pending.size > 0,
  waitSaved: () => Promise.all(pending.values()),
  get: (k) => tx('kv', 'readonly', (s) => s.get(k)),
  set: (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k)),
  putMedia: (id, blob) => tx('media', 'readwrite', (s) => s.put(blob, id)),
  getMedia: (id) => tx('media', 'readonly', (s) => s.get(id)),
  delMedia: (id) => tx('media', 'readwrite', (s) => s.delete(id)),
};
