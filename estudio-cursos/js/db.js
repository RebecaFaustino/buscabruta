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

// Arquivos gigantes (aulas de 1 h, 4K, dezenas de GB) não são copiados: o app usa o próprio arquivo
// do aparelho enquanto a página está aberta. Se a página for recarregada, pede para reencontrar o arquivo.
export const BIG = (() => { try { return (+localStorage.getItem('ec-big-mb') || 1536) * 1048576; } catch { return 1536 * 1048576; } })();

// Pasta privada do navegador (OPFS): guarda as exportações grandes direto no disco, sem ocupar a memória.
export async function opfsFile(name, create = false) {
  try {
    const root = await navigator.storage?.getDirectory?.();
    if (!root) return null;
    return await root.getFileHandle(name, { create });
  } catch { return null; }
}
export async function opfsRemove(name) { try { const root = await navigator.storage.getDirectory(); await root.removeEntry(name); } catch {} }

// Pede ao navegador para não apagar os vídeos guardados quando faltar espaço (armazenamento persistente).
export async function persistStorage() { try { return await navigator.storage?.persist?.(); } catch { return false; } }
export async function storageInfo() { try { const e = await navigator.storage.estimate(); return { used: e.usage || 0, quota: e.quota || 0 }; } catch { return null; } }

const copying = new Map(); // id -> fração copiada
export const copyProgress = () => [...copying.values()];
async function copyToDisk(id, blob) {
  try {
    const info = await storageInfo();
    if (info && info.quota && info.quota - info.used < blob.size * 1.05) { console.warn('Sem espaço livre para guardar o vídeo no app'); return false; }
    await persistStorage();
    const name = 'src-' + id;
    const h = await opfsFile(name, true);
    if (!h?.createWritable) return false;
    const w = await h.createWritable();
    let done = 0;
    copying.set(id, 0);
    const meter = new TransformStream({ transform(chunk, ctl) { done += chunk.byteLength; copying.set(id, done / blob.size); ctl.enqueue(chunk); } });
    await blob.stream().pipeThrough(meter).pipeTo(w);
    await tx('kv', 'readwrite', (s) => s.put(name, 'opfs:' + id));
    return true;
  } catch (e) { console.warn('Não foi possível guardar o vídeo grande no aparelho', e); return false; }
  finally { copying.delete(id); }
}

export const db = {
  keep(id, blob) {
    live.set(id, blob);
    if (blob.size > BIG) {
      // exportação grande já está no disco (OPFS): só lembra onde está
      if (blob._opfs) { tx('kv', 'readwrite', (s) => s.put(blob._opfs, 'opfs:' + id)).catch(() => {}); return Promise.resolve(true); }
      // vídeo grande (aula longa, 4K, dezenas de GB): copia em fluxo para o armazenamento do app no aparelho,
      // sem passar pela memória. Enquanto copia, o app já usa o arquivo original.
      const p = copyToDisk(id, blob);
      pending.set(id, p);
      p.finally(() => pending.delete(id));
      return p;
    }
    const p = tx('media', 'readwrite', (s) => s.put(blob, id)).then(() => true, (e) => { console.warn('Não foi possível guardar o vídeo neste aparelho', e); return false; });
    pending.set(id, p);
    p.finally(() => pending.delete(id));
    return p;
  },
  async getBlob(id) {
    let b = live.get(id) || (await tx('media', 'readonly', (s) => s.get(id)).catch(() => null));
    if (!b) {
      const name = await tx('kv', 'readonly', (s) => s.get('opfs:' + id)).catch(() => null);
      const h = name && await opfsFile(name);
      b = h ? await h.getFile().catch(() => null) : null;
      if (b) live.set(id, b);
    }
    if (b || !db.remote) return b;
    // não está neste aparelho: busca na nuvem e guarda uma cópia local
    const r = await db.remote(id).catch((e) => { console.warn(e); return null; });
    if (r) db.keep(id, r);
    return r;
  },
  remote: null,
  isLive: (id) => live.has(id),
  relink(id, file) { live.set(id, file); },
  isSaving: () => pending.size > 0,
  waitSaved: () => Promise.all(pending.values()),
  get: (k) => tx('kv', 'readonly', (s) => s.get(k)),
  set: (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k)),
  putMedia: (id, blob) => tx('media', 'readwrite', (s) => s.put(blob, id)),
  getMedia: (id) => tx('media', 'readonly', (s) => s.get(id)),
  async delMedia(id) { const name = await tx('kv', 'readonly', (s) => s.get('opfs:' + id)).catch(() => null); if (name) { await opfsRemove(name); await tx('kv', 'readwrite', (s) => s.delete('opfs:' + id)).catch(() => {}); } live.delete(id); return tx('media', 'readwrite', (s) => s.delete(id)); },
};
