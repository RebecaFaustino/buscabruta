// Modelos de vídeo: cada um define fontes, paleta, look, moldura (letterbox, vinheta, granulado, grade),
// legenda, cartões de destaque, nome na tela e abertura. Tudo em português, com estética internacional.

export const FONTS = {
  inter: 'Inter, system-ui, sans-serif',
  tight: '"Inter Tight", Inter, system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, monospace',
  serif: '"Playfair Display", Georgia, serif',
  impact: 'Anton, "Inter Tight", Impact, sans-serif',
};

export const TEMPLATES = {
  clinico: {
    name: 'Clínica Clean', ref: 'Limpo e confiável, para qualquer especialidade',
    palette: { primary: '#0F3D3E', accent: '#2BB3A3', text: '#FFFFFF' },
    look: 'brightness(1.06) contrast(1.05) saturate(0.95)',
    frame: { letterbox: 0, vignette: 0, grain: 0, grid: false },
    caption: { mode: 'karaoke', font: 'inter', weight: 600, size: 48, upper: false, box: 'dark', active: 'bg', tracking: 0 },
    card: { variant: 'light', font: 'inter', weight: 700, upper: true, eyebrow: '', radius: 20, size: 72 },
    lower: 'light', opening: 'solid',
  },
  cinema: {
    name: 'Cinema Noir', ref: 'Preto e branco, faixas de cinema e granulado (estilo filme)',
    palette: { primary: '#0A0A0A', accent: '#E8E2D6', text: '#F4F1EA' },
    look: 'grayscale(1) contrast(1.18) brightness(0.96)',
    frame: { letterbox: 0.11, vignette: 0.55, grain: 0.07, grid: false },
    caption: { mode: 'limpa', font: 'inter', weight: 400, size: 40, upper: false, box: 'none', active: 'color', tracking: 0.01 },
    card: { variant: 'minimal', font: 'tight', weight: 300, upper: true, eyebrow: '', radius: 0, size: 64, tracking: 0.28 },
    lower: 'line', opening: 'cinema',
  },
  blueprint: {
    name: 'Blueprint Tech', ref: 'Grade azul, etiquetas em fonte mono e cartões escuros (estilo “Achado do GitHub”)',
    palette: { primary: '#0B1226', accent: '#4ADE80', text: '#FFFFFF' },
    look: 'contrast(1.06) saturate(1.05)',
    frame: { letterbox: 0, vignette: 0.15, grain: 0, grid: true },
    caption: { mode: 'bloco', font: 'tight', weight: 700, size: 46, upper: false, box: 'dark', active: 'color', tracking: 0 },
    card: { variant: 'dark', font: 'tight', weight: 800, upper: false, eyebrow: 'PONTO-CHAVE', radius: 22, size: 70 },
    lower: 'dark', opening: 'grid',
  },
  editorial: {
    name: 'Editorial Verde', ref: 'Tipografia grande e firme, tons de papel e verde (estilo revista)',
    palette: { primary: '#211F2E', accent: '#5B8A4A', text: '#FFFFFF' },
    look: 'brightness(1.04) contrast(1.04) saturate(0.92)',
    frame: { letterbox: 0, vignette: 0, grain: 0, grid: false },
    caption: { mode: 'bloco', font: 'inter', weight: 600, size: 44, upper: false, box: 'light', active: 'color', tracking: 0 },
    card: { variant: 'light', font: 'tight', weight: 800, upper: false, eyebrow: 'DESTAQUE', radius: 14, size: 74, tracking: -0.02 },
    lower: 'light', opening: 'editorial',
  },
  impacto: {
    name: 'Impacto', ref: 'Legenda gigante palavra a palavra, amarelo e contorno forte (estilo Hormozi)',
    palette: { primary: '#111111', accent: '#FFE14D', text: '#FFFFFF' },
    look: 'contrast(1.12) saturate(1.15)',
    frame: { letterbox: 0, vignette: 0.25, grain: 0, grid: false },
    caption: { mode: 'palavra', font: 'impact', weight: 400, size: 92, upper: true, box: 'none', active: 'scale', tracking: 0.01 },
    card: { variant: 'tag', font: 'impact', weight: 400, upper: true, eyebrow: '', radius: 8, size: 84 },
    lower: 'bar', opening: 'solid',
  },
  suave: {
    name: 'Suave Pastel', ref: 'Cartões arredondados, sombras macias e legenda em pílula clara (estilo Ali Abdaal)',
    palette: { primary: '#1F2A44', accent: '#7C9CFF', text: '#FFFFFF' },
    look: 'brightness(1.07) contrast(0.97) saturate(0.95)',
    frame: { letterbox: 0, vignette: 0, grain: 0, grid: false },
    caption: { mode: 'karaoke', font: 'inter', weight: 600, size: 44, upper: false, box: 'light', active: 'color', tracking: 0 },
    card: { variant: 'glass', font: 'tight', weight: 700, upper: false, eyebrow: '', radius: 30, size: 68 },
    lower: 'light', opening: 'solid',
  },
  luxo: {
    name: 'Luxo Dourado', ref: 'Fundo escuro, dourado e serifa elegante (estética premium)',
    palette: { primary: '#14110D', accent: '#C9A45C', text: '#F6EFE2' },
    look: 'contrast(1.08) saturate(0.85) sepia(0.12)',
    frame: { letterbox: 0, vignette: 0.45, grain: 0.03, grid: false },
    caption: { mode: 'limpa', font: 'serif', weight: 400, size: 44, upper: false, box: 'none', active: 'color', tracking: 0.01 },
    card: { variant: 'outline', font: 'serif', weight: 400, upper: true, eyebrow: '', radius: 0, size: 62, tracking: 0.18 },
    lower: 'line', opening: 'cinema',
  },
  documentario: {
    name: 'Documentário', ref: 'Faixas finas, legenda creme e barra de destaque (estilo série documental)',
    palette: { primary: '#1A1A1A', accent: '#E50914', text: '#FFFFFF' },
    look: 'contrast(1.1) saturate(0.9) brightness(0.97)',
    frame: { letterbox: 0.07, vignette: 0.35, grain: 0.04, grid: false },
    caption: { mode: 'limpa', font: 'inter', weight: 500, size: 42, upper: false, box: 'none', active: 'color', tracking: 0, color: '#FFF1C9' },
    card: { variant: 'bar', font: 'tight', weight: 800, upper: true, eyebrow: '', radius: 4, size: 64, tracking: 0.04 },
    lower: 'bar', opening: 'cinema',
  },
};

export const PALETTES = [
  { name: 'Verde clínico', primary: '#0F3D3E', accent: '#2BB3A3', text: '#FFFFFF' },
  { name: 'Azul confiança', primary: '#0E2A47', accent: '#3B82F6', text: '#FFFFFF' },
  { name: 'Rosa pediatria', primary: '#4A1D3F', accent: '#F472B6', text: '#FFFFFF' },
  { name: 'Dourado premium', primary: '#14110D', accent: '#C9A45C', text: '#F6EFE2' },
  { name: 'Grafite & lima', primary: '#0B1226', accent: '#4ADE80', text: '#FFFFFF' },
  { name: 'Lavanda', primary: '#2E2350', accent: '#A78BFA', text: '#FFFFFF' },
  { name: 'Coral', primary: '#3A1414', accent: '#FB7185', text: '#FFFFFF' },
  { name: 'Oceano', primary: '#062C30', accent: '#22D3EE', text: '#FFFFFF' },
  { name: 'Amarelo impacto', primary: '#111111', accent: '#FFE14D', text: '#FFFFFF' },
  { name: 'Verde editorial', primary: '#211F2E', accent: '#5B8A4A', text: '#FFFFFF' },
];

export const CAPTION_MODES = {
  auto: 'Do modelo',
  karaoke: 'Frase com palavra ativa destacada',
  palavra: 'Palavra a palavra (dinâmica)',
  bloco: 'Bloco de frase em caixa',
  limpa: 'Limpa, sem caixa (cinema)',
  nenhuma: 'Sem legenda na imagem (só .srt)',
};

export const CARD_VARIANTS = {
  auto: 'Do modelo', light: 'Cartão claro', dark: 'Cartão escuro', glass: 'Vidro suave', outline: 'Contorno fino',
  minimal: 'Minimalista (linha)', tag: 'Etiqueta de impacto', bar: 'Barra lateral',
};

// Estilo final = modelo + ajustes do cliente (cores, sombra, tamanho da legenda, variantes escolhidas).
export function resolveStyle(cl = {}) {
  const t = TEMPLATES[cl.template] || TEMPLATES.clinico;
  const cap = { ...t.caption };
  if (cl.captionStyle && cl.captionStyle !== 'auto' && CAPTION_MODES[cl.captionStyle]) cap.mode = cl.captionStyle;
  cap.size *= cl.captionScale || 1;
  const card = { ...t.card };
  if (cl.cardVariant && cl.cardVariant !== 'auto') card.variant = cl.cardVariant;
  if (cl.cardEyebrow !== undefined && cl.cardEyebrow !== null) card.eyebrow = cl.cardEyebrow;
  // fontes da marca do cliente (substituem as do modelo)
  if (cl.fontTitle) card.font = 'x:' + cl.fontTitle;
  if (cl.fontBody) cap.font = 'x:' + cl.fontBody;
  return {
    ...t, caption: cap, card,
    primary: cl.primary || t.palette.primary, accent: cl.accent || t.palette.accent, text: cl.text || t.palette.text,
    shadow: cl.shadow ?? 0.6,
    look: cl.look && cl.look !== 'auto' ? null : t.look,
  };
}
