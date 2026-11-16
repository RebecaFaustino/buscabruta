import { db } from './db.js';
import { state, save, load, uid, newClient, newCourse, newModule, newLesson, getClient, getCourse, findLesson, briefOf } from './state.js';
import { startMarketing, refreshMarketing, onMkt, mkt, MKT_URL } from './marketing.js';
import { PLATFORMS, LOOKS, CAPTION_STYLES } from './presets.js';
import { analyze, speechRanges, decodePCM16k } from './audio.js';
import { phrases, spread, parseSubs, srt, vtt, timelineCaptions, suggestKeywords, autoCards, norm } from './captions.js';
import { Player, drawStylePreview } from './player.js';
import { SFX, playSfx } from './sfx.js';
import { TRACKS, buildMusic } from './music.js';
import { drawCover } from './cover.js';
import { TEMPLATES, PALETTES, CAPTION_MODES, CARD_VARIANTS, resolveStyle } from './styles.js';
import { renderLesson, extOf, pickMime } from './render.js';
import { cloud, cloudInit, cloudPull, cloudPush, cloudWatch, cloudUploadMedia, cloudFetchMedia, cloudUsage } from './cloud.js';
import { envs, importVideo, isMedia, getEnv, autoCutLesson, transcribeLesson, aiReviewLesson, keywordsAndCards } from './pipeline.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (t) => { t = Math.max(0, t || 0); const m = Math.floor(t / 60), s = Math.floor(t % 60), d = Math.floor((t % 1) * 10); return `${m}:${String(s).padStart(2, '0')}.${d}`; };
const fmtLong = (t) => { t = Math.round(t || 0); const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60; return h ? `${h}h${String(m).padStart(2, '0')}` : m ? `${m}min ${String(s).padStart(2, '0')}s` : `${s}s`; };
const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
const pl = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
const slug = (s) => norm(s).replace(/\s+/g, '-').slice(0, 60) || 'aula';
const lessonDur = (l) => l.clips.reduce((a, c) => a + c.out - c.in, 0);
const rawDur = (l) => l.sources.reduce((a, s) => a + (s.duration || 0), 0);

const view = $('#view');

export function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

// Recursos do claude.ai (quando publicado como Artifact). Fora dele, cai no comportamento normal do navegador.
const cap = (name) => (window.claude?.use ? window.claude.use(name).catch(() => null) : Promise.resolve(null));
const SAVE_EXT = ['mp4', 'webm', 'mov', 'txt', 'json', 'md', 'csv', 'zip', 'pdf', 'png', 'jpg'];

// Biblioteca de .zip: só é baixada quando alguém gera um pacote (deixa a abertura do app mais leve).
let zipLoading;
function needZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  return (zipLoading ||= new Promise((res, rej) => {
    const sc = document.createElement('script');
    sc.src = 'vendor/jszip.min.js';
    sc.onload = () => res(window.JSZip);
    sc.onerror = () => { zipLoading = null; rej(new Error('Não foi possível carregar o gerador de .zip. Verifique a internet.')); };
    document.head.appendChild(sc);
  }));
}

async function download(blob, name) {
  let ext = name.split('.').pop().toLowerCase();
  if (!SAVE_EXT.includes(ext)) await needZip().catch(() => null);
  if (!SAVE_EXT.includes(ext) && window.JSZip) {
    // .srt/.vtt não são aceitos pelo salvamento do claude.ai: entregamos dentro de um .zip
    const z = new JSZip();
    z.file(name, blob);
    blob = await z.generateAsync({ type: 'blob' });
    name += '.zip';
  }
  const dl = await cap('downloads');
  if (dl) {
    try { await dl.save({ filename: name, data: blob }); toast('Arquivo salvo', 'ok'); }
    catch (e) { if (e?.code !== 'declined') toast('Não foi possível salvar: ' + (e?.message || e?.code), 'err'); }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// Confirmação dentro da página (o visualizador do claude.ai não exibe confirm()).
function ask(msg, okLabel = 'Excluir') {
  return new Promise((res) => {
    const d = document.createElement('div');
    d.className = 'modal';
    d.innerHTML = `<div class="modal-box" role="dialog" aria-modal="true"><p>${esc(msg)}</p>
      <div class="btn-row end"><button class="ghost" data-r="0">Cancelar</button><button class="btn danger-btn" data-r="1">${esc(okLabel)}</button></div></div>`;
    d.onclick = (e) => { const r = e.target.dataset.r; if (r !== undefined || e.target === d) { d.remove(); res(r === '1'); } };
    document.body.appendChild(d);
    d.querySelector('[data-r="1"]').focus();
  });
}

// ======================= Navegação =======================
let cur = '#/';
try { cur = localStorage.getItem('ec-route') || '#/'; } catch {}
// Histórico próprio: o botão "Voltar" da tela e o voltar do celular (Android) levam à tela anterior.
const stack = [];
let histOK = false, waitingPop = null;
function setCur(hash) { cur = hash; try { localStorage.setItem('ec-route', hash); } catch {} }
function go(hash) {
  if (hash !== cur) {
    stack.push(cur);
    if (stack.length > 60) stack.shift();
    try { history.pushState({ ec: hash }, ''); histOK = true; } catch { histOK = false; }
  }
  setCur(hash);
  document.body.classList.remove('menu-open');
  route();
  window.scrollTo(0, 0);
}
// Tela "mãe" de cada tela, usada quando não há histórico (ex.: app reaberto direto numa aula).
function parentOf(hash) {
  const [, page, a] = hash.split('/');
  if (page === 'aula' || page === 'exportar') return getCourse(a)?.auto ? '#/' : '#/curso/' + a;
  if (page === 'curso') return getCourse(a) ? '#/cliente/' + getCourse(a).clientId : '#/';
  return '#/';
}
function stepBack() {
  setCur(stack.pop() || parentOf(cur));
  document.body.classList.remove('menu-open');
  route();
  window.scrollTo(0, 0);
}
function back() {
  if (busyWork()) { toast('Aguarde terminar antes de sair desta tela.'); return; }
  if (histOK && stack.length) {
    history.back();
    clearTimeout(waitingPop);
    waitingPop = setTimeout(() => { waitingPop = null; stepBack(); }, 350); // se o navegador não avisar, volta mesmo assim
  } else stepBack();
}
window.addEventListener('popstate', () => {
  if (waitingPop) { clearTimeout(waitingPop); waitingPop = null; }
  if (busyWork()) { try { history.pushState({ ec: cur }, ''); } catch {} toast('Aguarde terminar antes de sair desta tela.'); return; }
  stepBack();
});
const busyWork = () => !!document.querySelector('#rProg:not([hidden]), #aProg:not([hidden]), #trProg:not([hidden]), .steps .run');
function addBack() {
  if (cur === '#/' || !cur || view.querySelector(':scope > .back-btn')) return;
  const b = document.createElement('button');
  b.className = 'back-btn';
  b.type = 'button';
  b.innerHTML = '<span aria-hidden="true">‹</span> Voltar';
  b.onclick = back;
  view.prepend(b);
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#/"]');
  if (!a) return;
  e.preventDefault();
  go(a.getAttribute('href'));
});

let editor = null; // estado do editor aberto
function route() {
  if (editor) { editor.player.stop(); editor.dispose?.(); editor = null; }
  const [, page, a, b] = cur.split('/');
  renderSidebar();
  document.body.dataset.page = page || 'inicio';
  if (page === 'cliente' && getClient(a)) viewClient(getClient(a));
  else if (page === 'curso' && getCourse(a)) viewCourse(getCourse(a));
  else if (page === 'aula' && getCourse(a)) viewEditor(getCourse(a), b);
  else if (page === 'exportar' && getCourse(a)) viewExport(getCourse(a));
  else if (page === 'novo') viewAuto();
  else if (page === 'pronto' && getCourse(a)) viewReady(getCourse(a), b);
  else { if (cur !== '#/') setCur('#/'); viewHome(); }
  addBack();
}

function renderSidebar() {
  const [, page, id] = cur.split('/');
  const activeClient = page === 'cliente' ? id : getCourse(id)?.clientId;
  $('#clientList').innerHTML = state.clients.map((c) => `
    <a href="#/cliente/${c.id}" class="${c.id === activeClient ? 'active' : ''}">
      <span class="dot" style="background:${esc(c.accent)}"></span>
      <span><b>${esc(c.name)}</b><small>${esc(c.specialty || 'Sem especialidade')}</small></span>
    </a>`).join('');
}

$('#menuBtn').onclick = () => document.body.classList.toggle('menu-open');
$('#newClientBtn').onclick = () => {
  const c = newClient();
  state.clients.push(c);
  save();
  go('#/cliente/' + c.id);
};

// ======================= Início =======================
function viewHome() {
  const lessons = state.courses.flatMap((c) => c.modules.flatMap((m) => m.lessons.map((l) => ({ c, m, l }))));
  const recent = lessons.filter((x) => x.l.sources.length).slice(-6).reverse();
  view.innerHTML = `
    <section class="hero">
      <div>
        <p class="eyebrow">Estúdio de Cursos</p>
        <h1>Envie o vídeo. A aula volta editada.</h1>
        <p class="lead">Cortes secos, zoom dinâmico, legenda, termos médicos revisados e palavras-chave em destaque, no padrão visual de cada cliente.</p>
      </div>
      <a class="btn big" href="#/novo">Editar um vídeo agora</a>
    </section>
    ${recent.length ? `<h2 class="section-title">Últimas aulas</h2>
    <ul class="recent">${recent.map(({ c, l }) => `<li>
      <span class="dot" style="background:${esc(getClient(c.clientId)?.accent || '#999')}"></span>
      <span class="grow">${esc(l.title)}<small>${esc(getClient(c.clientId)?.name || '')} · ${fmtLong(lessonDur(l))}</small></span>
      ${l.render ? '<span class="tag ok strong">pronta</span>' : ''}
      <a class="btn small ghost" href="#/pronto/${c.id}/${l.id}">Abrir</a></li>`).join('')}</ul>` : ''}
    <h2 class="section-title">Clientes</h2>
    <section class="grid">
      ${state.clients.map((c) => {
        const cs = state.courses.filter((k) => k.clientId === c.id);
        return `<a class="card client-card" href="#/cliente/${c.id}">
          <canvas class="client-prev" width="640" height="360" data-cprev="${c.id}"></canvas>
          <h3>${esc(c.name)}</h3>
          <p>${esc(c.specialty || '—')} ${c.crm ? '· ' + esc(c.crm) : ''}</p>
          <p class="muted">${pl(cs.length, 'curso', 'cursos')}</p>
        </a>`;
      }).join('')}
      <button class="card add-card" id="homeNewClient">+ Novo cliente</button>
    </section>`;
  $('#homeNewClient').onclick = () => $('#newClientBtn').click();
  installHint(view);
  // miniatura do estilo de cada cliente (desenhada aos poucos, sem travar a tela)
  const cvs = [...view.querySelectorAll('[data-cprev]')];
  const next = () => { const cv = cvs.shift(); if (!cv || !cv.isConnected) return; const cl = getClient(cv.dataset.cprev); if (cl) drawStylePreview(cv, { ...cl, openingTitle: false }); requestAnimationFrame(next); };
  requestAnimationFrame(next);
}

// ======================= Edição automática (um toque) =======================
function aulasAvulsas(client) {
  let course = state.courses.find((k) => k.clientId === client.id && k.auto);
  if (!course) {
    course = newCourse(client.id, 'Aulas avulsas');
    course.auto = true;
    course.modules[0].title = 'Aulas';
    course.modules[0].lessons = [];
    state.courses.push(course);
  }
  return course;
}

function viewAuto() {
  let lastClient;
  try { lastClient = localStorage.getItem('ec-last-client'); } catch {}
  const sel = getClient(lastClient) ? lastClient : state.clients[0]?.id || 'novo';
  const today = new Date().toLocaleDateString('pt-BR');
  view.innerHTML = `
    <header class="page-head"><div><p class="eyebrow"><a href="#/">Início</a> / Editar vídeo</p><h1>Editar um vídeo</h1></div></header>
    <section class="panel wizard">
      <div class="form">
        <label>Para qual cliente?
          <select id="wClient">
            ${state.clients.map((c) => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.name)}${c.specialty ? ' — ' + esc(c.specialty) : ''}</option>`).join('')}
            <option value="novo" ${sel === 'novo' ? 'selected' : ''}>+ Novo cliente</option>
          </select>
        </label>
        <div id="wNew" class="row2" hidden>
          <label>Nome do expert<input id="wName" placeholder="Dra. Ana Souza"></label>
          <label>Especialidade<input id="wSpec" placeholder="Cardiologia"></label>
        </div>
        <label>Nome da aula<input id="wTitle" value="Aula de ${today}"></label>
      </div>
      <label class="drop big-drop" id="wDrop">
        <input type="file" id="wFile" accept="video/*" hidden>
        <b>Escolher o vídeo</b>
        <span>Da galeria do celular ou do computador (MP4 ou MOV).</span>
      </label>
      <details class="yt"><summary>O vídeo está no YouTube?</summary>
        <p>O YouTube não permite que outros apps baixem os vídeos. Baixe o arquivo primeiro e depois escolha aqui:</p>
        <ol><li>No computador, abra <b>studio.youtube.com</b> e vá em <b>Conteúdo</b>.</li>
        <li>Nos três pontinhos <b>⋮</b> do vídeo, toque em <b>Baixar</b>.</li>
        <li>Volte aqui e toque em <b>Escolher o vídeo</b>.</li></ol>
        <p class="hint">Funciona para vídeos do seu canal ou do canal do cliente (com acesso ao YouTube Studio).</p>
      </details>
    </section>`;
  const cs = $('#wClient');
  const toggle = () => ($('#wNew').hidden = cs.value !== 'novo');
  cs.onchange = toggle; toggle();
  const drop = $('#wDrop');
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); start(e.dataTransfer.files[0]); };
  $('#wFile').onchange = (e) => start(e.target.files[0]);

  function start(file) {
    if (!file || !isMedia(file)) return toast('Escolha um arquivo de vídeo (MP4 ou MOV).', 'err');
    let client = getClient(cs.value);
    if (!client) {
      const name = $('#wName').value.trim();
      if (!name) { $('#wName').focus(); return toast('Digite o nome do expert.', 'err'); }
      client = newClient({ name, specialty: $('#wSpec').value.trim() });
      state.clients.push(client);
    }
    try { localStorage.setItem('ec-last-client', client.id); } catch {}
    const course = aulasAvulsas(client);
    const lesson = newLesson($('#wTitle').value.trim() || file.name.replace(/\.[^.]+$/, ''));
    course.modules[0].lessons.push(lesson);
    save();
    setCur(`#/pronto/${course.id}/${lesson.id}`);
    renderSidebar();
    runAuto(course, lesson, client, file);
  }
}

const STEPS = [
  ['import', 'Recebendo o vídeo'],
  ['cut', 'Removendo pausas e silêncios'],
  ['subs', 'Criando a legenda'],
  ['review', 'Revisando termos médicos'],
  ['keys', 'Destacando palavras-chave'],
  ['desc', 'Escrevendo a descrição da aula'],
];

async function runAuto(course, lesson, client, file) {
  view.innerHTML = `
    <header class="page-head"><div><p class="eyebrow">${esc(client.name)}</p><h1>${esc(lesson.title)}</h1></div></header>
    <section class="panel wizard">
      <p class="lead">Editando… Deixe esta tela aberta e o aparelho ligado na tomada.</p>
      <ol class="steps">${STEPS.map(([k, t]) => `<li data-step="${k}"><span class="st"></span><span class="grow">${t}<small></small></span></li>`).join('')}</ol>
      <div class="progress"><span id="aBar"></span><em id="aLbl"></em></div>
    </section>`;
  let lock = null;
  try { lock = await navigator.wakeLock?.request('screen'); } catch {}
  const mark = (k, st, note = '') => {
    const li = view.querySelector(`[data-step="${k}"]`);
    if (!li) return;
    li.className = st;
    li.querySelector('small').textContent = note;
  };
  const bar = (f, txt) => { const b = $('#aBar'), l = $('#aLbl'); if (!b) return; if (f != null) b.style.width = Math.round(f * 100) + '%'; b.classList.toggle('pulse', f == null); if (f == null) b.style.width = '100%'; if (txt) l.textContent = txt.replace(/\s*[…\.]*\s*\d+\s*%\s*$/, '…'); if (f != null) l.textContent = l.textContent.replace(/\s+·\s+\d+%$/, '') + ` · ${Math.round(f * 100)}%`; };
  const smp = await cap('sample');
  const warn = [];
  try {
    mark('import', 'run'); bar(0.02, 'Recebendo o vídeo…');
    const src = await importVideo(lesson, file);
    window.dispatchEvent(new Event('ec-media-added'));
    mark('import', 'ok', `${fmtLong(src.duration)} de gravação`);

    mark('cut', 'run'); bar(0.08, 'Analisando o áudio…');
    const removed = await autoCutLesson(lesson, client);
    mark('cut', 'ok', `${lesson.clips.length} cortes · ${fmtLong(removed)} removidos`);

    mark('subs', 'run');
    try {
      await transcribeLesson(lesson, ({ text, progress, busy }) => bar(busy ? null : 0.1 + (progress || 0) * 0.3, text));
      const n = Object.values(lesson.words).reduce((a, w) => a + w.length, 0);
      mark('subs', n ? 'ok' : 'warn', n ? `${n} palavras` : 'nenhuma fala reconhecida');
    } catch (e) {
      console.error(e);
      warn.push('legenda');
      mark('subs', 'warn', 'não foi possível agora — dá para criar depois no editor');
    }

    const hasWords = Object.values(lesson.words).some((w) => w.length);
    if (smp && hasWords) {
      mark('review', 'run');
      try {
        const n = await aiReviewLesson(lesson, client, smp, ({ text, progress }) => bar(0.75 + (progress || 0) * 0.15, text));
        mark('review', 'ok', n ? `${pl(n, 'frase corrigida', 'frases corrigidas')}` : 'nada a corrigir');
      } catch (e) { mark('review', 'skip', 'IA indisponível agora'); }
    } else mark('review', 'skip', hasWords ? 'disponível só na versão online' : 'sem legenda');

    mark('keys', 'run'); bar(0.92, 'Criando destaques…');
    if (hasWords) {
      const n = keywordsAndCards(lesson, client);
      mark('keys', 'ok', n ? `${pl(n, 'destaque', 'destaques')}: ${client.keywords.slice(0, 4).join(', ')}` : 'nenhuma palavra-chave falada');
    } else mark('keys', 'skip', 'precisa da legenda');

    if (smp && hasWords) {
      mark('desc', 'run'); bar(0.96, 'Escrevendo a descrição…');
      try { lesson.description = await describeLesson(smp, client, course, lesson); mark('desc', 'ok'); }
      catch { mark('desc', 'skip'); }
    } else mark('desc', 'skip');
    save();
    bar(1, 'Pronto!');
  } catch (e) {
    console.error(e);
    toast(e.message, 'err');
    view.querySelector('.steps .run')?.classList.replace('run', 'err');
    bar(0, e.message);
    try { lock?.release(); } catch {}
    return;
  }
  try { lock?.release(); } catch {}
  toast('Aula editada!', 'ok');
  viewReady(course, lesson.id, true);
  addBack();
}

async function describeLesson(smp, client, course, lesson) {
  const text = timelineCaptions(lesson).map((c) => c.text).join(' ');
  const r = await smp(`Escreva a descrição de uma aula de curso online para a área de membros (Hotmart/Eduzz/Sympla).
Expert: ${client.name}, ${client.specialty || 'médico(a)'}. Curso: ${course.title}. Aula: ${lesson.title}.
Tom: profissional, acolhedor, claro para leigos, sem promessas de cura e respeitando as normas de publicidade médica do CFM.${briefOf(client)}
Formato: 1 frase de abertura + 3 tópicos curtos com "•" sobre o que o aluno vai aprender. Máximo 90 palavras. Responda só com o texto.
Transcrição:
${text.slice(0, 12000)}`, { modelTier: 'quick' });
  return r.text.trim();
}

// ======================= Aula pronta: prévia + exportar =======================
async function viewReady(course, lessonId, fresh = false) {
  const { lesson } = findLesson(course, lessonId);
  if (!lesson) return go('#/');
  const client = getClient(course.clientId);
  const raw = rawDur(lesson), d = lessonDur(lesson);
  const nWords = Object.values(lesson.words).reduce((a, w) => a + w.length, 0);
  let platform = lesson.platform || client.platform;
  view.innerHTML = `
    <header class="page-head"><div><p class="eyebrow"><a href="#/">Início</a> / ${esc(client.name)}</p><h1>${esc(lesson.title)}</h1></div></header>
    ${fresh ? '<p class="banner ok-banner">Pronto! Confira a prévia e toque em <b>Gerar vídeo final</b>.</p>' : ''}
    <div class="ready">
      <div class="stage">
        <div class="canvas-wrap ${PLATFORMS[platform]?.h > PLATFORMS[platform]?.w ? 'vertical' : ''}"><canvas id="rPrev" ${PLATFORMS[platform]?.h > PLATFORMS[platform]?.w ? 'width="720" height="1280"' : 'width="1280" height="720"'}></canvas></div>
        <div class="transport"><button class="play" id="rPlay" aria-label="Reproduzir">▶</button><span class="time" id="rTime"></span></div>
      </div>
      <section class="panel">
        <ul class="facts">
          <li><b>${fmtLong(d)}</b><span>${raw > d + 1 ? `−${Math.round((1 - d / raw) * 100)}% de ${fmtLong(raw)}` : 'duração'}</span></li>
          <li><b>${lesson.clips.length}</b><span>cortes</span></li>
          <li><b>${nWords ? '✓' : '—'}</b><span>legenda</span></li>
          <li><b>${lesson.cards.length}</b><span>destaques</span></li>
        </ul>
        <div class="row-2">
          <label>Plataforma<select id="rPlat">${Object.entries(PLATFORMS).map(([k, v]) => `<option value="${k}" ${k === platform ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select></label>
          <div class="sfx-line"><label class="check"><input type="checkbox" id="rSfx" ${client.sfx ? 'checked' : ''}> Efeitos sonoros</label><button class="ghost small" id="rHear" type="button">▶ Ouvir</button></div>
        </div>
        <div id="rOut"></div>
        <div class="btn-row split"><a class="ghost btn-ghost" href="#/aula/${course.id}/${lesson.id}">✂ Ajustar cortes e legenda</a><a class="ghost btn-ghost" href="#/novo">+ Editar outro vídeo</a></div>
        <details class="grp" open><summary><b>💬 Pedir ajuste ao Claude</b><small>escreva o que quer mudar</small></summary><div class="grp-body">${chatHTML()}</div></details>
        <details class="grp"><summary><b>🎨 Estilo do vídeo</b><small>modelos, cores, legenda</small></summary><div class="grp-body"><div id="rStyle" class="style-panel"></div></div></details>
        <details class="grp"><summary><b>🎵 Trilha sonora</b><small>${esc(TRACKS[client.music || 'nenhuma']?.name || '')}</small></summary><div class="grp-body" id="rMusic">${musicBlock(client)}</div></details>
        <details class="grp"><summary><b>🖼 Capa da aula</b><small>miniatura para a plataforma</small></summary><div class="grp-body">
          <canvas id="rCover" class="cover-prev" width="1280" height="720"></canvas>
          <p class="hint">A capa usa o momento atual da prévia. Avance o vídeo até um bom quadro do expert e toque em “Usar este momento”.</p>
          <div class="btn-row"><button class="ghost" id="rCoverNow" type="button">Usar este momento</button><button class="btn" id="rCoverDl" type="button">Baixar capa (PNG)</button></div>
        </div></details>
        <details class="grp"><summary><b>📱 Reels de divulgação</b><small>o melhor trecho, na vertical</small></summary><div class="grp-body">
          <p class="hint">O app escolhe o trecho mais forte da aula (30 a 60 s), cria uma versão vertical 9:16 com legenda e destaques, pronta para Instagram, TikTok e Shorts.</p>
          <button class="btn" id="rReels" type="button">Criar Reels com o melhor trecho</button>
        </div></details>
        <details class="grp"><summary><b>📝 Descrição e capítulos</b><small>para a plataforma</small></summary><div class="grp-body">
          ${lesson.description ? `<p class="desc">${esc(lesson.description).replace(/\n/g, '<br>')}</p><button class="ghost small" id="rCopy">Copiar descrição</button>` : '<p class="hint">Sem descrição ainda (precisa da legenda).</p>'}
          <h3>Capítulos</h3>
          <pre class="chapters" id="rChap">${esc(lesson.chapters || 'Toque em “Gerar capítulos” para criar a lista com horários (YouTube, Hotmart e Vimeo usam).')}</pre>
          <div class="btn-row"><button class="ghost small" id="rChapGo" type="button">Gerar capítulos</button>${lesson.chapters ? '<button class="ghost small" id="rChapCopy" type="button">Copiar capítulos</button>' : ''}</div>
        </div></details>
      </section>
    </div>`;
  const player = new Player($('#rPrev'));
  player.meta = { module: course.modules.find((m) => m.lessons.includes(lesson))?.title };
  editor = { player };
  await document.fonts.ready;
  await player.setLesson(lesson, client);
  const pb = $('#rPlay'), tl = $('#rTime');
  player.onTime = (T) => { tl.textContent = `${fmt(T)} / ${fmt(player.duration)}`; pb.textContent = player.playing ? '❚❚' : '▶'; };
  player.onTime(0);
  pb.onclick = () => { if (player.playing) player.stop(); else player.play(); pb.textContent = player.playing ? '❚❚' : '▶'; };
  const vert = (k) => PLATFORMS[k].h > PLATFORMS[k].w;
  $('#rPlat').onchange = (e) => {
    const was = vert(platform);
    platform = e.target.value;
    lesson.platform = platform; save();
    if (vert(platform) !== was) { player.stop(); viewReady(course, lesson.id); addBack(); return; } // muda a prévia para vertical/horizontal
    drawOut();
  };
  const restyle = () => { lesson.render = null; save(); player.invalidate(); player.draw(); drawOut(); };
  const sp = $('#rStyle');
  sp.innerHTML = stylePanelHTML(client);
  bindStylePanel(sp, client, player, restyle);
  bindChat(view, { client, lesson, course, player, refresh: () => { sp.innerHTML = stylePanelHTML(client); bindStylePanel(sp, client, player, restyle); drawOut(); } });
  $('#rSfx').onchange = (e) => { client.sfx = e.target.checked; lesson.render = null; save(); drawOut(); };
  $('#rHear').onclick = (e) => { e.preventDefault(); player.ensureAudio(); playSfx(player.ctx, player.sfxBus, 'whoosh', client.sfxVol ?? 0.5); playSfx(player.ctx, player.sfxBus, 'pop', (client.sfxVol ?? 0.5) * 0.6, 0.18); };
  $('#rCopy') && ($('#rCopy').onclick = () => navigator.clipboard?.writeText(lesson.description).then(() => toast('Descrição copiada', 'ok'), () => toast('Selecione o texto e copie.')));
  bindMusic($('#rMusic'), client, () => { lesson.render = null; save(); drawOut(); });

  // ---- capa ----
  let coverFrame = null, coverAt = null;
  const coverOpts = () => ({ title: lesson.title, module: course.auto ? '' : course.modules.find((m) => m.lessons.includes(lesson))?.title || '' });
  const drawCv = () => drawCover($('#rCover'), coverFrame, client, coverOpts());
  async function grabAt(T) {
    if (!lesson.clips.length) return;
    const i = player.clipAt(T), c = lesson.clips[i];
    const { grabFrame } = await import('./render-offline.js');
    coverFrame = await grabFrame(lesson, c.srcId, c.in + (T - player.starts[i])).catch((e) => { console.warn(e); return null; });
    coverAt = T;
    drawCv();
  }
  drawCv();
  view.querySelector('#rCover').closest('details').addEventListener('toggle', (e) => { if (e.target.open && coverAt == null) grabAt(Math.min(player.duration * 0.15, 6)); });
  $('#rCoverNow').onclick = () => grabAt(player.T);
  $('#rCoverDl').onclick = async () => {
    if (coverAt == null) await grabAt(Math.min(player.duration * 0.15, 6));
    const big = document.createElement('canvas'); big.width = 1280; big.height = 720;
    drawCover(big, coverFrame, client, coverOpts());
    big.toBlob((b) => download(b, `capa-${slug(lesson.title)}.png`), 'image/png');
  };

  // ---- reels ----
  $('#rReels').onclick = async () => {
    const btn = $('#rReels');
    if (!lesson.clips.length) return toast('A aula não tem vídeo.');
    btn.disabled = true; btn.textContent = 'Escolhendo o melhor trecho…';
    try {
      const pick = await pickHighlight(lesson, client, await cap('sample'));
      const r = sliceLesson(lesson, pick.a, pick.b, pick.title);
      const mod = course.modules.find((m) => m.lessons.includes(lesson));
      mod.lessons.splice(mod.lessons.indexOf(lesson) + 1, 0, r);
      save();
      toast(`Reels criado: ${fmtLong(pick.b - pick.a)} a partir de ${fmt(pick.a)}`, 'ok');
      go(`#/pronto/${course.id}/${r.id}`);
    } catch (e) { console.error(e); toast('Não foi possível criar o Reels: ' + e.message, 'err'); btn.disabled = false; btn.textContent = 'Criar Reels com o melhor trecho'; }
  };

  // ---- capítulos ----
  $('#rChapGo').onclick = async () => {
    const btn = $('#rChapGo');
    btn.disabled = true; btn.textContent = 'Criando…';
    try {
      const txt = await makeChapters(lesson, await cap('sample'), client);
      if (!txt) { toast('Os capítulos precisam da legenda da aula.'); return; }
      lesson.chapters = txt; save();
      $('#rChap').textContent = txt;
      if (!$('#rChapCopy')) btn.insertAdjacentHTML('afterend', '<button class="ghost small" id="rChapCopy" type="button">Copiar capítulos</button>');
      $('#rChapCopy').onclick = copyChap;
      toast('Capítulos criados', 'ok');
    } finally { btn.disabled = false; btn.textContent = 'Gerar capítulos'; }
  };
  const copyChap = () => navigator.clipboard?.writeText(lesson.chapters).then(() => toast('Capítulos copiados', 'ok'), () => toast('Selecione o texto e copie.'));
  $('#rChapCopy') && ($('#rChapCopy').onclick = copyChap);

  const base = slug(lesson.title);
  function drawOut() {
    const r = lesson.render;
    const same = r && r.platform === platform;
    $('#rOut').innerHTML = same
      ? `<div class="render-ok"><b>✓ Vídeo final pronto</b> · ${mb(r.size)} · ${r.ext.toUpperCase()}
          <div class="btn-row"><button class="btn" id="rDl">Baixar vídeo</button>${nWords ? '<button class="ghost" id="rSrt">Baixar legenda</button>' : ''}</div></div>`
      : `<button class="btn big full" id="rGo">Gerar vídeo final</button>
         <p class="hint">${Math.min(PLATFORMS[platform].w, PLATFORMS[platform].h) >= 2160 ? '4K' : Math.min(PLATFORMS[platform].w, PLATFORMS[platform].h) + 'p'}${PLATFORMS[platform].h > PLATFORMS[platform].w ? ' vertical' : ''} · ${PLATFORMS[platform].fps} fps · leva o mesmo tempo da aula (${fmtLong(d)}). Deixe a tela ligada. ${esc(PLATFORMS[platform].note)}</p>
         <div class="progress" id="rProg" hidden><span></span><em></em></div>`;
    if (same) {
      $('#rDl').onclick = async () => download(await db.getBlob(r.mediaId), `${base}.${r.ext}`);
      $('#rSrt') && ($('#rSrt').onclick = () => download(new Blob([srt(timelineCaptions(lesson))], { type: 'text/plain' }), base + '.srt'));
      return;
    }
    $('#rGo').onclick = async () => {
      const prog = $('#rProg'), bar = prog.querySelector('span'), lbl = prog.querySelector('em');
      prog.hidden = false; $('#rGo').disabled = true;
      let lock = null;
      try { lock = await navigator.wakeLock?.request('screen'); } catch {}
      try {
        const blob = await renderLesson(player, PLATFORMS[platform], { onProgress: (f) => { bar.style.width = (f * 100).toFixed(1) + '%'; lbl.textContent = `Gerando ${Math.round(f * 100)}%`; } });
        const mediaId = 'render:' + lesson.id;
        db.keep(mediaId, blob);
        lesson.render = { mediaId, size: blob.size, ext: extOf(blob), platform, at: Date.now(), dur: lessonDur(lesson) };
        save();
        toast('Vídeo final pronto!', 'ok');
      } catch (e) { toast('Erro ao gerar: ' + e.message, 'err'); }
      try { lock?.release(); } catch {}
      drawOut();
    };
  }
  drawOut();
}

// ======================= Trilha, Reels e capítulos =======================
const musicBlock = (c) => `
  <label>Trilha<select data-music>${Object.entries(TRACKS).map(([k, t]) => `<option value="${k}" ${k === (c.music || 'nenhuma') ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
  <label>Volume da trilha <output>${Math.round((c.musicVol ?? 0.35) * 100)}%</output><input type="range" data-music-vol min="0.05" max="1" step="0.05" value="${c.musicVol ?? 0.35}"></label>
  <div class="btn-row"><button class="ghost small" data-music-hear type="button">▶ Ouvir a trilha</button></div>
  <p class="hint">Composta pelo próprio app: sem direitos autorais. Fica baixinha sob a voz e entra e sai suave.</p>`;
let musicPrev = null;
function bindMusic(root, c, onChange) {
  if (!root) return;
  const sel = root.querySelector('[data-music]'), vol = root.querySelector('[data-music-vol]'), hear = root.querySelector('[data-music-hear]');
  sel.onchange = () => { c.music = sel.value; save(); onChange?.(); if (c.music !== 'nenhuma') buildMusic(c.music); const sm = root.closest('details')?.querySelector('summary small'); if (sm) sm.textContent = TRACKS[c.music].name; };
  vol.oninput = () => { c.musicVol = parseFloat(vol.value); vol.parentElement.querySelector('output').textContent = Math.round(c.musicVol * 100) + '%'; save(); onChange?.(); };
  hear.onclick = async () => {
    if (musicPrev) { musicPrev.stop(); musicPrev = null; hear.textContent = '▶ Ouvir a trilha'; return; }
    if (!c.music || c.music === 'nenhuma') return toast('Escolha uma trilha primeiro.');
    previewCtx = previewCtx || new (window.AudioContext || window.webkitAudioContext)();
    previewCtx.resume();
    hear.textContent = 'Compondo…';
    const buf = await buildMusic(c.music);
    if (!buf) { hear.textContent = '▶ Ouvir a trilha'; return toast('Este navegador não consegue tocar a trilha.'); }
    const src = previewCtx.createBufferSource(), g = previewCtx.createGain();
    src.buffer = buf; g.gain.value = Math.min(1, (c.musicVol ?? 0.35) * 1.3);
    src.connect(g).connect(previewCtx.destination); src.start(); src.stop(previewCtx.currentTime + 10);
    musicPrev = src; hear.textContent = '■ Parar';
    src.onended = () => { if (musicPrev === src) { musicPrev = null; hear.textContent = '▶ Ouvir a trilha'; } };
  };
}

// Escolhe o trecho mais forte (30–60 s) da aula editada: com a IA quando disponível; senão, pelas palavras-chave.
async function pickHighlight(lesson, client, smp) {
  const caps = timelineCaptions(lesson), D = lessonDur(lesson);
  const firstWords = (t) => t.split(/\s+/).slice(0, 7).join(' ');
  if (D <= 65 || !caps.length) return { a: 0, b: Math.min(D, 60), title: lesson.title };
  if (smp) {
    try {
      const list = caps.map((c, i) => `${i}|${Math.round(c.s)}s|${c.text}`).join('\n').slice(0, 40000);
      const r = await smp(`Você edita aulas de ${client.name} (${client.specialty || 'saúde'}). Escolha o MELHOR trecho contínuo para um Reels de divulgação: 30 a 60 segundos, que faça sentido sozinho, comece com uma frase que prenda a atenção e termine numa frase completa. Respeite as normas de publicidade médica do CFM (nada de promessa de cura ou resultado).${briefOf(client)}
Frases da aula (índice|início|texto):
${list}
Responda só com JSON: {"inicio": índice da primeira frase, "fim": índice da última frase, "titulo": "título curto e chamativo, até 6 palavras"}`, { modelTier: 'quick' });
      const j = JSON.parse((r.text.match(/\{[\s\S]*\}/) || ['{}'])[0]);
      const i = Number(j.inicio), k = Number(j.fim);
      if (caps[i] && caps[k] && k >= i) {
        const a = caps[i].s, b = caps[k].e;
        if (b - a >= 15 && b - a <= 80) return { a: Math.max(0, a - 0.15), b: Math.min(D, b + 0.35), title: String(j.titulo || '').slice(0, 60) || firstWords(caps[i].text) };
      }
    } catch (e) { console.warn('IA do Reels indisponível, usando escolha automática', e); }
  }
  const kws = client.keywords.map(norm);
  let best = null;
  for (let i = 0; i < caps.length; i++) {
    if (i > 0 && !/[.!?…]$/.test(caps[i - 1].text.trim())) continue; // começa no início de uma frase
    let k = i;
    while (k + 1 < caps.length && caps[k + 1].e - caps[i].s <= 58) k++;
    const dur = caps[k].e - caps[i].s;
    if (dur < 25) continue;
    const text = norm(caps.slice(i, k + 1).map((c) => c.text).join(' '));
    const words = text.split(' ').length;
    const score = kws.reduce((a, w) => a + (w && text.includes(w) ? 3 : 0), 0) + words / dur;
    if (!best || score > best.score) best = { score, i, k };
  }
  if (!best) return { a: 0, b: Math.min(D, 60), title: lesson.title };
  return { a: Math.max(0, caps[best.i].s - 0.15), b: Math.min(D, caps[best.k].e + 0.35), title: firstWords(caps[best.i].text) };
}

// Nova aula com só o trecho [a, b] da linha do tempo (usa as mesmas gravações, sem duplicar arquivos).
function sliceLesson(lesson, a, b, title) {
  const r = newLesson('Reels — ' + (title || lesson.title));
  r.sources = lesson.sources.map((s) => ({ ...s }));
  r.words = JSON.parse(JSON.stringify(lesson.words));
  r.cards = lesson.cards.map((k) => ({ ...k, id: uid('card') }));
  r.clips = [];
  let acc = 0;
  for (const c of lesson.clips) {
    const d = c.out - c.in, s0 = Math.max(a, acc), s1 = Math.min(b, acc + d);
    if (s1 - s0 > 0.05) r.clips.push({ ...c, id: uid('clip'), in: c.in + (s0 - acc), out: c.in + (s1 - acc) });
    acc += d;
  }
  r.platform = 'reels';
  r.reelsOf = lesson.id;
  r.description = lesson.description;
  return r;
}

// Capítulos com horário (formato aceito pelo YouTube e por players como Vimeo/Panda).
async function makeChapters(lesson, smp, client) {
  const caps = timelineCaptions(lesson), D = lessonDur(lesson);
  if (!caps.length) return null;
  const mmss = (t) => { t = Math.max(0, Math.round(t)); const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60; return (h ? h + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + String(s).padStart(2, '0'); };
  const n = Math.max(2, Math.min(8, Math.round(D / 90)));
  if (smp) {
    try {
      const list = caps.map((c, i) => `${i}|${mmss(c.s)}|${c.text}`).join('\n').slice(0, 40000);
      const r = await smp(`Divida esta aula em ${n} capítulos (no máximo 8) pelos assuntos. O primeiro começa na frase 0. Títulos curtos (até 6 palavras), claros para leigos, em português.${briefOf(client)}
Frases (índice|horário|texto):
${list}
Responda só com JSON: [{"frase": índice, "titulo": "..."}]`, { modelTier: 'quick' });
      const arr = JSON.parse((r.text.match(/\[[\s\S]*\]/) || ['[]'])[0]);
      const ok = arr.filter((x) => caps[Number(x.frase)] && x.titulo).sort((x, y) => x.frase - y.frase);
      if (ok.length >= 2) { ok[0].frase = 0; return ok.map((x) => `${mmss(Number(x.frase) === 0 ? 0 : caps[Number(x.frase)].s)} ${String(x.titulo).trim()}`).join('\n'); }
    } catch (e) { console.warn('IA dos capítulos indisponível', e); }
  }
  // sem IA: divide em partes iguais e dá a cada parte o nome da palavra-chave mais falada nela
  // (o texto cru da transcrição pode ter palavras erradas, então não vira título)
  const fold = (x) => String(x).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const kws = (client?.keywords || []).filter(Boolean);
  const cap1 = (x) => x.charAt(0).toUpperCase() + x.slice(1);
  const out = [], used = new Set();
  for (let k = 0; k < n; k++) {
    const t0 = (D * k) / n, t1 = (D * (k + 1)) / n;
    const c = caps.find((x) => x.s >= t0 - 0.01) || caps[caps.length - 1];
    const txt = fold(caps.filter((x) => x.s >= t0 - 0.01 && x.s < t1).map((x) => x.text).join(' '));
    let best = null, bestN = 0;
    for (const w of kws) { if (used.has(w)) continue; const m = txt.split(fold(w)).length - 1; if (m > bestN) { best = w; bestN = m; } }
    if (best) used.add(best);
    const title = k === 0 ? 'Introdução' : best ? cap1(best) : `Parte ${k + 1}`;
    out.push(`${mmss(k === 0 ? 0 : c.s)} ${title}`);
  }
  return out.join('\n');
}

// ---- Estúdio de Marketing (Notion ao vivo) ----
function mktPanel(c) {
  const m = c.mkt;
  const row = (k, v) => (v ? `<div class="mkt-row"><dt>${k}</dt><dd>${esc(v)}</dd></div>` : '');
  return `<div class="mkt" id="mktBox">
    <div class="mkt-head"><h2>Estúdio de Marketing</h2><span class="mkt-pill" data-mkt-state="${mkt.state}">${esc(mkt.text)}</span></div>
    ${m ? `<dl class="mkt-list">${row('Tom de voz', m.tom)}${row('Público', m.publico)}${row('Nunca usar', m.proibidas)}${row('Particularidades', m.notas)}${row('Instagram', m.instagram)}</dl>
      <p class="hint">Vem da tabela de clientes no Notion e é usado pela IA nas legendas, descrições, capítulos, Reels e no chat.${m.at ? ` Atualizado em ${new Date(m.at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}.` : ''}</p>`
      : `<p class="hint">Este cliente ainda não está na tabela do Estúdio de Marketing. Peça ao ChatGPT: “preencha ${esc(c.name)} na tabela Clientes — estilos e particularidades do Notion”. As cores, o modelo e as particularidades entram aqui sozinhos.</p>`}
    <div class="btn-row"><button class="ghost small" id="mktNow" type="button">Atualizar agora</button><a class="ghost btn-ghost small" href="${m?.url || MKT_URL}" target="_blank" rel="noopener">Abrir no Notion</a></div>
  </div>`;
}
function bindMktPanel(c) {
  const box = $('#mktBox'); if (!box) return;
  const pill = $('.mkt-pill', box);
  const off = onMkt((s) => { if (!document.body.contains(pill)) return off(); pill.textContent = s.text; pill.dataset.mktState = s.state; });
  $('#mktNow', box).onclick = () => refreshMarketing(onMktChange);
}
function onMktChange(list) {
  const names = list.map((x) => x.client.name);
  toast(list.some((x) => x.isNew) && list.length === 1 ? `Novo cliente do Estúdio de Marketing: ${names[0]}` : `Perfil atualizado do Estúdio de Marketing: ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`, 'ok');
  // só redesenha telas de cadastro; no editor, só atualiza a lista e a prévia (sem perder a posição)
  if (!busyWork() && (cur === '#/' || cur === '' || cur.startsWith('#/cliente/'))) route();
  else { renderSidebar(); try { editor?.player?.draw(); } catch {} }
}

// ======================= Cliente =======================
function viewClient(c) {
  const courses = state.courses.filter((k) => k.clientId === c.id);
  view.innerHTML = `
    <header class="page-head">
      <div><p class="eyebrow">Perfil do cliente</p><h1>${esc(c.name)}</h1></div>
      <div class="actions"><button class="ghost danger" id="delClient">Excluir cliente</button></div>
    </header>
    <div class="two-col">
      <section class="panel">
        <h2>Identidade</h2>
        <div class="form">
          ${field('name', 'Nome do expert', c.name)}
          ${field('specialty', 'Especialidade', c.specialty, 'Ex.: Cardiologia')}
          ${field('crm', 'Registro (CRM/RQE)', c.crm, 'CRM-SP 123456')}
          <div class="row3">
            ${color('primary', 'Cor principal', c.primary)}
            ${color('accent', 'Cor de destaque', c.accent)}
            ${color('text', 'Texto sobre a cor', c.text)}
          </div>
          <label>Logo / assinatura
            <div class="logo-row">
              <span class="logo-prev" id="logoPrev"></span>
              <input type="file" accept="image/*" id="logoInput">
            </div>
          </label>
        </div>
        <h2>Palavras-chave do expert</h2>
        <p class="hint">Aparecem destacadas na legenda e em cartões animados ao lado do expert.</p>
        <div class="chips" id="kwChips"></div>
        <form id="kwForm" class="inline"><input id="kwInput" placeholder="Adicionar palavra-chave e Enter"><button>Adicionar</button></form>
        ${mktPanel(c)}
      </section>
      <section class="panel">
        <h2>Estilo do vídeo</h2>
        <div class="style-panel" id="cStyle"></div>
        <div class="form">
          ${select('platform', 'Plataforma padrão', c.platform, Object.fromEntries(Object.entries(PLATFORMS).map(([k, v]) => [k, v.name])))}
          <details class="grp"><summary><b>Ritmo dos cortes secos</b><small>avançado</small></summary><div class="grp-body">
            ${range('silenceDb', 'Limiar de silêncio (dB)', c.silenceDb, -60, -20, 1)}
            ${range('minSilence', 'Pausa mínima para cortar (s)', c.minSilence, 0.15, 1.5, 0.05)}
            ${range('padding', 'Respiro em cada corte (s)', c.padding, 0, 0.3, 0.01)}
          </div></details>
        </div>
      </section>
    </div>
    <h2 class="section-title">Cursos</h2>
    <section class="grid">
      ${courses.map((k) => `<a class="card" href="#/curso/${k.id}"><h3>${esc(k.title)}</h3>
        <p class="muted">${pl(k.modules.length, 'módulo', 'módulos')} · ${pl(k.modules.reduce((a, m) => a + m.lessons.length, 0), 'aula', 'aulas')}</p></a>`).join('')}
      <button class="card add-card" id="newCourse">+ Novo curso</button>
    </section>`;

  const cStyle = $('#cStyle');
  cStyle.innerHTML = stylePanelHTML(c);
  bindStylePanel(cStyle, c, null, () => renderSidebar());
  bindForm(view.querySelector('.two-col > .panel'), c, () => { renderSidebar(); $('h1').textContent = c.name; });
  view.querySelectorAll('.two-col > .panel:last-child > .form [data-k]').forEach((el) => el.addEventListener('input', () => { c[el.dataset.k] = el.type === 'range' ? parseFloat(el.value) : el.value; const o = el.parentElement.querySelector('output'); if (o) o.textContent = el.value; save(); }));
  showLogo(c);
  $('#logoInput').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const id = uid('logo');
    await db.putMedia(id, f);
    c.logoMediaId = id;
    save();
    window.dispatchEvent(new Event('ec-media-added'));
    showLogo(c);
  };
  chipEditor($('#kwChips'), $('#kwForm'), c);
  $('#newCourse').onclick = () => { const k = newCourse(c.id); state.courses.push(k); save(); go('#/curso/' + k.id); };
  bindMktPanel(c);
  $('#delClient').onclick = async () => {
    if (!(await ask(`Excluir ${c.name} e todos os seus cursos?`))) return;
    state.courses = state.courses.filter((k) => k.clientId !== c.id);
    state.clients = state.clients.filter((x) => x !== c);
    save();
    go('#/');
  };
}

async function showLogo(c) {
  const el = $('#logoPrev');
  if (!el) return;
  if (!c.logoMediaId) { el.textContent = 'sem logo'; return; }
  const b = await db.getMedia(c.logoMediaId);
  el.innerHTML = b ? `<img src="${URL.createObjectURL(b)}" alt="">` : 'sem logo';
}

function chipEditor(box, form, c, onChange = () => {}) {
  const draw = () => {
    box.innerHTML = c.keywords.map((k, i) => `<span class="chip">${esc(k)}<button data-i="${i}" aria-label="remover">×</button></span>`).join('') || '<span class="muted">Nenhuma palavra-chave ainda.</span>';
  };
  box.onclick = (e) => { const i = e.target.dataset.i; if (i !== undefined) { c.keywords.splice(+i, 1); save(); draw(); onChange(); } };
  form.onsubmit = (e) => {
    e.preventDefault();
    const inp = form.querySelector('input');
    for (const k of inp.value.split(',').map((s) => s.trim()).filter(Boolean)) if (!c.keywords.includes(k)) c.keywords.push(k);
    inp.value = '';
    save(); draw(); onChange();
  };
  draw();
  return draw;
}

// Bloco de efeitos sonoros com prévia ("Ouvir")
const sfxBlock = (c) => `
  <h3>Efeitos sonoros</h3>
  ${check('sfx', 'Efeitos sonoros (whoosh nos destaques, sino na abertura)', c.sfx)}
  ${range('sfxVol', 'Volume dos efeitos', c.sfxVol ?? 0.5, 0, 1, 0.05)}
  <div class="btn-row sfx-row">${Object.entries(SFX).map(([k, v]) => `<button class="ghost small" data-sfx="${k}" type="button">▶ Ouvir ${esc(v.name.split(' (')[0])}</button>`).join('')}</div>`;
let previewCtx;
function bindSfxPreview(root, client, player) {
  root.querySelectorAll('[data-sfx]').forEach((b) => (b.onclick = () => {
    let ctx, out;
    if (player) { player.ensureAudio(); ctx = player.ctx; out = player.sfxBus; }
    else { previewCtx = previewCtx || new (window.AudioContext || window.webkitAudioContext)(); previewCtx.resume(); ctx = previewCtx; out = ctx.destination; }
    playSfx(ctx, out, b.dataset.sfx, client.sfxVol ?? 0.5);
  }));
}

// helpers de formulário
const field = (k, label, v, ph = '') => `<label>${label}<input data-k="${k}" value="${esc(v)}" placeholder="${esc(ph)}"></label>`;
const color = (k, label, v) => `<label>${label}<input type="color" data-k="${k}" value="${esc(v)}"></label>`;
const select = (k, label, v, opts) => `<label>${label}<select data-k="${k}">${Object.entries(opts).map(([o, n]) => `<option value="${o}" ${o === v ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>`;
const check = (k, label, v) => `<label class="check"><input type="checkbox" data-k="${k}" ${v ? 'checked' : ''}> ${label}</label>`;
const range = (k, label, v, min, max, step) => `<label>${label} <output>${v}</output><input type="range" data-k="${k}" value="${v}" min="${min}" max="${max}" step="${step}"></label>`;

function bindForm(root, obj, onChange) {
  root.querySelectorAll('[data-k]').forEach((el) => {
    el.addEventListener('input', () => {
      const k = el.dataset.k;
      obj[k] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? parseFloat(el.value) : el.value;
      const out = el.parentElement.querySelector('output');
      if (out) out.textContent = el.value;
      save();
      onChange?.(k);
    });
  });
}

// ======================= Curso =======================
function viewCourse(course) {
  const c = getClient(course.clientId);
  const draw = () => {
    view.innerHTML = `
      <header class="page-head">
        <div><p class="eyebrow"><a href="#/cliente/${c.id}">${esc(c.name)}</a> / Curso</p>
          <h1 contenteditable="true" spellcheck="false" id="courseTitle">${esc(course.title)}</h1></div>
        <div class="actions">
          <button class="ghost danger" id="delCourse">Excluir</button>
          <a class="btn" href="#/exportar/${course.id}">Exportar curso</a>
        </div>
      </header>
      <label class="block">Descrição do curso (vai para a página de vendas)
        <textarea id="courseDesc" rows="3" placeholder="Para quem é, o que vai aprender, diferenciais…">${esc(course.description)}</textarea></label>
      <div class="modules">
        ${course.modules.map((m, mi) => `
          <section class="module" data-mi="${mi}">
            <div class="module-head">
              <span class="num">${String(mi + 1).padStart(2, '0')}</span>
              <input class="title-input" data-mod-title value="${esc(m.title)}">
              <div class="mini">
                <button data-act="mup" title="Subir">↑</button><button data-act="mdown" title="Descer">↓</button>
                <button data-act="mdel" title="Excluir módulo">×</button>
              </div>
            </div>
            <ul class="lessons">
              ${m.lessons.map((l, li) => {
                const d = lessonDur(l), r = rawDur(l);
                const hasSubs = Object.values(l.words).some((w) => w.length);
                return `<li data-li="${li}">
                  <span class="num">${mi + 1}.${li + 1}</span>
                  <input class="title-input" data-les-title value="${esc(l.title)}">
                  <span class="tags">
                    ${l.sources.length ? `<span class="tag">${fmtLong(d)}${r > d + 1 ? ` <s>${fmtLong(r)}</s>` : ''}</span>` : '<span class="tag muted">sem vídeo</span>'}
                    ${hasSubs ? '<span class="tag ok">legenda</span>' : ''}
                    ${l.cards.length ? `<span class="tag ok">${l.cards.length} destaques</span>` : ''}
                    ${l.render ? '<span class="tag ok strong">renderizada</span>' : ''}
                  </span>
                  <div class="mini">
                    <button data-act="lup">↑</button><button data-act="ldown">↓</button><button data-act="ldel">×</button>
                  </div>
                  <a class="btn small" href="#/aula/${course.id}/${l.id}">Editar</a>
                </li>`;
              }).join('')}
            </ul>
            <button class="ghost small" data-act="ladd">+ Aula</button>
          </section>`).join('')}
      </div>
      <button class="ghost" id="addModule">+ Módulo</button>`;

    $('#courseTitle').oninput = (e) => { course.title = e.target.textContent.trim(); save(); };
    $('#courseDesc').oninput = (e) => { course.description = e.target.value; save(); };
    $('#addModule').onclick = () => { course.modules.push(newModule(`Módulo ${course.modules.length + 1}`)); save(); draw(); };
    $('#delCourse').onclick = async () => { if (await ask('Excluir este curso e todas as aulas?')) { state.courses = state.courses.filter((k) => k !== course); save(); go('#/cliente/' + c.id); } };
    view.querySelectorAll('.module').forEach((sec) => {
      const m = course.modules[+sec.dataset.mi];
      sec.querySelector('[data-mod-title]').oninput = (e) => { m.title = e.target.value; save(); };
      sec.querySelectorAll('[data-les-title]').forEach((inp) => {
        const l = m.lessons[+inp.closest('li').dataset.li];
        inp.oninput = () => { l.title = inp.value; save(); };
      });
      sec.onclick = async (e) => {
        const act = e.target.dataset.act;
        if (!act) return;
        const mi = +sec.dataset.mi, li = +e.target.closest('li')?.dataset.li;
        const swap = (arr, i, j) => { if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; };
        if (act === 'mup') swap(course.modules, mi, mi - 1);
        if (act === 'mdown') swap(course.modules, mi, mi + 1);
        if (act === 'mdel' && await ask('Excluir este módulo e suas aulas?')) course.modules.splice(mi, 1);
        if (act === 'lup') swap(m.lessons, li, li - 1);
        if (act === 'ldown') swap(m.lessons, li, li + 1);
        if (act === 'ldel' && await ask('Excluir esta aula?')) m.lessons.splice(li, 1);
        if (act === 'ladd') m.lessons.push(newLesson(`Aula ${m.lessons.length + 1}`));
        save(); draw();
      };
    });
  };
  draw();
}

// ======================= Editor de aula =======================
async function viewEditor(course, lessonId) {
  const { module, lesson } = findLesson(course, lessonId);
  if (!lesson) return go('#/curso/' + course.id);
  const client = getClient(course.clientId);
  const mi = course.modules.indexOf(module), li = module.lessons.indexOf(lesson);

  view.innerHTML = `
    <div class="editor">
      <header class="ed-head">
        <div>
          <p class="eyebrow"><a href="#/cliente/${client.id}">${esc(client.name)}</a> / <a href="#/curso/${course.id}">${esc(course.title)}</a> / ${mi + 1}.${li + 1}</p>
          <input class="ed-title" id="lesTitle" aria-label="Título da aula" value="${esc(lesson.title)}">
        </div>
        <div class="actions">
          <span class="stat" id="durStat"></span>
          <button class="ghost" id="undoBtn" title="Ctrl+Z">Desfazer</button>
        </div>
      </header>
      <div class="ed-main">
        <div class="stage">
          <div class="canvas-wrap"><canvas id="preview" width="1280" height="720"></canvas></div>
          <div class="transport">
            <button class="play" id="playBtn" title="Espaço">▶</button>
            <span class="time" id="timeLbl">0:00.0 / 0:00.0</span>
            <span class="sep"></span>
            <button class="tool" data-tool="split" title="Dividir no cursor (S)">✂ Dividir</button>
            <button class="tool" data-tool="delete" title="Excluir clipe (Delete)">Excluir</button>
            <button class="tool" data-tool="trimIn" title="Cortar o início do clipe até o cursor ([)">⇤ Aparar</button>
            <button class="tool" data-tool="trimOut" title="Cortar do cursor até o fim do clipe (])">Aparar ⇥</button>
            <button class="tool" data-tool="zoom" title="Zoom do clipe (Z)">Zoom</button>
            <button class="tool" data-tool="left" title="Mover clipe para trás">◀</button>
            <button class="tool" data-tool="right" title="Mover clipe para frente">▶</button>
            <button class="tool" data-tool="card" title="Destaque no cursor (K)">+ Destaque</button>
          </div>
        </div>
        <aside class="inspector">
          <nav class="tabs">
            <button data-tab="cortes" class="on">Cortes</button>
            <button data-tab="legendas">Legendas</button>
            <button data-tab="destaques">Destaques</button>
            <button data-tab="visual">Estilo</button>
            <button data-tab="ajuste">Pedir ajuste</button>
            <button data-tab="exportar">Exportar</button>
          </nav>
          <div class="tab-body" id="tabBody"></div>
        </aside>
      </div>
      <div class="timeline-wrap">
        <div class="tl-bar">
          <span>Linha do tempo</span>
          <label class="tl-zoom">Zoom <input type="range" id="tlZoom" min="2" max="200" value="20"></label>
          <span class="muted small">Clique para posicionar · arraste as bordas do clipe para aparar · Espaço, S, Delete, Z, K</span>
        </div>
        <div class="tl-scroll" id="tlScroll"><canvas id="timeline" height="150"></canvas></div>
      </div>
    </div>`;

  const canvas = $('#preview');
  const player = new Player(canvas);
  player.meta = { module: module.title, course: course.title };
  const ed = editor = { course, lesson, client, player, sel: -1, pps: 20, undo: [] };

  $('#lesTitle').oninput = (e) => { lesson.title = e.target.value; save(); player.draw(); };

  // ---- histórico ----
  ed.snapshot = () => { ed.undo.push(JSON.stringify({ clips: lesson.clips, cards: lesson.cards, words: lesson.words })); if (ed.undo.length > 80) ed.undo.shift(); };
  ed.changed = () => { lesson.render = null; save(); player.invalidate(); player.draw(); drawTimeline(); updateStats(); };
  $('#undoBtn').onclick = () => undo();
  function undo() {
    const s = ed.undo.pop();
    if (!s) return toast('Nada para desfazer');
    Object.assign(lesson, JSON.parse(s));
    ed.changed();
    player.seek(player.T);
    renderTab();
  }

  function updateStats() {
    const d = lessonDur(lesson), r = rawDur(lesson);
    $('#durStat').innerHTML = r ? `<b>${fmtLong(d)}</b> editado · ${fmtLong(r)} bruto${r > d ? ` · <span class="ok">−${Math.round((1 - d / r) * 100)}%</span>` : ''}` : '';
    $('#timeLbl').textContent = `${fmt(player.T)} / ${fmt(player.duration)}`;
  }

  // ---- transporte ----
  const playBtn = $('#playBtn');
  player.onTime = () => { updateStats(); drawTimeline(); playBtn.textContent = player.playing ? '❚❚' : '▶'; followPlayhead(); };
  const togglePlay = () => { if (player.playing) { player.stop(); playBtn.textContent = '▶'; } else player.play().then(() => (playBtn.textContent = '▶')); playBtn.textContent = player.playing ? '❚❚' : '▶'; };
  playBtn.onclick = togglePlay;

  // ---- ferramentas ----
  function tool(t) {
    const clips = lesson.clips;
    const at = clips.length ? player.clipAt(player.T) : -1;
    const i = ed.sel >= 0 ? ed.sel : at;
    if (t === 'split') {
      if (at < 0) return;
      const c = clips[at], local = c.in + (player.T - player.starts[at]);
      if (local - c.in < 0.1 || c.out - local < 0.1) return toast('Cursor muito perto da borda do clipe');
      ed.snapshot();
      clips.splice(at, 1, { ...c, id: uid('clip'), out: local }, { ...c, id: uid('clip'), in: local });
      ed.sel = at + 1;
    } else if (t === 'trimIn' || t === 'trimOut') {
      if (at < 0) return;
      const c = clips[at], local = c.in + (player.T - player.starts[at]);
      if (local - c.in < 0.05 || c.out - local < 0.05) return toast('Posicione o cursor dentro do clipe');
      ed.snapshot();
      if (t === 'trimIn') { c.in = local; } else { c.out = local; }
      ed.sel = at;
      if (t === 'trimIn') player.T = player.starts[at];
    } else if (t === 'delete') {
      if (i < 0) return;
      ed.snapshot();
      clips.splice(i, 1);
      ed.sel = -1;
      player.seek(Math.min(player.T, Math.max(0, lessonDur(lesson) - 0.01)));
    } else if (t === 'zoom') {
      if (i < 0) return;
      ed.snapshot();
      const z = clips[i].zoom || 1;
      clips[i].zoom = z < 1.05 ? 1.15 : z < 1.2 ? 1.3 : 1;
      toast(`Zoom do clipe: ${Math.round(clips[i].zoom * 100)}%`);
    } else if (t === 'left' || t === 'right') {
      const j = t === 'left' ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= clips.length) return;
      ed.snapshot();
      [clips[i], clips[j]] = [clips[j], clips[i]];
      ed.sel = j;
    } else if (t === 'card') {
      if (at < 0) return;
      const c = clips[at], local = c.in + (player.T - player.starts[at]);
      const w = (lesson.words[c.srcId] || []).find((x) => x.e >= local);
      ed.snapshot();
      lesson.cards.push({ id: uid('card'), srcId: c.srcId, t: local, dur: 3, text: w ? w.w.replace(/[^\p{L}\p{N}\s-]/gu, '') : 'Palavra-chave', sub: '' });
      ed.tab = 'destaques';
    }
    ed.changed();
    player.seek(player.T);
    renderTab();
  }
  view.querySelectorAll('[data-tool]').forEach((b) => (b.onclick = () => tool(b.dataset.tool)));

  const onKey = (e) => {
    if (e.target.matches('input, textarea, select, [contenteditable]')) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 's' || e.key === 'S') tool('split');
    else if (e.key === 'Delete' || e.key === 'Backspace') tool('delete');
    else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undo(); }
    else if (e.key === 'z' || e.key === 'Z') tool('zoom');
    else if (e.key === 'k' || e.key === 'K') tool('card');
    else if (e.key === '[') tool('trimIn');
    else if (e.key === ']') tool('trimOut');
    else if (e.key === 'ArrowLeft') player.seek(player.T - (e.shiftKey ? 5 : 1 / 30));
    else if (e.key === 'ArrowRight') player.seek(player.T + (e.shiftKey ? 5 : 1 / 30));
  };
  document.addEventListener('keydown', onKey);
  ed.dispose = () => document.removeEventListener('keydown', onKey);

  // ---- linha do tempo ----
  const tl = $('#timeline'), scroll = $('#tlScroll');
  const ROW = { ruler: 22, clips: 64, caps: 24, cards: 24 };
  const tlH = ROW.ruler + ROW.clips + ROW.caps + ROW.cards + 16;
  $('#tlZoom').oninput = (e) => { ed.pps = +e.target.value; drawTimeline(); };

  function fitZoom() {
    const d = lessonDur(lesson);
    if (d > 0) { ed.pps = Math.max(2, Math.min(200, (scroll.clientWidth - 40) / d)); $('#tlZoom').value = ed.pps; }
  }

  function drawTimeline() {
    const dpr = window.devicePixelRatio || 1;
    const d = player.duration || 0;
    const W = Math.max(scroll.clientWidth, d * ed.pps + 40);
    if (tl.width !== Math.round(W * dpr) || tl.height !== Math.round(tlH * dpr)) {
      tl.width = Math.round(W * dpr); tl.height = Math.round(tlH * dpr);
      tl.style.width = W + 'px'; tl.style.height = tlH + 'px';
    }
    const g = tl.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, tlH);
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue('--ink-3').trim(), line = css.getPropertyValue('--line').trim();
    // régua
    g.fillStyle = ink; g.font = '11px Inter, sans-serif'; g.textBaseline = 'top';
    const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => s * ed.pps > 70) || 600;
    for (let t = 0; t <= d + step; t += step) {
      const x = t * ed.pps;
      g.fillRect(x, 14, 1, 8);
      const lbl = fmtLong(t).replace('min ', ':').replace('s', ''), lw = g.measureText(lbl).width;
      g.fillText(lbl, x + 3 + lw > W ? x - 3 - lw : x + 3, 2);
    }
    // clipes
    const y = ROW.ruler;
    lesson.clips.forEach((c, i) => {
      const x = player.starts[i] * ed.pps, w = Math.max(1, (c.out - c.in) * ed.pps);
      const zoomed = (c.zoom || 1) > 1.01;
      g.fillStyle = i === ed.sel ? client.accent : zoomed ? shade(client.primary, 0.25) : client.primary;
      g.beginPath(); g.roundRect ? g.roundRect(x + 0.5, y, w - 1, ROW.clips, 5) : g.rect(x, y, w, ROW.clips); g.fill();
      const env = envs.get(c.srcId);
      if (env && w > 3) {
        g.fillStyle = 'rgba(255,255,255,0.55)';
        const mid = y + ROW.clips / 2;
        for (let px = 0; px < w - 2; px += 2) {
          const t0 = c.in + px / ed.pps, t1 = c.in + (px + 2) / ed.pps;
          let m = 0;
          for (let k = Math.floor(t0 * 100); k < Math.ceil(t1 * 100) && k < env.length; k++) if (env[k] > m) m = env[k];
          const hh = Math.min(ROW.clips / 2 - 4, Math.sqrt(m) * ROW.clips * 0.9);
          g.fillRect(x + 1 + px, mid - hh, 1.4, hh * 2);
        }
      }
      if (zoomed && w > 30) { g.fillStyle = '#fff'; g.font = '600 10px Inter, sans-serif'; g.fillText(Math.round(c.zoom * 100) + '%', x + 5, y + 4); }
    });
    // legendas
    const yc = y + ROW.clips + 6;
    g.font = '10px Inter, sans-serif'; g.textBaseline = 'middle';
    for (const p of player.caps || []) {
      const x = p.s * ed.pps, w = (p.e - p.s) * ed.pps;
      g.fillStyle = line; g.fillRect(x, yc, Math.max(1, w - 1), ROW.caps - 4);
      if (w > 24) { g.save(); g.beginPath(); g.rect(x, yc, w - 2, ROW.caps); g.clip(); g.fillStyle = ink; g.fillText(p.text, x + 3, yc + (ROW.caps - 4) / 2); g.restore(); }
    }
    // destaques
    const yk = yc + ROW.caps + 2;
    for (const k of player.cardsT || []) {
      const x = k.T * ed.pps, w = k.dur * ed.pps;
      g.fillStyle = client.accent; g.globalAlpha = 0.85;
      g.fillRect(x, yk, Math.max(2, w), ROW.cards - 4);
      g.globalAlpha = 1;
      if (w > 24) { g.fillStyle = '#fff'; g.font = '600 10px Inter, sans-serif'; g.fillText(k.text.toUpperCase(), x + 4, yk + (ROW.cards - 4) / 2, w - 6); }
    }
    // cursor
    const px = player.T * ed.pps;
    g.fillStyle = '#e4572e';
    g.fillRect(px - 1, 0, 2, tlH);
    g.beginPath(); g.moveTo(px - 6, 0); g.lineTo(px + 6, 0); g.lineTo(px, 8); g.fill();
  }
  ed.drawTimeline = drawTimeline;

  function followPlayhead() {
    if (!player.playing) return;
    const px = player.T * ed.pps;
    if (px > scroll.scrollLeft + scroll.clientWidth - 60 || px < scroll.scrollLeft) scroll.scrollLeft = px - 60;
  }

  // arrastar bordas / clicar
  let drag = null;
  const hit = (ex) => {
    for (let i = 0; i < lesson.clips.length; i++) {
      const c = lesson.clips[i], x0 = player.starts[i] * ed.pps, x1 = x0 + (c.out - c.in) * ed.pps;
      if (Math.abs(ex - x0) < 6) return { i, edge: 'in' };
      if (Math.abs(ex - x1) < 6) return { i, edge: 'out' };
      if (ex > x0 && ex < x1) return { i, edge: null };
    }
    return null;
  };
  tl.onpointermove = (e) => {
    if (drag || e.pointerType !== 'mouse') return;
    const h = e.offsetY > ROW.ruler && e.offsetY < ROW.ruler + ROW.clips ? hit(e.offsetX) : null;
    tl.style.cursor = h?.edge ? 'ew-resize' : 'pointer';
  };
  tl.onpointerdown = (e) => {
    const inClips = e.offsetY > ROW.ruler && e.offsetY < ROW.ruler + ROW.clips;
    const h = inClips ? hit(e.offsetX) : null;
    if (h?.edge && e.pointerType === 'mouse') {
      ed.snapshot();
      const c = lesson.clips[h.i], src = lesson.sources.find((s) => s.id === c.srcId);
      drag = { ...h, x: e.clientX, in: c.in, out: c.out, max: src?.duration || c.out };
      const mv = (ev) => {
        const dt = (ev.clientX - drag.x) / ed.pps;
        if (drag.edge === 'in') c.in = Math.min(c.out - 0.1, Math.max(0, drag.in + dt));
        else c.out = Math.max(c.in + 0.1, Math.min(drag.max, drag.out + dt));
        player.invalidate(); drawTimeline();
      };
      const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); drag = null; ed.changed(); player.seek(player.T); };
      addEventListener('pointermove', mv); addEventListener('pointerup', up);
      return;
    }
    // toque: só posiciona se o dedo não arrastou (arrastar rola a linha do tempo)
    const x0 = e.clientX, sx = scroll.scrollLeft, ox = e.offsetX;
    const up = (ev) => {
      tl.removeEventListener('pointerup', up);
      if (Math.abs(ev.clientX - x0) > 8 || Math.abs(scroll.scrollLeft - sx) > 4) return;
      ed.sel = h ? h.i : -1;
      const wasPlaying = player.playing;
      player.stop();
      player.seek(ox / ed.pps).then(() => wasPlaying && player.play());
      drawTimeline();
    };
    tl.addEventListener('pointerup', up);
  };

  // ---- abas ----
  ed.tab = 'cortes';
  view.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { ed.tab = b.dataset.tab; renderTab(); b.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }); }));
  { const nav = view.querySelector('.tabs'); const end = () => nav.classList.toggle('at-end', nav.scrollLeft + nav.clientWidth >= nav.scrollWidth - 4); nav.addEventListener('scroll', end, { passive: true }); requestAnimationFrame(end); }
  const body = $('#tabBody');
  function renderTab() {
    view.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === ed.tab));
    ({ cortes: tabCortes, legendas: tabLegendas, destaques: tabDestaques, visual: tabVisual, ajuste: tabAjuste, exportar: tabExportar })[ed.tab]();
  }
  ed.renderTab = renderTab;

  // ----- Aba: Cortes & mídia -----
  function tabCortes() {
    body.innerHTML = `
      <h3>Gravações</h3>
      <label class="drop" id="drop"><input type="file" id="vidInput" accept="video/*,audio/*" multiple hidden>
        <b>Importar vídeos</b><span>Arraste aqui ou clique. Vários arquivos são unidos em sequência.</span></label>
      <ul class="sources">
        ${lesson.sources.map((s) => `<li><span title="${esc(s.name)}">${esc(s.name)}</span><small>${fmtLong(s.duration)}</small>
          <button class="mini-btn" data-add="${s.id}" title="Adicionar o vídeo inteiro de novo ao fim">+ fim</button>
          <button class="mini-btn" data-rm="${s.id}" title="Remover gravação">×</button></li>`).join('')}
      </ul>
      <h3>Cortes secos automáticos</h3>
      <p class="hint">Remove pausas, respiros e silêncios. Ajuste os limites no perfil do cliente ou aqui.</p>
      ${range('silenceDb', 'Limiar de silêncio (dB)', client.silenceDb, -60, -20, 1)}
      ${range('minSilence', 'Pausa mínima (s)', client.minSilence, 0.15, 1.5, 0.05)}
      ${range('padding', 'Respiro (s)', client.padding, 0, 0.3, 0.01)}
      ${check('autoZoom', 'Alternar zoom a cada corte (ritmo dinâmico)', client.autoZoom)}
      <div class="btn-row">
        <button class="btn" id="autoCut">Gerar cortes secos</button>
        <button class="ghost" id="resetCuts">Restaurar original</button>
      </div>
      <h3>Ritmo</h3>
      <div class="btn-row split">
        <button class="ghost" id="zoomAll">Zoom dinâmico em todos</button>
        <button class="ghost" id="zoomNone">Remover zooms</button>
        <button class="ghost" id="dropShort">Remover clipes &lt; 0,4 s</button>
      </div>
      <p class="hint">${pl(lesson.clips.length, 'clipe', 'clipes')} na linha do tempo.</p>`;
    bindForm(body, client);
    const inp = $('#vidInput'), drop = $('#drop');
    inp.onchange = () => importFiles([...inp.files]);
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); importFiles([...e.dataTransfer.files]); };
    body.querySelectorAll('[data-add]').forEach((b) => (b.onclick = () => {
      const s = lesson.sources.find((x) => x.id === b.dataset.add);
      ed.snapshot(); lesson.clips.push({ id: uid('clip'), srcId: s.id, in: 0, out: s.duration, zoom: 1 }); ed.changed(); renderTab();
    }));
    body.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = async () => {
      if (!(await ask('Remover esta gravação e seus cortes?', 'Remover'))) return;
      const id = b.dataset.rm, s = lesson.sources.find((x) => x.id === id);
      ed.snapshot();
      lesson.sources = lesson.sources.filter((x) => x.id !== id);
      lesson.clips = lesson.clips.filter((c) => c.srcId !== id);
      lesson.cards = lesson.cards.filter((c) => c.srcId !== id);
      delete lesson.words[id];
      const shared = state.courses.some((k) => k.modules.some((m) => m.lessons.some((l) => l !== lesson && l.sources.some((x) => x.mediaId === s.mediaId))));
      if (!shared) await db.delMedia(s.mediaId);
      await player.setLesson(lesson, client);
      ed.changed(); renderTab();
    }));
    $('#autoCut').onclick = () => autoCut();
    $('#resetCuts').onclick = () => {
      ed.snapshot();
      lesson.clips = lesson.sources.map((s) => ({ id: uid('clip'), srcId: s.id, in: 0, out: s.duration, zoom: 1 }));
      ed.changed(); player.seek(0); renderTab();
    };
    $('#zoomAll').onclick = () => { ed.snapshot(); lesson.clips.forEach((c, i) => (c.zoom = i % 2 ? 1.15 : 1)); ed.changed(); };
    $('#zoomNone').onclick = () => { ed.snapshot(); lesson.clips.forEach((c) => (c.zoom = 1)); ed.changed(); };
    $('#dropShort').onclick = () => { ed.snapshot(); lesson.clips = lesson.clips.filter((c) => c.out - c.in >= 0.4); ed.changed(); player.seek(0); renderTab(); };
  }

  async function importFiles(files) {
    files = files.filter(isMedia);
    if (!files.length) return toast('Escolha um arquivo de vídeo (MP4 ou MOV).', 'err');
    ed.snapshot();
    for (const f of files) {
      toast(`Importando ${f.name}…`);
      try { const src = await importVideo(lesson, f); loadEnv(src, f); }
      catch (e) { toast(e.message, 'err'); }
    }
    await player.setLesson(lesson, client);
    fitZoom();
    ed.changed(); renderTab();
    window.dispatchEvent(new Event('ec-media-added'));
    toast('Vídeo importado. Próximo passo: “Gerar cortes secos”.', 'ok');
  }

  async function loadEnv(src, blob) {
    const env = await getEnv(src, blob);
    drawTimeline();
    return env;
  }

  async function autoCut() {
    if (!lesson.sources.length) return toast('Importe um vídeo primeiro.');
    const btn = $('#autoCut');
    btn.disabled = true; btn.textContent = 'Analisando áudio…';
    try {
      ed.snapshot();
      const removed = await autoCutLesson(lesson, client);
      ed.changed(); player.seek(0); fitZoom(); drawTimeline(); renderTab();
      toast(`${lesson.clips.length} cortes · ${fmtLong(removed)} de pausas removidas`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
    finally { btn.disabled = false; btn.textContent = 'Gerar cortes secos'; }
  }

  // ----- Aba: Legendas -----
  function tabLegendas() {
    const caps = timelineCaptions(lesson);
    body.innerHTML = `
      <div id="autoBox">
        <h3>Legenda automática</h3>
        <p class="hint">O transcritor roda no próprio aparelho. Na primeira vez ele baixa ~100 MB e depois fica guardado.</p>
        <div class="btn-row"><button class="btn" id="transcribe">Criar legenda automaticamente</button></div>
        <div class="progress" id="trProg" hidden><span></span><em></em></div>
      </div>
      <h3>Sincronizar roteiro</h3>
      <p class="hint">Cole o roteiro ou o texto falado (ex.: transcrição do Google Docs, do Word ou do teleprompter). O app distribui o texto pelos trechos de fala detectados.</p>
      <textarea id="script" rows="4" placeholder="Cole aqui o texto da aula…"></textarea>
      <div class="btn-row"><button class="ghost" id="syncScript">Sincronizar com a fala</button></div>
      <h3>Arquivo de legenda</h3>
      <div class="btn-row">
        <label class="ghost file-btn">Importar .srt/.vtt<input type="file" id="srtIn" accept=".srt,.vtt,text/plain" hidden></label>
        <button class="ghost" id="srtOut">Baixar .srt</button>
        <button class="ghost" id="vttOut">Baixar .vtt</button>
      </div>
      ${select('captionStyle', 'Modelo de legenda', client.captionStyle || 'auto', CAPTION_MODES)}
      <h3>Revisão <small class="muted">${caps.length} frases</small></h3>
      <div class="btn-row" id="aiRow" hidden><button class="ghost" id="aiFix">Revisar termos médicos com IA</button></div>
      <p class="hint">Corrija termos técnicos aqui. Toque no horário para ir até o trecho.</p>
      <div class="caps" id="capList">${editableCaps()}</div>`;
    bindForm(body, client, () => player.draw());
    cap('sample').then((smp) => { if (smp && $('#aiRow')) { $('#aiRow').hidden = false; $('#aiFix').onclick = () => aiReview(smp); } });
    $('#transcribe') && ($('#transcribe').onclick = transcribe);
    $('#syncScript').onclick = () => syncScript($('#script').value);
    $('#srtIn').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f || !lesson.sources.length) return toast('Importe o vídeo antes da legenda.');
      ed.snapshot();
      lesson.words[lesson.sources[0].id] = parseSubs(await f.text());
      ed.changed(); renderTab(); toast('Legenda importada (aplicada à primeira gravação).', 'ok');
    };
    $('#srtOut').onclick = () => download(new Blob([srt(timelineCaptions(lesson))], { type: 'text/plain' }), slug(lesson.title) + '.srt');
    $('#vttOut').onclick = () => download(new Blob([vtt(timelineCaptions(lesson))], { type: 'text/vtt' }), slug(lesson.title) + '.vtt');
    bindCapEdits();
  }

  async function syncScript(text) {
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) return toast('Cole o texto da aula primeiro.');
    if (!lesson.sources.length) return toast('Importe o vídeo primeiro.');
    const segs = [];
    for (const s of lesson.sources) {
      const env = await loadEnv(s);
      const rs = env ? speechRanges(env, { ...client, minSilence: 0.3, padding: 0 }) : [{ in: 0, out: s.duration }];
      for (const r of rs) segs.push({ src: s.id, ...r });
    }
    const total = segs.reduce((a, r) => a + r.out - r.in, 0);
    const toks = text.split(' ');
    const weight = toks.reduce((a, w) => a + w.length + 1, 0);
    const words = Object.fromEntries(lesson.sources.map((s) => [s.id, []]));
    let pos = 0, k = 0, used = 0;
    for (const w of toks) {
      const d = total * (w.length + 1) / weight;
      while (k < segs.length - 1 && pos - used >= segs[k].out - segs[k].in) { used += segs[k].out - segs[k].in; k++; }
      const sg = segs[k], st = sg.in + (pos - used);
      words[sg.src].push({ w, s: st, e: Math.min(sg.out, st + d) });
      pos += d;
    }
    ed.snapshot();
    Object.assign(lesson.words, words);
    ed.changed(); renderTab();
    toast('Roteiro sincronizado. Confira alguns trechos e ajuste se preciso.', 'ok');
  }

  async function aiReview(smp) {
    if (!Object.values(lesson.words).some((w) => w.length)) return toast('Ainda não há legenda para revisar.');
    const btn = $('#aiFix');
    btn.disabled = true;
    ed.snapshot();
    try {
      const n = await aiReviewLesson(lesson, client, smp, ({ text }) => (btn.textContent = text));
      ed.changed(); renderTab();
      toast(n ? `${pl(n, 'frase corrigida', 'frases corrigidas')}` : 'Nenhuma correção necessária', 'ok');
    } catch (e) {
      toast('Revisão indisponível agora: ' + (e?.message || e?.code), 'err');
      btn.disabled = false; btn.textContent = 'Revisar termos médicos com IA';
    }
  }

  // Lista editável no tempo de origem (frases de cada gravação), mostrando o tempo editado.
  function editableCaps() {
    let html = '';
    for (const s of lesson.sources) {
      const ps = phrases(lesson.words[s.id] || []);
      ps.forEach((p, pi) => {
        html += `<div class="cap" data-src="${s.id}" data-pi="${pi}"><button class="t" data-seek="${p.s}" data-srcid="${s.id}">${fmt(p.s)}</button>
          <input value="${esc(p.words.map((w) => w.w).join(' '))}"></div>`;
      });
    }
    return html || '<p class="muted">Sem legenda ainda. Transcreva ou importe um .srt.</p>';
  }

  function bindCapEdits() {
    body.querySelectorAll('.cap').forEach((row) => {
      const inp = row.querySelector('input');
      inp.onchange = () => {
        const srcId = row.dataset.src, pi = +row.dataset.pi;
        const all = lesson.words[srcId];
        const ps = phrases(all);
        const p = ps[pi];
        ed.snapshot();
        const start = all.indexOf(p.words[0]);
        all.splice(start, p.words.length, ...spread(inp.value.trim(), p.s, p.e));
        ed.changed();
      };
      row.querySelector('[data-seek]').onclick = (e) => {
        const srcId = e.target.dataset.srcid, t = +e.target.dataset.seek;
        let acc = 0;
        for (const c of lesson.clips) {
          if (c.srcId === srcId && t < c.out) { player.seek(acc + Math.max(0, t - c.in)); return; }
          acc += c.out - c.in;
        }
        toast('Trecho foi cortado da edição.');
      };
    });
  }

  async function transcribe() {
    if (!lesson.sources.length) return toast('Importe um vídeo primeiro.');
    const prog = $('#trProg'), bar = prog.querySelector('span'), lbl = prog.querySelector('em');
    const btn = $('#transcribe');
    btn.disabled = true; prog.hidden = false;
    try {
      ed.snapshot();
      await transcribeLesson(lesson, ({ text, progress, busy }) => {
        lbl.textContent = text;
        if (progress != null) bar.style.width = progress * 100 + '%';
        bar.classList.toggle('pulse', !!busy);
        if (busy) bar.style.width = '100%';
      });
      ed.changed(); toast('Legenda criada. Revise os termos técnicos.', 'ok');
      renderTab();
    } catch (err) {
      console.error(err);
      toast('Falha na transcrição: ' + err.message, 'err');
      prog.hidden = true; btn.disabled = false;
    }
  }

  // ----- Aba: Destaques -----
  function tabDestaques() {
    const sug = suggestKeywords(lesson, client);
    body.innerHTML = `
      <h3>Palavras-chave de ${esc(client.name.split(' ').slice(0, 2).join(' '))}</h3>
      <p class="hint">Ficam na cor de destaque na legenda e viram cartões ao lado do expert.</p>
      <div class="chips" id="kwChips"></div>
      <form id="kwForm" class="inline"><input placeholder="Nova palavra-chave"><button>+</button></form>
      ${sug.length ? `<p class="hint">Sugestões desta aula:</p><div class="chips sug">${sug.map((s) => `<button class="chip add" data-sug="${esc(s)}">+ ${esc(s)}</button>`).join('')}</div>` : ''}
      <div class="btn-row">
        <button class="btn" id="genCards">Gerar destaques automáticos</button>
        <button class="ghost" id="clearCards">Limpar</button>
      </div>
      <h3>Cartões <small class="muted">${lesson.cards.length}</small></h3>
      <div class="cards-list">
        ${lesson.cards.map((k, i) => {
          const T = player.cardsT?.find((x) => x.id === k.id)?.T;
          return `<div class="kcard" data-i="${i}">
            <button class="t" data-goto="${T ?? ''}">${T == null ? 'cortado' : fmt(T)}</button>
            <input data-f="text" value="${esc(k.text)}" placeholder="Palavra">
            <input data-f="sub" value="${esc(k.sub || '')}" placeholder="Linha de apoio (opcional)">
            <label class="dur">dur. <input data-f="dur" type="number" step="0.5" min="1" max="10" value="${k.dur}"></label>
            <button class="mini-btn" data-del="${i}">×</button>
          </div>`;
        }).join('') || '<p class="muted">Nenhum cartão. Gere automaticamente ou use “+ Destaque” (K) no cursor.</p>'}
      </div>`;
    chipEditor($('#kwChips'), $('#kwForm'), client, () => player.draw());
    body.querySelectorAll('[data-sug]').forEach((b) => (b.onclick = () => { client.keywords.push(b.dataset.sug); save(); player.draw(); renderTab(); }));
    $('#genCards').onclick = () => {
      if (!Object.values(lesson.words).some((w) => w.length)) return toast('Transcreva a aula primeiro (aba Legendas).');
      ed.snapshot();
      const manual = lesson.cards.filter((k) => k.manual);
      lesson.cards = [...manual, ...autoCards(lesson, client)];
      ed.changed(); renderTab(); toast(`${lesson.cards.length} destaques criados`, 'ok');
    };
    $('#clearCards').onclick = () => { ed.snapshot(); lesson.cards = []; ed.changed(); renderTab(); };
    body.querySelectorAll('.kcard').forEach((row) => {
      const k = lesson.cards[+row.dataset.i];
      row.querySelectorAll('[data-f]').forEach((inp) => (inp.oninput = () => { k[inp.dataset.f] = inp.type === 'number' ? +inp.value : inp.value; k.manual = true; ed.changed(); }));
      row.querySelector('[data-goto]').onclick = (e) => e.target.dataset.goto !== '' && player.seek(+e.target.dataset.goto + 0.4);
      row.querySelector('[data-del]').onclick = () => { ed.snapshot(); lesson.cards.splice(+row.dataset.i, 1); ed.changed(); renderTab(); };
    });
  }

  // ----- Aba: Visual -----
  function tabVisual() {
    body.innerHTML = `<p class="hint">Vale para todas as aulas de <b>${esc(client.name)}</b>.</p><div class="style-panel" id="eStyle"></div>`;
    const sp = $('#eStyle');
    sp.innerHTML = stylePanelHTML(client);
    bindStylePanel(sp, client, player, () => { lesson.render = null; save(); player.invalidate(); player.draw(); drawTimeline(); });
  }

  function tabAjuste() {
    body.innerHTML = chatHTML();
    bindChat(body, { client, lesson, course, player, refresh: () => { ed.changed(); } });
  }

  // ----- Aba: Exportar -----
  function tabExportar() {
    const p = PLATFORMS[ed.platform || client.platform] || PLATFORMS.hotmart;
    const mime = pickMime();
    body.innerHTML = `
      ${select('platform', 'Destino', ed.platform || client.platform, Object.fromEntries(Object.entries(PLATFORMS).map(([k, v]) => [k, v.name])))}
      <p class="hint">${p.w}×${p.h} · ${p.fps} fps · ${(p.vbr / 1e6).toFixed(0)} Mbps · ${esc(p.note)}</p>
      <p class="hint">Formato gerado pelo navegador: <b>${mime.includes('avc1') ? 'MP4 (H.264)' : mime.includes('mp4') ? 'MP4 (VP9)' : 'WebM'}</b>${mime.includes('avc1') ? '' : ' — para MP4 H.264 (máxima compatibilidade) use Google Chrome ou Edge atualizado.'}</p>
      <p class="hint">A renderização acontece em tempo real (${fmtLong(lessonDur(lesson))}). Mantenha esta aba visível.</p>
      <div class="btn-row"><button class="btn" id="renderBtn">Renderizar aula</button><button class="ghost" id="cancelBtn" hidden>Cancelar</button></div>
      <div class="progress" id="rProg" hidden><span></span><em></em></div>
      <div id="rOut">${lesson.render ? renderInfo(lesson.render) : ''}</div>
      <h3>Textos para a plataforma</h3>
      <label>Descrição da aula<textarea id="lesDesc" rows="4" placeholder="Resumo da aula para o player da plataforma">${esc(lesson.description)}</textarea></label>
      <div class="btn-row"><button class="ghost small" id="autoDesc">Gerar resumo a partir da legenda</button></div>`;
    body.querySelector('[data-k=platform]').onchange = (e) => { ed.platform = e.target.value; renderTab(); };
    $('#lesDesc').oninput = (e) => { lesson.description = e.target.value; save(); };
    $('#autoDesc').onclick = async () => {
      const text = timelineCaptions(lesson).map((c) => c.text).join(' ');
      if (!text) return toast('Transcreva a aula primeiro.');
      const smp = await cap('sample');
      if (smp) {
        const btn = $('#autoDesc');
        btn.disabled = true; btn.textContent = 'Escrevendo…';
        try {
          const r = await smp(`Escreva a descrição de uma aula de curso online para a área de membros (Hotmart/Eduzz/Sympla).
Expert: ${client.name}, ${client.specialty || 'médico(a)'}. Curso: ${course.title}. Aula: ${lesson.title}.
Tom: profissional, acolhedor, claro para leigos, sem promessas de cura e respeitando as normas de publicidade médica do CFM.${briefOf(client)}
Formato: 1 frase de abertura + 3 tópicos curtos com "•" sobre o que o aluno vai aprender. Máximo 90 palavras. Responda só com o texto.
Transcrição:
${text.slice(0, 12000)}`, { modelTier: 'quick' });
          lesson.description = r.text.trim(); save(); renderTab(); return;
        } catch (e) { toast('IA indisponível, usando resumo simples.'); }
      }
      const kws = client.keywords.filter((k) => norm(text).includes(norm(k)));
      lesson.description = `Nesta aula, ${client.name} explica ${kws.length ? 'sobre ' + kws.slice(0, 4).join(', ') : lesson.title.toLowerCase()}.\n\n${text.split(/(?<=[.!?])\s/).slice(0, 3).join(' ')}`;
      save(); renderTab();
    };
    bindRenderInfo();
    const ctrl = { ac: null };
    $('#renderBtn').onclick = async () => {
      if (!lesson.clips.length) return toast('Nada para renderizar.');
      const prog = $('#rProg'), bar = prog.querySelector('span'), lbl = prog.querySelector('em');
      prog.hidden = false; $('#renderBtn').disabled = true; $('#cancelBtn').hidden = false;
      ctrl.ac = new AbortController();
      $('#cancelBtn').onclick = () => ctrl.ac.abort();
      try {
        const blob = await renderLesson(player, p, { signal: ctrl.ac.signal, onProgress: (f) => { bar.style.width = (f * 100).toFixed(1) + '%'; lbl.textContent = `Renderizando ${Math.round(f * 100)}%`; } });
        const mediaId = 'render:' + lesson.id;
        db.keep(mediaId, blob);
        lesson.render = { mediaId, size: blob.size, ext: extOf(blob), platform: ed.platform || client.platform, at: Date.now(), dur: lessonDur(lesson) };
        save();
        toast('Aula renderizada!', 'ok');
        renderTab();
      } catch (err) {
        if (err.name !== 'AbortError') { console.error(err); toast('Erro ao renderizar: ' + err.message, 'err'); }
        else toast('Renderização cancelada');
        prog.hidden = true; $('#renderBtn').disabled = false; $('#cancelBtn').hidden = true;
      }
    };
  }

  function renderInfo(r) {
    return `<div class="render-ok"><b>✓ Pronta</b> · ${mb(r.size)} · ${r.ext.toUpperCase()} · ${esc(PLATFORMS[r.platform]?.name || '')}
      <div class="btn-row"><button class="btn small" id="dlVid">Baixar vídeo</button><button class="ghost small" id="dlSrt">Baixar .srt</button></div></div>`;
  }
  function bindRenderInfo() {
    const r = lesson.render;
    if (!r || !$('#dlVid')) return;
    const base = `${String(mi + 1).padStart(2, '0')}-${String(li + 1).padStart(2, '0')}-${slug(lesson.title)}`;
    $('#dlVid').onclick = async () => download(await db.getBlob(r.mediaId), `${base}.${r.ext}`);
    $('#dlSrt').onclick = () => download(new Blob([srt(timelineCaptions(lesson))], { type: 'text/plain' }), base + '.srt');
  }

  // ---- inicialização ----
  renderTab();
  await document.fonts.ready;
  await player.setLesson(lesson, client);
  for (const s of lesson.sources) loadEnv(s);
  fitZoom();
  drawTimeline();
  updateStats();
  const ro = new ResizeObserver(() => drawTimeline());
  ro.observe(scroll);
  const prevDispose = ed.dispose;
  ed.dispose = () => { prevDispose(); ro.disconnect(); };
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => Math.round(c + (255 - c) * amt);
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}


// ======================= Estilo do vídeo (modelos, paleta, sombras, legenda, destaques) =======================
function stylePanelHTML(c) {
  const st = resolveStyle(c);
  const tpl = TEMPLATES[c.template] || TEMPLATES.clinico;
  let open = {};
  try { open = JSON.parse(localStorage.getItem('ec-style-open') || '{}'); } catch {}
  const grp = (id, title, sub, body, def = false) => `<details class="grp" data-grp="${id}" ${(open[id] ?? def) ? 'open' : ''}><summary><b>${title}</b><small>${sub}</small></summary><div class="grp-body">${body}</div></details>`;
  return `
    <div class="style-prev-wrap"><canvas class="style-prev" width="1280" height="720" data-prev></canvas><span class="style-prev-tag">Prévia · ${esc(tpl.name)}</span></div>
    ${grp('modelo', 'Modelo de vídeo', esc(tpl.name), `<div class="tpl-grid">${Object.entries(TEMPLATES).map(([k, t]) => `
      <button class="tpl ${k === (c.template || 'clinico') ? 'on' : ''}" data-tpl="${k}" type="button" aria-pressed="${k === (c.template || 'clinico')}">
        <canvas width="480" height="270" data-thumb="${k}"></canvas>
        <b>${esc(t.name)}</b><small>${esc(t.ref)}</small>
      </button>`).join('')}</div>`, true)}
    ${grp('cores', 'Cores e sombras', `<i class="mini-sw" style="background:${esc(st.primary)}"></i><i class="mini-sw" style="background:${esc(st.accent)}"></i>`, `
      <div class="swatches">${PALETTES.map((p, i) => `
        <button class="sw ${p.primary === st.primary && p.accent === st.accent ? 'on' : ''}" data-pal="${i}" type="button" title="${esc(p.name)}">
          <span style="background:${p.primary}"></span><span style="background:${p.accent}"></span><small>${esc(p.name)}</small>
        </button>`).join('')}</div>
      <div class="row3">${color('primary', 'Principal', st.primary)}${color('accent', 'Destaque', st.accent)}${color('text', 'Texto', st.text)}</div>
      ${range('shadow', 'Sombras', c.shadow ?? 0.6, 0, 1.5, 0.05)}`)}
    ${grp('legenda', 'Legenda', esc(CAPTION_MODES[c.captionStyle || 'auto'] || ''), `
      ${select('captionStyle', 'Modelo de legenda', c.captionStyle || 'auto', CAPTION_MODES)}
      ${range('captionScale', 'Tamanho da legenda', c.captionScale || 1, 0.7, 1.6, 0.05)}
      ${select('captionPos', 'Posição', c.captionPos || 'bottom', { bottom: 'Rodapé', middle: 'Terço inferior' })}`)}
    ${grp('destaques', 'Destaques e posição do expert', esc(CARD_VARIANTS[c.cardVariant || 'auto'] || ''), `
      ${select('cardVariant', 'Modelo de destaque', c.cardVariant || 'auto', CARD_VARIANTS)}
      <label>Etiqueta acima do destaque<input data-k="cardEyebrow" value="${esc(c.cardEyebrow ?? st.card.eyebrow ?? '')}" placeholder="Ex.: PONTO-CHAVE (vazio = sem etiqueta)"></label>
      ${select('expertSide', 'Posição do expert', c.expertSide, { left: 'Expert à esquerda → destaques à direita', right: 'Expert à direita → destaques à esquerda' })}`)}
    ${grp('imagem', 'Imagem e elementos', 'cor, zoom, abertura, nome + CRM, logo', `
      ${select('look', 'Cor da imagem', c.look || 'auto', { auto: 'Do modelo', ...Object.fromEntries(Object.entries(LOOKS).map(([k, v]) => [k, v.name])) })}
      ${range('focusX', 'Centro do rosto (zoom e vertical)', c.focusX ?? 0.5, 0, 1, 0.01)}
      <div class="checks">
        ${check('cleanVoice', 'Voz limpa', c.cleanVoice)}
        ${check('autoZoom', 'Zoom nos cortes', c.autoZoom)}
        ${check('smoothZoom', 'Zoom suave contínuo', c.smoothZoom)}
        ${check('openingTitle', 'Abertura com título', c.openingTitle)}
        ${check('lowerThird', 'Nome + CRM', c.lowerThird)}
        ${check('watermark', 'Logo no canto', c.watermark)}
      </div>`)}
    ${grp('sons', 'Efeitos sonoros', c.sfx ? 'ligados' : 'desligados', sfxBlock(c).replace('<h3>Efeitos sonoros</h3>', ''))}
    ${grp('trilha', 'Trilha sonora', esc(TRACKS[c.music || 'nenhuma']?.name || ''), `<div data-music-box>${musicBlock(c)}</div>`)}`;
}

function bindStylePanel(root, c, player, onChange) {
  const changed = () => { onChange?.(); drawThumbs(root, c); };
  root.querySelectorAll('details.grp').forEach((d) => d.addEventListener('toggle', () => {
    let open = {};
    try { open = JSON.parse(localStorage.getItem('ec-style-open') || '{}'); } catch {}
    open[d.dataset.grp] = d.open;
    try { localStorage.setItem('ec-style-open', JSON.stringify(open)); } catch {}
  }));
  root.querySelectorAll('[data-tpl]').forEach((b) => (b.onclick = () => {
    const t = TEMPLATES[b.dataset.tpl];
    Object.assign(c, { template: b.dataset.tpl, ...t.palette, look: 'auto', captionStyle: 'auto', cardVariant: 'auto', cardEyebrow: null, captionScale: 1 });
    save();
    const y = window.scrollY;
    root.innerHTML = stylePanelHTML(c);
    bindStylePanel(root, c, player, onChange);
    window.scrollTo(0, y);
    onChange?.();
    toast(`Modelo “${t.name}” aplicado`, 'ok');
  }));
  root.querySelectorAll('[data-pal]').forEach((b) => (b.onclick = () => {
    const p = PALETTES[+b.dataset.pal];
    Object.assign(c, { primary: p.primary, accent: p.accent, text: p.text });
    save();
    root.querySelectorAll('[data-pal]').forEach((x) => x.classList.toggle('on', x === b));
    root.querySelector('[data-k=primary]').value = p.primary;
    root.querySelector('[data-k=accent]').value = p.accent;
    root.querySelector('[data-k=text]').value = p.text;
    changed();
  }));
  bindForm(root, c, (k) => { if (k === 'cleanVoice') player?.refreshAudio(); if (k === 'cardEyebrow') c.cardEyebrow = root.querySelector('[data-k=cardEyebrow]').value; changed(); });
  bindSfxPreview(root, c, player);
  bindMusic(root.querySelector('[data-music-box]'), c, onChange);
  drawThumbs(root, c);
}

// Prévias: a grande mostra o estilo atual; as miniaturas mostram cada modelo com as palavras-chave do cliente.
// Usam uma cena ilustrada, então aparecem na hora (sem esperar vídeo) e funcionam em qualquer celular.
let thumbJob = 0;
function drawThumbs(root, c) {
  const job = ++thumbJob;
  const big = root.querySelector('[data-prev]');
  if (big) drawStylePreview(big, c);
  const list = [...root.querySelectorAll('[data-thumb]')];
  const step = () => {
    if (job !== thumbJob) return;
    const cv = list.shift();
    if (!cv) return;
    const t = TEMPLATES[cv.dataset.thumb];
    drawStylePreview(cv, c, { template: cv.dataset.thumb, ...t.palette, look: 'auto', captionStyle: 'auto', cardVariant: 'auto', cardEyebrow: null, captionScale: 1, openingTitle: false });
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ======================= Chat "Pedir ajuste" (Claude edita por você) =======================
function chatHTML() {
  return `
    <div class="chat">
      <div class="chat-log" id="chatLog"><p class="bot">Peça qualquer ajuste em português. Exemplos: “deixa no estilo cinema”, “legenda maior e amarela”, “destaca a palavra glicemia”, “corte mais rápido”, “troca ‘insulir’ por ‘insulina’ na legenda”.</p></div>
      <form class="chat-in" id="chatForm"><input id="chatText" placeholder="Escreva o ajuste…" autocomplete="off"><button class="btn" type="submit">Enviar</button></form>
    </div>`;
}

function bindChat(root, { client, lesson, course, player, refresh }) {
  const log = root.querySelector('#chatLog'), form = root.querySelector('#chatForm'), inp = root.querySelector('#chatText');
  const add = (cls, text) => { const p = document.createElement('p'); p.className = cls; p.textContent = text; log.appendChild(p); log.scrollTop = log.scrollHeight; return p; };
  const history = [];
  const applied = [];
  const touch = (msg) => { lesson.render = null; save(); player.invalidate(); player.draw(); applied.push(msg); return msg; };
  const tools = [
    { name: 'ver_estado', description: 'Retorna as configurações atuais do vídeo, os modelos e paletas disponíveis e um trecho da legenda.',
      execute: () => ({ modelo: client.template, cores: { principal: client.primary, destaque: client.accent, texto: client.text }, legenda: { modelo: client.captionStyle, tamanho: client.captionScale || 1, posicao: client.captionPos }, destaque: { modelo: client.cardVariant, etiqueta: client.cardEyebrow }, palavras_chave: client.keywords, efeitos_sonoros: client.sfx, volume_efeitos: client.sfxVol, sombra: client.shadow ?? 0.6, cor_imagem: client.look, modelos: Object.fromEntries(Object.entries(TEMPLATES).map(([k, t]) => [k, t.name + ' — ' + t.ref])), modelos_legenda: CAPTION_MODES, modelos_destaque: CARD_VARIANTS, cores_imagem: Object.keys(LOOKS), paletas: PALETTES.map((p) => p.name), duracao: Math.round(player.duration), legenda: timelineCaptions(lesson).slice(0, 40).map((c) => c.text).join(' / ') }) },
    { name: 'definir_modelo', description: 'Aplica um modelo de vídeo completo (fontes, cores, legenda, destaques, moldura).',
      inputSchema: { type: 'object', properties: { modelo: { type: 'string', enum: Object.keys(TEMPLATES) } }, required: ['modelo'] },
      execute: ({ modelo }) => { const t = TEMPLATES[String(modelo)]; if (!t) throw new Error('modelo inexistente'); Object.assign(client, { template: String(modelo), ...t.palette, look: 'auto', captionStyle: 'auto', cardVariant: 'auto', cardEyebrow: null, captionScale: 1 }); return touch(`Modelo: ${t.name}`); } },
    { name: 'definir_cores', description: 'Muda as cores (hexadecimal #RRGGBB). Use também para aplicar uma das paletas pelo nome.',
      inputSchema: { type: 'object', properties: { principal: { type: 'string' }, destaque: { type: 'string' }, texto: { type: 'string' }, paleta: { type: 'string' } } },
      execute: (i) => { const p = PALETTES.find((x) => norm(x.name) === norm(String(i.paleta || ''))); if (p) Object.assign(client, { primary: p.primary, accent: p.accent, text: p.text }); const ok = (h) => /^#[0-9a-f]{6}$/i.test(String(h || '')); if (ok(i.principal)) client.primary = i.principal; if (ok(i.destaque)) client.accent = i.destaque; if (ok(i.texto)) client.text = i.texto; return touch('Cores atualizadas'); } },
    { name: 'definir_legenda', description: 'Ajusta a legenda: modelo, tamanho (0.7 a 1.6, 1 = padrão) e posição.',
      inputSchema: { type: 'object', properties: { modelo: { type: 'string', enum: Object.keys(CAPTION_MODES) }, tamanho: { type: 'number' }, posicao: { type: 'string', enum: ['bottom', 'middle'] } } },
      execute: (i) => { if (CAPTION_MODES[i.modelo]) client.captionStyle = i.modelo; if (i.tamanho) client.captionScale = Math.min(1.6, Math.max(0.7, Number(i.tamanho))); if (i.posicao) client.captionPos = i.posicao; return touch('Legenda ajustada'); } },
    { name: 'definir_destaques', description: 'Ajusta os cartões de destaque: modelo visual, etiqueta acima (texto curto em maiúsculas ou vazio) e lado.',
      inputSchema: { type: 'object', properties: { modelo: { type: 'string', enum: Object.keys(CARD_VARIANTS) }, etiqueta: { type: 'string' }, lado_do_expert: { type: 'string', enum: ['left', 'right'] } } },
      execute: (i) => { if (CARD_VARIANTS[i.modelo]) client.cardVariant = i.modelo; if (i.etiqueta !== undefined) client.cardEyebrow = String(i.etiqueta); if (i.lado_do_expert) client.expertSide = i.lado_do_expert; return touch('Destaques ajustados'); } },
    { name: 'palavras_chave', description: 'Adiciona e/ou remove palavras-chave e recria os destaques da aula.',
      inputSchema: { type: 'object', properties: { adicionar: { type: 'array', items: { type: 'string' } }, remover: { type: 'array', items: { type: 'string' } } } },
      execute: (i) => { for (const w of i.adicionar || []) if (!client.keywords.some((k) => norm(k) === norm(w))) client.keywords.push(String(w)); const rm = (i.remover || []).map(norm); client.keywords = client.keywords.filter((k) => !rm.includes(norm(k))); const n = keywordsAndCards(lesson, client); return touch(`${n} destaques · palavras: ${client.keywords.join(', ')}`); } },
    { name: 'corrigir_legenda', description: 'Troca uma palavra ou trecho errado da legenda por outro, em toda a aula.',
      inputSchema: { type: 'object', properties: { de: { type: 'string' }, para: { type: 'string' } }, required: ['de', 'para'] },
      execute: ({ de, para }) => { let n = 0; const re = new RegExp(String(de).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'); for (const [id, ws] of Object.entries(lesson.words)) { const ps = phrases(ws); for (let j = ps.length - 1; j >= 0; j--) { const p = ps[j], t = p.words.map((w) => w.w).join(' '); if (!re.test(t)) continue; re.lastIndex = 0; const all = lesson.words[id], st = all.indexOf(p.words[0]); all.splice(st, p.words.length, ...spread(t.replace(re, String(para)), p.s, p.e)); n++; } } return touch(`${pl(n, 'trecho corrigido', 'trechos corrigidos')}`); } },
    { name: 'ajustar_cortes', description: 'Refaz os cortes secos. ritmo: "rapido" (pausas curtas), "dinamico" (padrão) ou "natural" (mantém respiros).',
      inputSchema: { type: 'object', properties: { ritmo: { type: 'string', enum: ['rapido', 'dinamico', 'natural'] } }, required: ['ritmo'] },
      execute: async ({ ritmo }) => { Object.assign(client, { rapido: { minSilence: 0.3, padding: 0.05 }, dinamico: { minSilence: 0.45, padding: 0.08 }, natural: { minSilence: 0.7, padding: 0.15 } }[ritmo] || {}); const removed = await autoCutLesson(lesson, client); player.invalidate(); await player.seek(0); return touch(`${lesson.clips.length} cortes · ${fmtLong(removed)} removidos`); } },
    { name: 'definir_extras', description: 'Liga/desliga e ajusta: trilha sonora de fundo (nenhuma, calma, inspira, corporativa) e volume (0-1), efeitos sonoros e volume (0-1), sombra (0-1.5), cor da imagem, zoom nos cortes, abertura, nome+CRM, logo.',
      inputSchema: { type: 'object', properties: { efeitos_sonoros: { type: 'boolean' }, volume_efeitos: { type: 'number' }, sombra: { type: 'number' }, cor_imagem: { type: 'string', enum: ['auto', ...Object.keys(LOOKS)] }, trilha: { type: 'string', enum: Object.keys(TRACKS) }, volume_trilha: { type: 'number' }, zoom_nos_cortes: { type: 'boolean' }, abertura: { type: 'boolean' }, nome_na_tela: { type: 'boolean' }, logo: { type: 'boolean' } } },
      execute: (i) => { const m = { trilha: 'music', volume_trilha: 'musicVol', efeitos_sonoros: 'sfx', volume_efeitos: 'sfxVol', sombra: 'shadow', cor_imagem: 'look', abertura: 'openingTitle', nome_na_tela: 'lowerThird', logo: 'watermark' }; for (const [k, v] of Object.entries(i)) if (m[k] !== undefined && v !== undefined) client[m[k]] = v; if (i.zoom_nos_cortes !== undefined) { client.autoZoom = !!i.zoom_nos_cortes; lesson.clips.forEach((c, j) => (c.zoom = client.autoZoom && j % 2 ? 1.15 : 1)); } return touch('Ajustes aplicados'); } },
  ];
  form.onsubmit = async (e) => {
    e.preventDefault();
    const text = inp.value.trim();
    if (!text) return;
    inp.value = '';
    add('me', text);
    const smp = await cap('sample');
    if (!smp) { add('bot', 'O assistente funciona com o app aberto no claude.ai (no app do Claude ou no navegador, logada). Aqui, use o painel de estilo acima.'); return; }
    const bubble = add('bot', 'Pensando…');
    applied.length = 0;
    history.push({ role: 'user', content: text });
    const sys = `Você é o assistente de edição do Estúdio de Cursos. Fale português do Brasil, curto e simpático. A usuária edita aulas de ${client.name} (${client.specialty || 'saúde'}), aula "${lesson.title}".${briefOf(client)}
Use as ferramentas para aplicar os ajustes pedidos (consulte ver_estado quando precisar). Depois responda em 1-2 frases dizendo o que mudou. Se algo não for possível pelas ferramentas, diga com clareza.`;
    try {
      const r = await smp([{ role: 'user', content: sys }, { role: 'assistant', content: 'Entendido.' }, ...history], {
        tools, cache: false, modelTier: 'default',
        onText: ({ text: t }) => { bubble.textContent = t || 'Aplicando…'; },
      });
      bubble.textContent = r.text || (applied.length ? applied.join(' · ') : 'Feito.');
      history.push({ role: 'assistant', content: bubble.textContent });
      if (applied.length) { refresh?.(); }
    } catch (err) {
      bubble.textContent = err?.code === 'not_granted' ? 'Você precisa permitir que a página use o Claude (aparece um aviso na primeira vez).' : 'Não consegui agora: ' + (err?.message || err?.code);
      history.pop();
    }
  };
}

// ======================= Central de exportação =======================
function viewExport(course) {
  const c = getClient(course.clientId);
  let platform = c.platform;
  const all = course.modules.flatMap((m, mi) => m.lessons.map((l, li) => ({ m, mi, l, li })));
  const draw = () => {
    const p = PLATFORMS[platform];
    const ready = all.filter((x) => x.l.render).length;
    view.innerHTML = `
      <header class="page-head">
        <div><p class="eyebrow"><a href="#/cliente/${c.id}">${esc(c.name)}</a> / <a href="#/curso/${course.id}">${esc(course.title)}</a></p><h1>Exportar curso</h1></div>
      </header>
      <div class="two-col">
        <section class="panel">
          <h2>Destino</h2>
          <div class="platforms">
            ${Object.entries(PLATFORMS).map(([k, v]) => `<button class="plat ${k === platform ? 'on' : ''}" data-p="${k}"><b>${esc(v.name)}</b><small>${v.w}×${v.h}</small></button>`).join('')}
          </div>
          <p class="hint">${esc(p.note)}</p>
          <h2>Aulas <small class="muted">${ready}/${all.length} prontas</small></h2>
          <ul class="exp-list">
            ${all.map(({ m, mi, l, li }) => `<li>
              <span class="num">${mi + 1}.${li + 1}</span><span class="grow">${esc(l.title)}<small>${esc(m.title)}</small></span>
              <span class="tag ${l.render ? 'ok strong' : l.clips.length ? '' : 'muted'}">${l.render ? '✓ ' + mb(l.render.size) : l.clips.length ? fmtLong(lessonDur(l)) : 'sem vídeo'}</span>
              <a class="btn small ghost" href="#/aula/${course.id}/${l.id}">Abrir</a></li>`).join('')}
          </ul>
          <div class="btn-row">
            <button class="btn" id="renderAll">Renderizar pendentes</button>
            <button class="ghost" id="cancelAll" hidden>Cancelar</button>
          </div>
          <div class="progress" id="aProg" hidden><span></span><em></em></div>
          <canvas id="expPreview" width="640" height="360" class="exp-preview" hidden></canvas>
        </section>
        <section class="panel">
          <h2>Pacote para upload</h2>
          <p class="hint">Um .zip organizado por módulo, com vídeos, legendas .srt, descrições e planilha da grade do curso — pronto para subir em ${esc(p.name)}.</p>
          <pre class="tree">${esc(slug(course.title))}/
${course.modules.map((m, mi) => `  ${String(mi + 1).padStart(2, '0')}-${slug(m.title)}/
${m.lessons.map((l, li) => `    ${String(li + 1).padStart(2, '0')}-${slug(l.title)}.mp4 + .srt`).join('\n')}`).join('\n')}
  grade-do-curso.csv
  descricao-do-curso.txt</pre>
          <div class="btn-row"><button class="btn" id="zipBtn" ${ready ? '' : 'disabled'}>Baixar pacote .zip</button>
            <button class="ghost" id="csvBtn">Só a planilha</button></div>
        </section>
      </div>`;
    view.querySelectorAll('[data-p]').forEach((b) => (b.onclick = () => { platform = b.dataset.p; draw(); }));
    $('#csvBtn').onclick = () => download(new Blob(['﻿' + csv()], { type: 'text/csv' }), slug(course.title) + '-grade.csv');
    $('#zipBtn').onclick = zip;
    $('#renderAll').onclick = renderAll;
  };

  const csv = () => {
    const rows = [['Módulo', 'Nº', 'Aula', 'Descrição', 'Duração (s)', 'Arquivo']];
    all.forEach(({ m, mi, l, li }) => rows.push([m.title, `${mi + 1}.${li + 1}`, l.title, l.description, Math.round(lessonDur(l)), `${String(mi + 1).padStart(2, '0')}-${slug(m.title)}/${String(li + 1).padStart(2, '0')}-${slug(l.title)}.${l.render?.ext || 'mp4'}`]));
    return rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\n');
  };

  async function renderAll() {
    const ac = new AbortController();
    const prog = $('#aProg'), bar = prog.querySelector('span'), lbl = prog.querySelector('em');
    const pv = $('#expPreview');
    prog.hidden = false; pv.hidden = false; $('#cancelAll').hidden = false; $('#renderAll').disabled = true;
    $('#cancelAll').onclick = () => ac.abort();
    const player = new Player(pv);
    const todo = all.filter((x) => !x.l.render && x.l.clips.length);
    try {
      for (let n = 0; n < todo.length; n++) {
        const { m, l } = todo[n];
        player.meta = { module: m.title };
        await player.setLesson(l, c);
        const blob = await renderLesson(player, PLATFORMS[platform], {
          signal: ac.signal,
          onProgress: (f) => { bar.style.width = ((n + f) / todo.length * 100).toFixed(1) + '%'; lbl.textContent = `Aula ${n + 1}/${todo.length}: ${l.title} — ${Math.round(f * 100)}%`; },
        });
        const mediaId = 'render:' + l.id;
        db.keep(mediaId, blob);
        l.render = { mediaId, size: blob.size, ext: extOf(blob), platform, at: Date.now(), dur: lessonDur(l) };
        save();
      }
      toast('Todas as aulas renderizadas!', 'ok');
    } catch (err) {
      if (err.name !== 'AbortError') toast('Erro: ' + err.message, 'err');
    }
    player.stop();
    draw();
  }

  async function zip() {
    try { await needZip(); } catch (e) { return toast(e.message, 'err'); }
    const btn = $('#zipBtn');
    btn.disabled = true; btn.textContent = 'Montando pacote…';
    const z = new JSZip();
    const root = z.folder(slug(course.title));
    for (const { m, mi, l, li } of all) {
      const dir = root.folder(`${String(mi + 1).padStart(2, '0')}-${slug(m.title)}`);
      const base = `${String(li + 1).padStart(2, '0')}-${slug(l.title)}`;
      if (l.render) dir.file(`${base}.${l.render.ext}`, await db.getBlob(l.render.mediaId), { binary: true, compression: 'STORE' });
      const caps = timelineCaptions(l);
      if (caps.length) dir.file(`${base}.srt`, srt(caps));
      if (l.description || l.chapters) dir.file(`${base}-descricao.txt`, [l.description, l.chapters && 'Capítulos:\n' + l.chapters].filter(Boolean).join('\n\n'));
    }
    root.file('grade-do-curso.csv', '﻿' + csv());
    root.file('descricao-do-curso.txt', `${course.title}\n${c.name}${c.crm ? ' — ' + c.crm : ''}\n\n${course.description}\n\nPalavras-chave: ${c.keywords.join(', ')}`);
    const blob = await z.generateAsync({ type: 'blob', streamFiles: true });
    download(blob, `${slug(course.title)}-${platform}.zip`);
    btn.disabled = false; btn.textContent = 'Baixar pacote .zip';
  }
  draw();
}

// ======================= Boot =======================
// Aviso de instalação na tela de início (só no celular, até a pessoa fechar).
function installHint(host) {
  const mobile = /iphone|ipad|ipod|android/i.test(navigator.userAgent);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  let dismissed = false;
  try { dismissed = localStorage.getItem('ec-install-ok') === '1'; } catch {}
  if (!mobile || standalone || dismissed) return;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const inApp = /claude/i.test(navigator.userAgent);
  const link = 'https://claude.ai/artifact/TktWxL7iosS8x65jYTAH69';
  const steps = inApp
    ? `<li>Toque em <b>Copiar link</b> abaixo.</li><li>Abra o <b>${ios ? 'Safari' : 'Chrome'}</b>, cole o link na barra de endereço e entre na sua conta Claude.</li><li>Lá, siga o aviso que vai aparecer de novo.</li>`
    : ios
      ? `<li>Toque no botão <b>Compartilhar</b> <span class="ico">□↑</span> na barra do Safari.</li><li>Role e toque em <b>Adicionar à Tela de Início</b>.</li><li>Toque em <b>Adicionar</b>. Pronto: o ícone aparece junto dos seus apps.</li>`
      : `<li>Toque nos <b>três pontinhos ⋮</b> no canto de cima do Chrome.</li><li>Toque em <b>Adicionar à tela inicial</b> (ou <b>Instalar app</b>).</li><li>Toque em <b>Adicionar</b>. Pronto: o ícone aparece junto dos seus apps.</li>`;
  const d = document.createElement('details');
  d.className = 'install';
  d.innerHTML = `<summary><span>📲 Colocar o Estúdio na tela de início</span><button class="x" id="installOk" type="button" aria-label="Fechar aviso">×</button></summary><ol>${steps}</ol>
    <div class="btn-row"><button class="ghost small" id="copyLink" type="button">Copiar link</button></div>
    <p class="hint">Link: <span class="sel">${link}</span></p>`;
  host.prepend(d);
  $('#copyLink').onclick = () => navigator.clipboard?.writeText(link).then(() => toast('Link copiado', 'ok'), () => toast('Selecione o link abaixo e copie.'));
  $('#installOk').onclick = (e) => { e.preventDefault(); try { localStorage.setItem('ec-install-ok', '1'); } catch {} d.remove(); };
}

window.addEventListener('beforeunload', (e) => {
  if (db.isSaving()) { e.preventDefault(); e.returnValue = 'O vídeo ainda está sendo guardado neste aparelho.'; }
});

// ---------- nuvem: vídeos originais ----------
let mediaSyncing = false;
async function syncMedia() {
  if (!cloud.on() || mediaSyncing) return;
  mediaSyncing = true;
  try {
    const ids = new Set();
    for (const c of state.clients) if (c.logoMediaId) ids.add(c.logoMediaId);
    for (const k of state.courses) for (const m of k.modules) for (const l of m.lessons) for (const src of l.sources) ids.add(src.mediaId);
    for (const id of ids) {
      if (state.media[id]) continue;
      const blob = await db.getBlob(id);
      if (!blob) continue;
      const mbs = (blob.size / 1048576).toFixed(0);
      cloud.status = { state: 'saving', text: `Enviando vídeo (${mbs} MB) para a nuvem…` };
      setCloudStatus(cloud.status);
      try {
        const info = await cloudUploadMedia(id, blob, (f) => setCloudStatus({ state: 'saving', text: `Enviando vídeo (${mbs} MB) para a nuvem… ${Math.round(f * 100)}%` }));
        if (info) { state.media[id] = info; save(); }
      } catch (e) {
        console.warn(e);
        setCloudStatus({ state: 'err', text: e?.code === 'too_large' || e?.code === 'quota_exceeded' ? 'Espaço da nuvem cheio: o vídeo ficou só neste aparelho' : 'Vídeo não enviado à nuvem (tentaremos de novo)' });
        break;
      }
    }
    if (cloud.status.state === 'saving') setCloudStatus({ state: 'ok', text: 'Salvo na nuvem' });
  } finally { mediaSyncing = false; }
}
window.addEventListener('ec-media-added', () => setTimeout(syncMedia, 500));

function setCloudStatus(st) {
  const time = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const icon = { ok: '☁︎', saving: '⟳', err: '!', off: '◌' }[st.state] || '☁︎';
  const txt = st.state === 'ok' ? `${st.text} · ${time}` : st.text;
  for (const el of document.querySelectorAll('[data-cloud]')) { el.dataset.state = st.state; el.textContent = `${icon} ${txt}`; el.title = txt; }
}

const busy = () => editor?.player?.playing || document.querySelector('#rProg:not([hidden]), #aProg:not([hidden]), .steps .run');

(async () => {
  await load();
  try { navigator.storage?.persist?.(); } catch {}
  route();
  // fontes dos modelos (Inter Tight, JetBrains Mono, Playfair, Anton): redesenha quando chegarem
  Promise.all(['Inter Tight', 'JetBrains Mono', 'Playfair Display', 'Anton', 'Inter'].map((f) => document.fonts.load(`700 40px "${f}"`).catch(() => {})))
    .then(() => { try { editor?.player?.draw(); } catch {} });
  // Depois que a tela abriu, baixa em segundo plano o leitor de vídeo (fica pronto quando você enviar uma aula).
  setTimeout(() => (window.requestIdleCallback || ((f) => f()))(() => { import('../vendor/mediabunny.min.mjs').catch(() => {}); import('./render-offline.js').catch(() => {}); }), 3500);
  if (state.storageError) toast('Este navegador não permite salvar dados (janela anônima?). O trabalho será perdido ao fechar.', 'err');

  // Nuvem ao vivo (quando aberto no claude.ai)
  cloud.onStatus(setCloudStatus);
  if (await cloudInit()) {
    db.remote = (id) => cloudFetchMedia(state.media[id]);
    if (await cloudPull(state)) { save({ touch: false }); route(); toast('Seus projetos foram carregados da nuvem', 'ok'); }
    else if (state.updatedAt) cloudPush(state);
    cloudWatch(async () => {
      if (busy()) { toast('Há mudanças feitas em outro aparelho. Elas entram quando você sair desta tela.'); return; }
      if (await cloudPull(state)) { save({ touch: false }); route(); toast('Atualizado com as mudanças do outro aparelho', 'ok'); }
    });
    syncMedia();
    setInterval(syncMedia, 90_000);
    cloudUsage().then((u) => u && console.info('Nuvem:', u));

  } else setCloudStatus({ state: 'off', text: 'Só neste aparelho' });
  startMarketing(onMktChange).catch((e) => console.warn('Estúdio de Marketing', e));
})();
