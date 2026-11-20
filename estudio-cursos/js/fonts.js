// Fontes de marca (Google Fonts, gratuitas). Carregadas só quando um cliente usa.
// Fontes pagas comuns em manuais de marca são trocadas pela gratuita mais parecida.
export const FONT_LIST = [
  'Inter', 'Poppins', 'Montserrat', 'Nunito', 'Nunito Sans', 'Open Sans', 'Lato', 'DM Sans', 'Figtree', 'Raleway',
  'Quicksand', 'Fredoka', 'Baloo 2', 'Bricolage Grotesque', 'Anton', 'Bebas Neue', 'Oswald',
  'Playfair Display', 'DM Serif Display', 'Lora', 'Libre Baskerville', 'Merriweather', 'Fraunces', 'Roboto Slab',
];
const ALIAS = {
  gotham: 'Montserrat', 'gotham rounded': 'Nunito', avenir: 'Nunito Sans', 'avenir next': 'Nunito Sans', museo: 'Nunito Sans',
  'museo sans': 'Nunito Sans', 'museo slab': 'Roboto Slab', helvetica: 'Inter', arial: 'Inter', 'sf pro': 'Inter', futura: 'Poppins',
  'proxima nova': 'Montserrat', 'circular': 'DM Sans', 'brandon grotesque': 'Raleway', 'garamond': 'Libre Baskerville',
};
const SERIF = new Set(['Playfair Display', 'DM Serif Display', 'Lora', 'Libre Baskerville', 'Merriweather', 'Fraunces', 'Roboto Slab']);

// Normaliza o nome digitado (ou do manual) para uma fonte disponível.
export function fontName(raw) {
  const s = String(raw || '').trim().replace(/["']/g, '');
  if (!s) return '';
  const low = s.toLowerCase();
  if (ALIAS[low]) return ALIAS[low];
  return FONT_LIST.find((f) => f.toLowerCase() === low) || s;
}
export const fontStack = (fam) => `"${fam}", ${SERIF.has(fam) ? 'Georgia, serif' : 'Inter, system-ui, sans-serif'}`;

const loaded = new Map();
export function ensureFont(fam) {
  fam = fontName(fam);
  if (!fam || /^(inter|inter tight|anton|playfair display|jetbrains mono)$/i.test(fam)) return Promise.resolve();
  if (!loaded.has(fam)) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fam).replace(/%20/g, '+')}:wght@400;500;600;700;800&display=swap`;
    document.head.appendChild(link);
    loaded.set(fam, new Promise((res) => { link.onload = res; link.onerror = res; setTimeout(res, 4000); })
      .then(() => Promise.all([400, 600, 700, 800].map((w) => document.fonts.load(`${w} 40px "${fam}"`).catch(() => {})))));
  }
  return loaded.get(fam);
}
