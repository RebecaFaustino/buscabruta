// Estúdio de Marketing ao vivo: lê a tabela "Clientes — estilos e particularidades" no Notion da Rebeca
// (preenchida pelo ChatGPT/Estúdio de Marketing) e aplica cores, modelo, palavras-chave e particularidades
// no perfil de cada cliente. Atualiza sozinho enquanto o app está aberto.
import { state, save, newClient } from './state.js';
import { TEMPLATES } from './styles.js';
import { fontName, ensureFont } from './fonts.js';
import { db } from './db.js';

export const MKT_SOURCE = 'collection://41a6c06c-d7f3-81e9-aab7-000bfbca9205';
export const MKT_URL = 'https://app.notion.com/p/41a6c06cd7f381ba9470fd0dfd1ecc6d';
const SERVER = 'Notion';
const TPL = { clinica: 'clinico', clinico: 'clinico', cinema: 'cinema', blueprint: 'blueprint', editorial: 'editorial', suave: 'suave', impacto: 'impacto', luxo: 'luxo', documentario: 'documentario' };
const PLAT = ['hotmart', 'eduzz', 'sympla', 'kiwify', 'reels', 'youtube', 'memberkit'];
const MUSIC = ['nenhuma', 'calma', 'inspira', 'corporativa'];

export const mkt = { state: 'off', text: 'Estúdio de Marketing não conectado', at: null, rows: 0 };
const subs = new Set();
export const onMkt = (fn) => { subs.add(fn); fn(mkt); return () => subs.delete(fn); };
const set = (st, text, extra = {}) => { Object.assign(mkt, { state: st, text, ...extra }); subs.forEach((f) => { try { f(mkt); } catch {} }); };

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\b(dra?|prof(a)?|doutora?)\.?\s+/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const hex = (v) => (/^#?[0-9a-f]{6}$/i.test(String(v || '').trim()) ? '#' + String(v).trim().replace('#', '').toLowerCase() : null);
const txt = (v) => String(v ?? '').trim();

function rowsOf(res) {
  let p = res?.payload ?? res;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { return null; } }
  if (Array.isArray(p)) return p;
  if (Array.isArray(p?.results)) return p.results;
  for (const b of res?.content || []) if (b.type === 'text') { try { const j = JSON.parse(b.text); if (Array.isArray(j?.results)) return j.results; } catch {} }
  return null;
}

// Aplica uma linha do Notion a um cliente. Retorna true se algo mudou.
export function applyRow(c, r) {
  const before = JSON.stringify(c);
  const name = txt(r['Cliente']);
  if (name) c.name = name;
  if (txt(r['Especialidade'])) c.specialty = txt(r['Especialidade']);
  if (txt(r['Registro (CRM/RQE)'])) c.crm = txt(r['Registro (CRM/RQE)']);
  if (hex(r['Cor principal'])) {
    c.primary = hex(r['Cor principal']);
    // texto sobre a cor principal: branco em cor escura, quase preto em cor clara
    const n = parseInt(c.primary.slice(1), 16), L = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    c.text = L > 0.6 ? '#1f1530' : '#ffffff';
  }
  if (hex(r['Cor de destaque'])) c.accent = hex(r['Cor de destaque']);
  const kw = txt(r['Palavras-chave']).split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
  if (kw.length) c.keywords = [...new Set(kw)];
  const tpl = TPL[fold(r['Modelo de vídeo']).replace(/ /g, '')];
  if (tpl) c.template = tpl;
  const pf = fold(r['Plataforma']);
  if (PLAT.includes(pf)) c.platform = pf;
  const mu = fold(r['Trilha']);
  if (MUSIC.includes(mu)) c.music = mu;
  const side = fold(r['Lado do expert']);
  if (side === 'esquerda') c.expertSide = 'left'; else if (side === 'direita') c.expertSide = 'right';
  const ft = fontName(r['Fonte dos títulos']), fb = fontName(r['Fonte do texto']);
  if (ft) c.fontTitle = ft;
  if (fb) c.fontBody = fb;
  const pal = txt(r['Paleta completa']).split(/[,;\s]+/).map(hex).filter(Boolean);
  if (pal.length) c.palette = [...new Set(pal)].slice(0, 8);
  const logo = txt(r['Logo (link)']);
  if (logo && logo !== c.logoFrom) c.logoPending = logo;
  c.mkt = {
    tom: txt(r['Tom de voz']), publico: txt(r['Público']), proibidas: txt(r['Palavras proibidas']), notas: txt(r['Particularidades']),
    instagram: txt(r['Instagram']), url: txt(r.url), at: txt(r['Atualizado em']),
  };
  return JSON.stringify(c) !== before;
}

export function findClient(name) {
  const f = fold(name);
  if (!f) return null;
  return state.clients.find((c) => fold(c.name) === f) || state.clients.find((c) => { const g = fold(c.name); return g && (g.includes(f) || f.includes(g)); }) || null;
}

function merge(rows, onChange) {
  const changed = [];
  for (const r of rows) {
    const name = txt(r['Cliente']);
    if (!name || /^teste\b/i.test(name)) continue;
    let c = (r.url && state.clients.find((x) => x.mkt?.url === r.url)) || findClient(name);
    if (c && c.mkt?.at && c.mkt.at === txt(r['Atualizado em'])) continue; // já está em dia
    const isNew = !c;
    if (isNew) { c = newClient(); state.clients.push(c); }
    const had = applyRow(c, r);
    // cliente novo sem cores definidas: usa a paleta do modelo escolhido (fica coerente até a paleta ser confirmada)
    if (isNew && !hex(r['Cor principal']) && TEMPLATES[c.template]?.palette) Object.assign(c, { primary: TEMPLATES[c.template].palette.primary.toLowerCase(), accent: TEMPLATES[c.template].palette.accent.toLowerCase(), text: TEMPLATES[c.template].palette.text.toLowerCase() });
    if (had || isNew) changed.push({ client: c, isNew });
  }
  // chegaram clientes reais: tira o cliente de exemplo, se ninguém usou (sem vídeo em nenhuma aula)
  if (changed.some((x) => x.isNew)) {
    const demo = state.clients.find((c) => c.name === 'Dra. Exemplo Silva' && c.crm === 'CRM-SP 000000' && !c.mkt);
    const used = demo && state.courses.some((k) => k.clientId === demo.id && k.modules.some((m) => m.lessons.some((l) => l.sources?.length)));
    if (demo && !used) { state.clients = state.clients.filter((c) => c !== demo); state.courses = state.courses.filter((k) => k.clientId !== demo.id); }
  }
  if (changed.length) { save(); onChange?.(changed); }
  // fontes e logos chegam depois (rede): avisa de novo quando estiverem prontos
  for (const { client: c } of changed) {
    Promise.all([ensureFont(c.fontTitle), ensureFont(c.fontBody)]).then(() => onChange?.([], { quiet: true }));
    if (c.logoPending) fetchLogo(c).then((ok) => ok && onChange?.([{ client: c, isNew: false }], { logo: true }));
  }
  return changed;
}

let unwatch = null, toolName = 'notion-query-data-sources';
export async function startMarketing(onChange) {
  const mcp = await (window.claude?.use ? window.claude.use('mcp').catch(() => null) : null);
  if (!mcp) { set('off', 'Abra no claude.ai para ligar o Estúdio de Marketing'); return false; }
  try {
    const l = await mcp.listTools(SERVER);
    const t = l?.servers?.[0]?.tools?.find((x) => /query[-_]data[-_]sources/.test(x.name));
    if (t) toolName = t.name;
  } catch {}
  const input = { data: { mode: 'rows', data_source_url: MKT_SOURCE, limit: 100 } };
  const handle = (res) => {
    const rows = rowsOf(res);
    if (!rows) { set('err', 'Resposta do Notion em formato inesperado'); return; }
    const n = rows.filter((r) => txt(r['Cliente']) && !/^teste\b/i.test(txt(r['Cliente']))).length;
    merge(rows, onChange);
    set('ok', n ? `Ao vivo · ${n} ${n === 1 ? 'cliente' : 'clientes'}` : 'Ao vivo · tabela ainda vazia', { at: res?.cache?.storedAt || Date.now(), rows: n });
  };
  const fail = (e) => {
    const code = e?.code;
    if (code === 'server_not_connected' || code === 'server_not_found') set('need', 'Conecte o Notion em claude.ai → Configurações → Conectores');
    else if (code === 'needs_reauth') set('need', 'Reconecte o Notion em claude.ai → Configurações → Conectores');
    else if (code === 'approval_required' || code === 'not_in_manifest' || code === 'consent_required') set('ask', 'Permita a leitura do Notion para usar os perfis do Estúdio de Marketing');
    else if (code === 'not_granted' || code === 'capability_disabled' || code === 'capability_removed') set('off', 'Leitura do Notion indisponível nesta tela');
    else set('err', 'Não foi possível ler o Notion agora; tentando de novo em instantes');
  };
  unwatch?.();
  unwatch = mcp.watchTool(SERVER, toolName, input, (ev) => (ev.type === 'data' ? handle(ev.result) : fail(ev.error)), { refetchInterval: 60_000, cache: { staleTime: 30_000, gcTime: 600_000 } });
  // primeira leitura pedindo permissão (o watch sozinho nunca pergunta)
  set('loading', 'Conectando ao Estúdio de Marketing…');
  try { handle(await mcp.callTool(SERVER, toolName, input, { cache: { refresh: true, staleTime: 30_000, gcTime: 600_000 } })); } catch (e) { fail(e); }
  return true;
}

// Botão "Atualizar agora" / "Permitir": nova leitura iniciada pela usuária.
export async function refreshMarketing(onChange) {
  const mcp = await (window.claude?.use ? window.claude.use('mcp').catch(() => null) : null);
  if (!mcp) return;
  set('loading', 'Atualizando do Estúdio de Marketing…');
  try {
    const res = await mcp.callTool(SERVER, toolName, { data: { mode: 'rows', data_source_url: MKT_SOURCE, limit: 100 } }, { cache: { refresh: true, staleTime: 30_000, gcTime: 600_000 } });
    const rows = rowsOf(res) || [];
    merge(rows, onChange);
    const n = rows.filter((r) => txt(r['Cliente']) && !/^teste\b/i.test(txt(r['Cliente']))).length;
    set('ok', n ? `Ao vivo · ${n} ${n === 1 ? 'cliente' : 'clientes'}` : 'Ao vivo · tabela ainda vazia', { at: Date.now(), rows: n });
  } catch (e) {
    set(e?.code === 'server_not_connected' ? 'need' : 'err', e?.code === 'server_not_connected' ? 'Conecte o Notion em claude.ai → Configurações → Conectores' : 'Não foi possível ler o Notion agora');
  }
}

// Termos que o cliente não usa e que aparecem na legenda da aula.
export function forbiddenIn(c, text) {
  const list = String(c?.mkt?.proibidas || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
  const t = ' ' + fold(text) + ' ';
  return list.filter((w) => { const f = fold(w); return f && t.includes(' ' + f + ' '); });
}

// Logo da marca: link do Google Drive (lido pelo conector do Drive) ou link direto de imagem.
// Guarda uma cópia reduzida (até 900 px) no aparelho/nuvem, como se tivesse sido enviada à mão.
async function fetchLogo(c) {
  const link = c.logoPending;
  try {
    let blob = null;
    const id = (link.match(/\/d\/([\w-]{20,})/) || link.match(/[?&]id=([\w-]{20,})/) || [])[1];
    if (id) {
      const mcp = await (window.claude?.use ? window.claude.use('mcp').catch(() => null) : null);
      if (!mcp) return false;
      const r = await mcp.callTool('Google Drive', 'download_file_content', { fileId: id });
      const img = (r.content || []).find((b) => b.type === 'image' && b.data);
      const p = r.payload && typeof r.payload === 'object' ? r.payload : {};
      const b64 = img?.data || p.content || p.base64Content || p.data || p.contentBase64 || (typeof r.payload === 'string' ? r.payload : null);
      const type = img?.mimeType || p.mimeType || 'image/png';
      if (typeof b64 !== 'string' || b64.length < 100) return false;
      const bin = Uint8Array.from(atob(b64.replace(/\s+/g, '')), (ch) => ch.charCodeAt(0));
      blob = new Blob([bin], { type });
    } else {
      const res = await fetch(link);
      if (!res.ok) return false;
      blob = await res.blob();
    }
    blob = await shrink(blob, 900);
    const mid = 'logo_' + Math.random().toString(36).slice(2, 10);
    await db.putMedia(mid, blob);
    c.logoMediaId = mid; c.logoFrom = link; delete c.logoPending;
    save();
    window.dispatchEvent(new Event('ec-media-added'));
    return true;
  } catch (e) { console.warn('logo da marca', e); return false; }
}

async function shrink(blob, max) {
  const bmp = await createImageBitmap(blob).catch(() => null);
  if (!bmp) return blob;
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  return await new Promise((res) => cv.toBlob((b) => res(b || blob), 'image/png'));
}
