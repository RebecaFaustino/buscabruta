// Capa da aula (miniatura 1280×720 para Hotmart, Eduzz, Sympla e YouTube) no estilo do cliente.
import { resolveStyle, FONTS } from './styles.js';
import { LOOKS } from './presets.js';

function wrap(g, text, maxW, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (g.measureText(t).width <= maxW || !line) line = t;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…'; }
  return lines;
}

export function drawCover(canvas, frame, cl, { title, module = '', number = '' } = {}) {
  const W = canvas.width, H = canvas.height, u = H / 720;
  const g = canvas.getContext('2d');
  const st = resolveStyle(cl);
  const textSide = cl.expertSide === 'right' ? 'left' : 'right';
  g.save();
  g.fillStyle = st.primary; g.fillRect(0, 0, W, H);
  if (frame) {
    const vw = frame.width, vh = frame.height;
    const sc = Math.max(W / vw, H / vh) * 1.08, dw = vw * sc, dh = vh * sc;
    const fx = cl.focusX ?? 0.5;
    // expert empurrado para o lado dele, abrindo espaço para o título
    let dx = (textSide === 'right' ? W * 0.3 : W * 0.7) - fx * dw;
    dx = Math.min(0, Math.max(W - dw, dx));
    const look = cl.look && cl.look !== 'auto' && LOOKS[cl.look] ? LOOKS[cl.look].filter : st.look || 'none';
    g.filter = look; g.drawImage(frame, dx, (H - dh) * 0.4, dw, dh); g.filter = 'none';
  }
  // véu na cor da marca do lado do texto
  const gr = textSide === 'right' ? g.createLinearGradient(W * 0.3, 0, W, 0) : g.createLinearGradient(W * 0.7, 0, 0, 0);
  gr.addColorStop(0, st.primary + '00'); gr.addColorStop(0.45, st.primary + 'd9'); gr.addColorStop(1, st.primary + 'f2');
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
  const pad = 64 * u, boxW = W * 0.5 - pad;
  const x = textSide === 'right' ? W - pad - boxW : pad;
  const fam = FONTS[st.card.font] || FONTS.tight;
  g.textBaseline = 'alphabetic'; g.textAlign = 'left';
  // etiqueta
  const eyebrow = [module, number].filter(Boolean).join(' · ').toUpperCase();
  let y = H * 0.3;
  if (eyebrow) {
    g.font = `700 ${20 * u}px ${FONTS.inter}`; g.fillStyle = st.accent;
    g.fillText(eyebrow.slice(0, 48), x, y); y += 24 * u;
  }
  g.fillStyle = st.accent; g.fillRect(x, y, 56 * u, 6 * u); y += 52 * u;
  // título
  let size = 68 * u, lines;
  for (; size > 34 * u; size -= 4 * u) {
    g.font = `${st.card.weight >= 600 ? 800 : st.card.weight} ${size}px ${fam}`;
    lines = wrap(g, st.card.upper ? title.toUpperCase() : title, boxW, 4);
    if (lines.length <= 3 && lines.every((l) => g.measureText(l).width <= boxW)) break;
  }
  g.fillStyle = st.text;
  g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 18 * u * (cl.shadow ?? 0.6);
  for (const l of lines) { g.fillText(l, x, y); y += size * 1.08; }
  g.shadowBlur = 0;
  // nome + CRM
  y = H - pad;
  g.font = `400 ${20 * u}px ${FONTS.inter}`; g.fillStyle = st.text; g.globalAlpha = 0.8;
  const sub = [cl.specialty, cl.crm].filter(Boolean).join(' · ');
  if (sub) { g.fillText(sub, x, y); y -= 30 * u; }
  g.globalAlpha = 1; g.font = `700 ${26 * u}px ${FONTS.inter}`;
  g.fillText(cl.name || '', x, y);
  g.restore();
}
