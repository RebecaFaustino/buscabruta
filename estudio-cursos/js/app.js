import { db } from './db.js';
import { state, save, load, uid, newClient, newCourse, newModule, newLesson, getClient, getCourse, findLesson } from './state.js';
import { PLATFORMS, LOOKS, CAPTION_STYLES } from './presets.js';
import { analyze, speechRanges, decodePCM16k } from './audio.js';
import { phrases, spread, parseSubs, srt, vtt, timelineCaptions, suggestKeywords, autoCards, norm } from './captions.js';
import { Player } from './player.js';
import { renderLesson, extOf, pickMime } from './render.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (t) => { t = Math.max(0, t || 0); const m = Math.floor(t / 60), s = Math.floor(t % 60), d = Math.floor((t % 1) * 10); return `${m}:${String(s).padStart(2, '0')}.${d}`; };
const fmtLong = (t) => { t = Math.round(t || 0); const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60; return h ? `${h}h${String(m).padStart(2, '0')}` : `${m}min ${String(s).padStart(2, '0')}s`; };
const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
const slug = (s) => norm(s).replace(/\s+/g, '-').slice(0, 60) || 'aula';
const lessonDur = (l) => l.clips.reduce((a, c) => a + c.out - c.in, 0);
const rawDur = (l) => l.sources.reduce((a, s) => a + (s.duration || 0), 0);

const view = $('#view');
let whisperOK;
function whisperAvailable() {
  whisperOK ??= fetch('https://huggingface.co/api/models/Xenova/whisper-base', { method: 'HEAD', mode: 'no-cors', cache: 'no-store' })
    .then(() => true, () => false);
  return whisperOK;
}
const envs = new Map(); // srcId -> envelope (forma de onda)

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

async function download(blob, name) {
  let ext = name.split('.').pop().toLowerCase();
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
function go(hash) {
  cur = hash;
  try { localStorage.setItem('ec-route', hash); } catch {}
  document.body.classList.remove('menu-open');
  route();
  window.scrollTo(0, 0);
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
  if (page === 'cliente' && getClient(a)) return viewClient(getClient(a));
  if (page === 'curso' && getCourse(a)) return viewCourse(getCourse(a));
  if (page === 'aula' && getCourse(a)) return viewEditor(getCourse(a), b);
  if (page === 'exportar' && getCourse(a)) return viewExport(getCourse(a));
  viewHome();
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
  const lessons = state.courses.flatMap((c) => c.modules.flatMap((m) => m.lessons));
  const rendered = lessons.filter((l) => l.render).length;
  view.innerHTML = `
    <header class="page-head">
      <div><p class="eyebrow">Estúdio de Cursos</p><h1>Painel</h1></div>
    </header>
    <section class="stats">
      <div><b>${state.clients.length}</b><span>clientes</span></div>
      <div><b>${state.courses.length}</b><span>cursos</span></div>
      <div><b>${lessons.length}</b><span>aulas</span></div>
      <div><b>${rendered}</b><span>aulas prontas para exportar</span></div>
    </section>
    <h2 class="section-title">Clientes</h2>
    <section class="grid">
      ${state.clients.map((c) => {
        const cs = state.courses.filter((k) => k.clientId === c.id);
        return `<a class="card client-card" href="#/cliente/${c.id}">
          <div class="swatch" style="background:${esc(c.primary)}"><span style="background:${esc(c.accent)}"></span></div>
          <h3>${esc(c.name)}</h3>
          <p>${esc(c.specialty || '—')} ${c.crm ? '· ' + esc(c.crm) : ''}</p>
          <p class="muted">${cs.length} curso(s) · ${PLATFORMS[c.platform]?.name || ''}</p>
        </a>`;
      }).join('')}
      <button class="card add-card" id="homeNewClient">+ Novo cliente</button>
    </section>
    <h2 class="section-title">Fluxo recomendado</h2>
    <ol class="flow">
      <li><b>Perfil do cliente</b> — cores, logo, CRM, palavras-chave e lado do expert.</li>
      <li><b>Estrutura do curso</b> — módulos e aulas.</li>
      <li><b>Edição</b> — importe as gravações, gere os cortes secos, junte clipes, aplique zoom dinâmico.</li>
      <li><b>Legendas</b> — transcrição automática no navegador e revisão.</li>
      <li><b>Destaques</b> — palavras-chave animadas ao lado do expert.</li>
      <li><b>Exportar</b> — preset da plataforma (Hotmart, Eduzz, Sympla, Kiwify…) e pacote .zip.</li>
    </ol>`;
  $('#homeNewClient').onclick = () => $('#newClientBtn').click();
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
      </section>
      <section class="panel">
        <h2>Padrão de edição</h2>
        <div class="form">
          ${select('expertSide', 'Posição do expert no vídeo', c.expertSide, { left: 'Expert à esquerda → destaques à direita', right: 'Expert à direita → destaques à esquerda' })}
          ${range('focusX', 'Centro do rosto (horizontal) para zoom', c.focusX ?? 0.5, 0, 1, 0.01)}
          ${select('look', 'Look de cor', c.look, Object.fromEntries(Object.entries(LOOKS).map(([k, v]) => [k, v.name])))}
          ${select('captionStyle', 'Estilo de legenda', c.captionStyle, CAPTION_STYLES)}
          ${select('captionPos', 'Posição da legenda', c.captionPos, { bottom: 'Rodapé', middle: 'Terço inferior' })}
          ${select('platform', 'Plataforma padrão', c.platform, Object.fromEntries(Object.entries(PLATFORMS).map(([k, v]) => [k, v.name])))}
          <div class="checks">
            ${check('cleanVoice', 'Voz limpa (EQ + compressor)', c.cleanVoice)}
            ${check('autoZoom', 'Zoom dinâmico nos cortes', c.autoZoom)}
            ${check('smoothZoom', 'Zoom suave contínuo', c.smoothZoom)}
            ${check('openingTitle', 'Abertura com título da aula', c.openingTitle)}
            ${check('lowerThird', 'Nome + CRM na tela', c.lowerThird)}
            ${check('watermark', 'Logo no canto', c.watermark)}
          </div>
          <h3>Cortes secos</h3>
          ${range('silenceDb', 'Limiar de silêncio (dB)', c.silenceDb, -60, -20, 1)}
          ${range('minSilence', 'Pausa mínima para cortar (s)', c.minSilence, 0.15, 1.5, 0.05)}
          ${range('padding', 'Respiro em cada corte (s)', c.padding, 0, 0.3, 0.01)}
        </div>
      </section>
    </div>
    <h2 class="section-title">Cursos</h2>
    <section class="grid">
      ${courses.map((k) => `<a class="card" href="#/curso/${k.id}"><h3>${esc(k.title)}</h3>
        <p class="muted">${k.modules.length} módulo(s) · ${k.modules.reduce((a, m) => a + m.lessons.length, 0)} aula(s)</p></a>`).join('')}
      <button class="card add-card" id="newCourse">+ Novo curso</button>
    </section>`;

  bindForm(view, c, () => { renderSidebar(); $('h1').textContent = c.name; });
  showLogo(c);
  $('#logoInput').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const id = uid('logo');
    await db.putMedia(id, f);
    c.logoMediaId = id;
    save();
    showLogo(c);
  };
  chipEditor($('#kwChips'), $('#kwForm'), c);
  $('#newCourse').onclick = () => { const k = newCourse(c.id); state.courses.push(k); save(); go('#/curso/' + k.id); };
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
          <input class="ed-title" id="lesTitle" value="${esc(lesson.title)}">
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
            <button data-tab="visual">Visual</button>
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
      g.fillText(fmtLong(t).replace('min ', ':').replace('s', ''), x + 3, 2);
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
  view.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { ed.tab = b.dataset.tab; renderTab(); }));
  const body = $('#tabBody');
  function renderTab() {
    view.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === ed.tab));
    ({ cortes: tabCortes, legendas: tabLegendas, destaques: tabDestaques, visual: tabVisual, exportar: tabExportar })[ed.tab]();
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
      <div class="btn-row">
        <button class="ghost" id="zoomAll">Zoom dinâmico em todos</button>
        <button class="ghost" id="zoomNone">Remover zooms</button>
        <button class="ghost" id="dropShort">Remover clipes &lt; 0,4 s</button>
      </div>
      <p class="hint">${lesson.clips.length} clipe(s) na linha do tempo.</p>`;
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
      await db.delMedia(s.mediaId);
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
    files = files.filter((f) => /^(video|audio)\//.test(f.type) || /\.(mp4|mov|m4v|webm|mkv|mp3|wav|m4a)$/i.test(f.name));
    if (!files.length) return;
    ed.snapshot();
    for (const f of files) {
      toast(`Importando ${f.name}…`);
      const mediaId = uid('vid');
      await db.putMedia(mediaId, f);
      const duration = await new Promise((r) => {
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.onloadedmetadata = () => r(v.duration);
        v.onerror = () => r(0);
        v.src = URL.createObjectURL(f);
      });
      if (!duration || !isFinite(duration)) { toast(`Não foi possível ler ${f.name}. Converta para MP4 (H.264).`, 'err'); continue; }
      const src = { id: uid('src'), mediaId, name: f.name, duration };
      lesson.sources.push(src);
      lesson.clips.push({ id: uid('clip'), srcId: src.id, in: 0, out: duration, zoom: 1 });
      loadEnv(src, f);
    }
    await player.setLesson(lesson, client);
    fitZoom();
    ed.changed(); renderTab();
    toast('Vídeo importado. Próximo passo: “Gerar cortes secos”.', 'ok');
  }

  async function loadEnv(src, blob) {
    if (envs.has(src.id)) return envs.get(src.id);
    let env = await db.getMedia('env:' + src.id);
    if (!env) {
      try {
        blob = blob || await db.getMedia(src.mediaId);
        env = (await analyze(blob)).env;
        await db.putMedia('env:' + src.id, env);
      } catch (err) { console.warn(err); return null; }
    }
    envs.set(src.id, env);
    drawTimeline();
    return env;
  }

  async function autoCut() {
    if (!lesson.sources.length) return toast('Importe um vídeo primeiro.');
    const btn = $('#autoCut');
    btn.disabled = true; btn.textContent = 'Analisando áudio…';
    try {
      const clips = [];
      for (const s of lesson.sources) {
        const env = await loadEnv(s);
        if (!env) { toast(`Sem áudio legível em ${s.name}`, 'err'); continue; }
        for (const r of speechRanges(env, client)) clips.push({ id: uid('clip'), srcId: s.id, in: r.in, out: Math.min(r.out, s.duration), zoom: 1 });
      }
      if (!clips.length) return toast('Nenhuma fala detectada — reduza o limiar (dB).', 'err');
      if (client.autoZoom) clips.forEach((c, i) => (c.zoom = i % 2 ? 1.15 : 1));
      ed.snapshot();
      const before = lessonDur(lesson);
      lesson.clips = clips;
      ed.changed(); player.seek(0); fitZoom(); drawTimeline(); renderTab();
      toast(`${clips.length} cortes · ${fmtLong(before - lessonDur(lesson))} de pausas removidas`, 'ok');
    } finally { btn.disabled = false; btn.textContent = 'Gerar cortes secos'; }
  }

  // ----- Aba: Legendas -----
  function tabLegendas() {
    const caps = timelineCaptions(lesson);
    body.innerHTML = `
      <div id="autoBox">
        <h3>Transcrição automática</h3>
        <p class="hint">Roda no próprio aparelho (Whisper). Na 1ª vez baixa o modelo (~80–250 MB). O vídeo não sai do aparelho.</p>
        <label>Modelo<select id="model">
          <option value="onnx-community/whisper-base_timestamped|1">Rápido — palavra a palavra</option>
          <option value="onnx-community/whisper-small_timestamped|1">Preciso — palavra a palavra (mais lento)</option>
          <option value="Xenova/whisper-small|0">Preciso — por frase</option>
        </select></label>
        <div class="btn-row"><button class="btn" id="transcribe">Transcrever aula</button></div>
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
      ${select('captionStyle', 'Estilo na tela', client.captionStyle, CAPTION_STYLES)}
      <h3>Revisão <small class="muted">${caps.length} frases</small></h3>
      <div class="btn-row" id="aiRow" hidden><button class="ghost" id="aiFix">Revisar termos médicos com IA</button></div>
      <p class="hint">Corrija termos técnicos aqui. Toque no horário para ir até o trecho.</p>
      <div class="caps" id="capList">${editableCaps()}</div>`;
    bindForm(body, client, () => player.draw());
    whisperAvailable().then((ok) => {
      if (ok || !$('#autoBox')) return;
      $('#autoBox').innerHTML = `<h3>Transcrição automática</h3><p class="hint">Nesta versão online a transcrição automática não está disponível (o navegador bloqueia o download do modelo). Use <b>Sincronizar roteiro</b> ou importe um .srt — por exemplo, a legenda automática gerada pelo YouTube, CapCut ou pela própria plataforma.</p>`;
    });
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
    const items = [];
    for (const s of lesson.sources) phrases(lesson.words[s.id] || []).forEach((p) => items.push({ s, p, text: p.words.map((w) => w.w).join(' ') }));
    if (!items.length) return toast('Ainda não há legenda para revisar.');
    const btn = $('#aiFix');
    btn.disabled = true;
    ed.snapshot();
    let changed = 0;
    try {
      for (let i = 0; i < items.length; i += 60) {
        btn.textContent = `Revisando ${Math.min(i + 60, items.length)}/${items.length}…`;
        const batch = items.slice(i, i + 60);
        const out = await smp.json(`Você revisa legendas de uma aula em português do Brasil de ${client.name} (${client.specialty || 'medicina'}).
Corrija apenas grafia de termos médicos, nomes de medicamentos, siglas, acentuação e pontuação. Não reescreva, não resuma, não mude o sentido.
Palavras-chave do expert: ${client.keywords.join(', ') || 'nenhuma'}.
Responda somente com um array JSON de ${batch.length} strings, na mesma ordem:
${JSON.stringify(batch.map((b) => b.text))}`, { modelTier: 'quick' });
        if (!Array.isArray(out) || out.length !== batch.length) continue;
        // aplica de trás para frente para não deslocar índices
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
      ed.changed(); renderTab();
      toast(changed ? `${changed} frase(s) corrigida(s)` : 'Nenhuma correção necessária', 'ok');
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

  let worker;
  async function transcribe() {
    if (!lesson.sources.length) return toast('Importe um vídeo primeiro.');
    const [model, wordsFlag] = $('#model').value.split('|');
    const prog = $('#trProg'), bar = prog.querySelector('span'), lbl = prog.querySelector('em');
    const btn = $('#transcribe');
    btn.disabled = true; prog.hidden = false;
    worker = worker || new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
    const run = (pcm, mdl, words) => new Promise((res, rej) => {
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'load') { bar.style.width = (m.progress || 0) + '%'; lbl.textContent = `Baixando modelo… ${Math.round(m.progress || 0)}%`; }
        if (m.type === 'status') { bar.style.width = '100%'; bar.classList.add('pulse'); lbl.textContent = m.text; }
        if (m.type === 'done') res(m);
        if (m.type === 'error') rej(new Error(m.message));
      };
      worker.postMessage({ pcm, model: mdl, words }, [pcm.buffer]);
    });
    try {
      ed.snapshot();
      for (const s of lesson.sources) {
        lbl.textContent = `Lendo áudio de ${s.name}…`;
        const blob = await db.getMedia(s.mediaId);
        let out;
        try { out = await run(await decodePCM16k(blob), model, wordsFlag === '1'); }
        catch (err) {
          console.warn(err);
          lbl.textContent = 'Modelo palavra a palavra indisponível, usando modelo por frase…';
          out = await run(await decodePCM16k(blob), 'Xenova/whisper-base', false);
          out.fallback = true;
        }
        const words = [];
        for (const ch of out.chunks) {
          const [a, b] = ch.timestamp || [0, 0];
          const txt = (ch.text || '').trim();
          if (!txt) continue;
          if (wordsFlag === '1' && !out.fallback) words.push({ w: txt, s: a, e: b ?? a + 0.3 });
          else words.push(...spread(txt, a, b ?? a + 2));
        }
        lesson.words[s.id] = words;
      }
      ed.changed(); toast('Transcrição concluída. Revise os termos técnicos.', 'ok');
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
    body.innerHTML = `
      <p class="hint">Estas opções pertencem ao perfil de <b>${esc(client.name)}</b> e valem para todas as aulas dele.</p>
      ${select('expertSide', 'Posição do expert', client.expertSide, { left: 'Expert à esquerda → destaques à direita', right: 'Expert à direita → destaques à esquerda' })}
      ${range('focusX', 'Centro do rosto (zoom/vertical)', client.focusX ?? 0.5, 0, 1, 0.01)}
      ${select('look', 'Look de cor', client.look, Object.fromEntries(Object.entries(LOOKS).map(([k, v]) => [k, v.name])))}
      ${select('captionPos', 'Posição da legenda', client.captionPos, { bottom: 'Rodapé', middle: 'Terço inferior' })}
      <div class="row3">${color('primary', 'Principal', client.primary)}${color('accent', 'Destaque', client.accent)}${color('text', 'Texto', client.text)}</div>
      <div class="checks">
        ${check('cleanVoice', 'Voz limpa (EQ + compressor)', client.cleanVoice)}
        ${check('smoothZoom', 'Zoom suave contínuo', client.smoothZoom)}
        ${check('openingTitle', 'Abertura com título', client.openingTitle)}
        ${check('lowerThird', 'Nome + CRM', client.lowerThird)}
        ${check('watermark', 'Logo no canto', client.watermark)}
      </div>`;
    bindForm(body, client, (k) => { if (k === 'cleanVoice') player.refreshAudio(); lesson.render = null; player.draw(); drawTimeline(); });
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
Tom: profissional, acolhedor, claro para leigos, sem promessas de cura e respeitando as normas de publicidade médica do CFM.
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
        await db.putMedia(mediaId, blob);
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
    $('#dlVid').onclick = async () => download(await db.getMedia(r.mediaId), `${base}.${r.ext}`);
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
        await db.putMedia(mediaId, blob);
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
    if (!window.JSZip) return toast('Biblioteca de zip não carregou (sem internet?).', 'err');
    const btn = $('#zipBtn');
    btn.disabled = true; btn.textContent = 'Montando pacote…';
    const z = new JSZip();
    const root = z.folder(slug(course.title));
    for (const { m, mi, l, li } of all) {
      const dir = root.folder(`${String(mi + 1).padStart(2, '0')}-${slug(m.title)}`);
      const base = `${String(li + 1).padStart(2, '0')}-${slug(l.title)}`;
      if (l.render) dir.file(`${base}.${l.render.ext}`, await db.getMedia(l.render.mediaId), { binary: true, compression: 'STORE' });
      const caps = timelineCaptions(l);
      if (caps.length) dir.file(`${base}.srt`, srt(caps));
      if (l.description) dir.file(`${base}-descricao.txt`, l.description);
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
(async () => {
  await load();
  try { navigator.storage?.persist?.(); } catch {}
  route();
  if (state.storageError) toast('Este navegador não permite salvar dados (janela anônima?). O trabalho será perdido ao fechar.', 'err');
})();
