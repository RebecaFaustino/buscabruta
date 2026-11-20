// Backup automático dos projetos no Google Drive da Rebeca (pasta "Estúdio de Cursos — backups").
// Guarda clientes, cursos, aulas, cortes, legendas, estilos e destaques (o "projeto"), não os vídeos:
// os vídeos ficam no aparelho. Assim dá para reabrir qualquer aula e fazer o ajuste que o cliente pedir.
import { state } from './state.js';

const FOLDER = 'Estúdio de Cursos — backups';
const EVERY = 6 * 3600e3; // no máximo a cada 6 h, e só se algo mudou
const LS = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } };

export const backup = { state: 'idle', text: '', at: +LS('ec-bk-at') || 0 };
const subs = new Set();
export const onBackup = (fn) => { subs.add(fn); fn(backup); return () => subs.delete(fn); };
const set = (st, text, extra = {}) => { Object.assign(backup, { state: st, text, ...extra }); subs.forEach((f) => { try { f(backup); } catch {} }); };

function snapshot() {
  const courses = state.courses.map((k) => ({ ...k, modules: k.modules.map((m) => ({ ...m, lessons: m.lessons.map((l) => ({ ...l, render: l.render ? { ...l.render } : null })) })) }));
  return { app: 'estudio-cursos', versao: 1, criadoEm: new Date().toISOString(), clients: state.clients, courses, media: state.media || {} };
}

let mcpP = null;
const mcpGet = () => (mcpP = mcpP || (window.claude?.use ? window.claude.use('mcp').catch(() => null) : Promise.resolve(null)));

async function folderId(mcp) {
  const cached = LS('ec-bk-folder');
  if (cached) return cached;
  const q = `title = '${FOLDER}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const r = await mcp.callTool('Google Drive', 'search_files', { query: q, pageSize: 5, excludeContentSnippets: true });
  let id = r.payload?.files?.[0]?.id;
  if (!id) {
    const c = await mcp.callTool('Google Drive', 'create_file', { title: FOLDER, contentMimeType: 'application/vnd.google-apps.folder' });
    id = c.payload?.id || c.payload?.file?.id;
  }
  if (id) LS('ec-bk-folder', id);
  return id;
}

let running = false, refused = false;
export async function backupNow({ auto = false } = {}) {
  if (running || (auto && refused)) return false;
  const mcp = await mcpGet();
  if (!mcp) { set('off', 'Abra no claude.ai para o backup no Google Drive'); return false; }
  running = true;
  set('saving', 'Fazendo backup no Google Drive…');
  try {
    const parent = await folderId(mcp);
    const json = JSON.stringify(snapshot());
    const d = new Date(), pad = (n) => String(n).padStart(2, '0');
    const title = `backup-estudio-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}h${pad(d.getMinutes())}.json`;
    const args = { title, parentId: parent || undefined, contentMimeType: 'application/json', disableConversionToGoogleType: true };
    if (json.length < 900_000) args.textContent = json;
    else {
      const lt = await mcp.listTools().catch(() => null);
      if (!lt?.fileArgs) throw Object.assign(new Error('Projeto grande demais para o backup por este aparelho'), { code: 'too_big' });
      args.base64Content = { $file: { data: new Blob([json], { type: 'application/json' }), name: title, type: 'application/json' } };
    }
    await mcp.callTool('Google Drive', 'create_file', args);
    backup.at = Date.now(); LS('ec-bk-at', String(backup.at)); LS('ec-bk-ver', String(state.updatedAt || 0));
    set('ok', `Backup no Drive · ${new Date(backup.at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}`);
    return true;
  } catch (e) {
    const code = e?.code;
    if (code === 'not_in_manifest' || code === 'approval_required' || code === 'consent_required') { refused = auto; set('ask', 'Permita o Google Drive para o backup automático'); }
    else if (code === 'server_not_connected' || code === 'needs_reauth') set('need', 'Conecte o Google Drive em claude.ai → Configurações → Conectores');
    else { LS('ec-bk-folder', ''); set('err', 'Backup não feito agora (tentaremos de novo)'); }
    console.warn('backup', e);
    return false;
  } finally { running = false; }
}

// Automático: quando algo mudou e o último backup tem mais de 6 h (verifica ao abrir, a cada 30 min e ao sair da tela).
export function startAutoBackup() {
  const due = () => (state.updatedAt || 0) > (+LS('ec-bk-ver') || 0) && Date.now() - (+LS('ec-bk-at') || 0) > EVERY;
  const tick = () => { if (due()) backupNow({ auto: true }); };
  if (backup.at) set('ok', `Backup no Drive · ${new Date(backup.at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}`);
  setTimeout(tick, 20_000);
  setInterval(tick, 30 * 60e3);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') tick(); });
}

// Restaura um backup (.json baixado do Drive). Junta com o que já existe: o backup vence em caso de conflito.
export async function restoreBackup(file) {
  const data = JSON.parse(await file.text());
  if (data?.app !== 'estudio-cursos' || !Array.isArray(data.clients) || !Array.isArray(data.courses)) throw new Error('Este arquivo não é um backup do Estúdio de Cursos.');
  const byId = (arr) => new Map(arr.map((x) => [x.id, x]));
  const cl = byId(state.clients), co = byId(state.courses);
  for (const c of data.clients) cl.set(c.id, c);
  for (const k of data.courses) co.set(k.id, k);
  state.clients = [...cl.values()];
  state.courses = [...co.values()];
  state.media = { ...(state.media || {}), ...(data.media || {}) };
  return { clients: data.clients.length, courses: data.courses.length, at: data.criadoEm };
}
