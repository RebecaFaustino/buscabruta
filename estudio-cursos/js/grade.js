// Color grading profissional em WebGL2 (aceleração da placa de vídeo), no fluxo do DaVinci Resolve:
// conversão de câmera LOG → Rec.709, balanço de branco, exposição, sombras/realces, lift-gamma-gain,
// contraste com pivô, curva de filme (rolagem suave dos realces), pretos "matte", tons divididos,
// saturação/vibração, LUT 3D (.cube) com intensidade, vinheta e granulado de filme.
// A mesma função colore a prévia e cada quadro da exportação (4K incluso), então o que se vê é o que sai.

export const GRADE_LOOKS = {
  natural:   { name: 'Natural Rec.709', hint: 'Fiel à câmera, só um toque de contraste', p: { contrast: 1.04 } },
  clinico:   { name: 'Clínico claro', hint: 'Branco limpo, pele natural, confiável', p: { exposure: 0.08, temp: -0.08, contrast: 1.05, highlights: 0.15, saturation: 0.96 } },
  pele:      { name: 'Pele quente', hint: 'Consultório aconchegante, tons de pele bonitos', p: { temp: 0.22, tint: 0.04, contrast: 1.06, saturation: 1.04, vibrance: 0.15, shadowTint: [0.02, 0.0, -0.02], split: 0.6 } },
  tealorange:{ name: 'Cinema teal & orange', hint: 'O look de cinema: pele laranja, sombras azul-petróleo', p: { contrast: 1.14, saturation: 1.08, vibrance: 0.1, shadowTint: [-0.07, 0.02, 0.09], highTint: [0.08, 0.03, -0.06], split: 1, rolloff: 0.5, vignette: 0.25 } },
  kodak:     { name: 'Filme quente (estilo Kodak)', hint: 'Pretos lavados, realces dourados, granulado leve', p: { temp: 0.15, contrast: 1.08, matte: 0.05, saturation: 0.95, highTint: [0.06, 0.03, -0.03], shadowTint: [0.01, -0.01, 0.03], split: 0.9, rolloff: 0.7, grain: 0.35, vignette: 0.2 } },
  fuji:      { name: 'Filme frio (estilo Fuji)', hint: 'Verdes suaves, sombras ciano, delicado', p: { temp: -0.05, tint: -0.05, contrast: 1.04, matte: 0.04, saturation: 0.9, shadowTint: [-0.03, 0.03, 0.04], highTint: [0.02, 0.03, 0.0], split: 0.9, rolloff: 0.6, grain: 0.25 } },
  matte:     { name: 'Matte pastel (Reels claros)', hint: 'Claro, suave, pretos acinzentados', p: { exposure: 0.12, contrast: 0.9, matte: 0.1, saturation: 0.85, highlights: -0.1, highTint: [0.03, 0.01, 0.02], split: 0.7 } },
  editorial: { name: 'Editorial contraste', hint: 'Revista: contraste firme, cores vivas', p: { contrast: 1.2, saturation: 1.12, vibrance: 0.15, shadows: -0.08, rolloff: 0.4, vignette: 0.15 } },
  dourado:   { name: 'Dourado luxo', hint: 'Quente e elegante, realces em ouro', p: { temp: 0.28, contrast: 1.1, saturation: 0.92, highTint: [0.09, 0.05, -0.04], shadowTint: [0.02, 0.0, -0.03], split: 1, rolloff: 0.6, vignette: 0.3 } },
  frio:      { name: 'Hospital moderno (frio)', hint: 'Azul suave, tecnológico e limpo', p: { temp: -0.22, contrast: 1.08, saturation: 0.92, highlights: 0.1, shadowTint: [-0.02, 0.0, 0.05], split: 0.8 } },
  noite:     { name: 'Noite azul', hint: 'Dramático, azulado, para histórias', p: { exposure: -0.12, temp: -0.3, contrast: 1.15, saturation: 0.85, shadowTint: [-0.04, 0.0, 0.08], split: 1, vignette: 0.4 } },
  pb:        { name: 'P&B clássico', hint: 'Preto e branco suave', p: { saturation: 0, contrast: 1.1, matte: 0.03, grain: 0.3 } },
  pbforte:   { name: 'P&B alto contraste', hint: 'Preto e branco marcante', p: { saturation: 0, contrast: 1.35, shadows: -0.12, highlights: 0.08, vignette: 0.35, grain: 0.2 } },
  log709:    { name: 'Câmera em LOG → Rec.709', hint: 'Para vídeo gravado em LOG (imagem "lavada")', p: { log: 1, contrast: 1.05 } },
  logcinema: { name: 'LOG → Cinema', hint: 'LOG convertido já com look de cinema', p: { log: 1, contrast: 1.12, saturation: 1.05, shadowTint: [-0.06, 0.02, 0.08], highTint: [0.07, 0.03, -0.05], split: 1, rolloff: 0.5, vignette: 0.2 } },
};

export const GRADE_DEFAULTS = { log: 0, exposure: 0, temp: 0, tint: 0, contrast: 1, pivot: 0.43, shadows: 0, highlights: 0, matte: 0, saturation: 1, vibrance: 0, shadowTint: [0, 0, 0], highTint: [0, 0, 0], split: 0, rolloff: 0, vignette: 0, grain: 0, lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1] };

// Parâmetros finais do cliente (look escolhido × intensidade + ajustes finos). null = sem grading (vídeo original).
export function gradeParams(cl) {
  const g = cl?.grade;
  if (!g || (!g.look && !g.lutId && !g.adj)) return null;
  const base = { ...GRADE_DEFAULTS, ...(GRADE_LOOKS[g.look]?.p || {}) };
  const amt = g.amount ?? 1;
  const mix = (k) => {
    const d = GRADE_DEFAULTS[k], v = base[k];
    if (Array.isArray(d)) return d.map((x, i) => x + (v[i] - x) * amt);
    return k === 'log' ? v : d + (v - d) * amt;
  };
  const p = {};
  for (const k of Object.keys(GRADE_DEFAULTS)) p[k] = mix(k);
  const a = g.adj || {};
  p.exposure += a.exposure || 0;
  p.temp += a.temp || 0;
  p.tint += a.tint || 0;
  p.contrast *= 1 + (a.contrast || 0);
  p.saturation *= 1 + (a.saturation || 0);
  p.shadows += a.shadows || 0;
  p.highlights += a.highlights || 0;
  p.vignette = Math.min(1, p.vignette + (a.vignette || 0));
  p.grain = Math.min(1, p.grain + (a.grain || 0));
  p.lutId = g.lutId || null;
  p.lutAmount = g.lutAmount ?? 1;
  return p;
}

// ---------- LUT .cube ----------
const luts = new Map(); // id -> {size, data:Float32Array} | Promise
export function parseCube(text) {
  let size = 0, dmin = [0, 0, 0], dmax = [1, 1, 1];
  const vals = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const up = line.toUpperCase();
    if (up.startsWith('TITLE')) continue;
    if (up.startsWith('LUT_1D_SIZE')) throw new Error('Este arquivo é um LUT 1D. Use um LUT 3D (.cube).');
    if (up.startsWith('LUT_3D_SIZE')) { size = parseInt(line.split(/\s+/)[1], 10); continue; }
    if (up.startsWith('DOMAIN_MIN')) { dmin = line.split(/\s+/).slice(1, 4).map(Number); continue; }
    if (up.startsWith('DOMAIN_MAX')) { dmax = line.split(/\s+/).slice(1, 4).map(Number); continue; }
    const n = line.split(/\s+/).map(Number);
    if (n.length >= 3 && n.every((x) => isFinite(x))) vals.push(n[0], n[1], n[2]);
  }
  if (!size || vals.length < size * size * size * 3) throw new Error('Arquivo .cube inválido ou incompleto.');
  const data = new Float32Array(vals.slice(0, size * size * size * 3));
  for (let i = 0; i < data.length; i += 3) for (let c = 0; c < 3; c++) data[i + c] = (data[i + c] - dmin[c]) / ((dmax[c] - dmin[c]) || 1);
  return { size, data };
}
export function setLut(id, lut) { luts.set(id, lut); if (gl) gl._lutFor = null; }
export function hasLut(id) { const v = luts.get(id); return v && !(v instanceof Promise); }
export async function ensureLut(id, load) {
  if (!id) return null;
  const v = luts.get(id);
  if (v) return v instanceof Promise ? v : v;
  const p = (async () => { const txt = await load(id); const l = parseCube(txt); luts.set(id, l); return l; })().catch((e) => { luts.delete(id); console.warn('LUT', e); return null; });
  luts.set(id, p);
  return p;
}

// ---------- WebGL ----------
let gl = null, cv = null, prog = null, U = {}, srcTex = null, lutTex = null, failed = false;
const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = vec2((p.x+1.)*.5, 1.-(p.y+1.)*.5); gl_Position = vec4(p,0.,1.); }`;
const FS = `#version 300 es
precision highp float; precision mediump sampler3D;
in vec2 uv; out vec4 o;
uniform sampler2D src; uniform sampler3D lut; uniform float lutAmt, lutSize;
uniform float logm, exposure, temp, tint, contrast, pivot, shadows, highlights, matte, saturation, vibrance, split, rolloff, vignette, grain, seed, aspect;
uniform vec3 shTint, hiTint, lift, gam, gain;
float luma(vec3 c){ return dot(c, vec3(0.2126,0.7152,0.0722)); }
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)) + seed) * 43758.5453); }
void main(){
  vec3 c = texture(src, uv).rgb;
  if (logm > .5) { // LOG genérico (S-Log3, V-Log, C-Log, Apple Log aproximados) -> Rec.709
    c = clamp((c - 0.09) / 0.83, 0., 1.);
    c = c * c * (3. - 2. * c) * 0.55 + c * 0.45;
    float l0 = luma(c); c = mix(vec3(l0), c, 1.45);
  }
  c *= vec3(1. + temp * 0.12, 1. - tint * 0.06, 1. - temp * 0.12) * vec3(1., 1. + tint * 0.0, 1.);
  c *= exp2(exposure);
  float l = clamp(luma(c), 0., 1.);
  c += shadows * pow(1. - l, 2.) * 0.25 + highlights * l * l * 0.25;
  c = gain * (c + lift * (1. - c));
  c = pow(max(c, 0.), 1. / gam);
  c = pivot + (c - pivot) * contrast;
  if (rolloff > 0.) { vec3 k = max(c - 0.75, 0.); c = c - k + k / (1. + rolloff * 4. * k); }
  c = matte + c * (1. - matte);
  l = clamp(luma(c), 0., 1.);
  c += split * (shTint * pow(1. - l, 2.) + hiTint * l * l);
  l = luma(c);
  float sat = max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
  c = mix(vec3(l), c, saturation * (1. + vibrance * (1. - clamp(sat * 2., 0., 1.))));
  c = clamp(c, 0., 1.);
  if (lutAmt > 0.) { vec3 q = c * ((lutSize - 1.) / lutSize) + 0.5 / lutSize; c = mix(c, texture(lut, q).rgb, lutAmt); }
  if (vignette > 0.) { vec2 d = (uv - .5) * vec2(aspect, 1.); c *= 1. - vignette * 0.7 * smoothstep(0.35, 1.05, length(d) * 1.25); }
  if (grain > 0.) c += (hash(uv * 1024. + seed) - .5) * grain * 0.07;
  o = vec4(clamp(c, 0., 1.), 1.);
}`;

function init() {
  if (gl || failed) return !!gl;
  try {
    cv = document.createElement('canvas');
    gl = cv.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error('sem WebGL2');
    const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const n of ['src', 'lut', 'lutAmt', 'lutSize', 'logm', 'exposure', 'temp', 'tint', 'contrast', 'pivot', 'shadows', 'highlights', 'matte', 'saturation', 'vibrance', 'split', 'rolloff', 'vignette', 'grain', 'seed', 'aspect', 'shTint', 'hiTint', 'lift', 'gam', 'gain']) U[n] = gl.getUniformLocation(prog, n);
    srcTex = gl.createTexture(); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcTex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    lutTex = gl.createTexture(); gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, lutTex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, 2, 2, 2, 0, gl.RGB, gl.FLOAT, new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1]));
    gl.uniform1i(U.src, 0); gl.uniform1i(U.lut, 1);
    cv.addEventListener('webglcontextlost', () => { gl = null; failed = true; });
    return true;
  } catch (e) { console.warn('Color grading indisponível neste aparelho:', e); gl = null; failed = true; return false; }
}
export const gradingAvailable = () => init();

let frameSeed = 0;
// Colore img (vídeo, VideoFrame, canvas…) e devolve um canvas w×h com o resultado (ou null se não der).
export function gradeImage(img, w, h, p) {
  if (!p || !init()) return null;
  w = Math.max(2, Math.round(w)); h = Math.max(2, Math.round(h));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  gl.viewport(0, 0, w, h);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcTex);
  try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img); } catch (e) { return null; }
  const lut = p.lutId && hasLut(p.lutId) ? luts.get(p.lutId) : null;
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, lutTex);
  if (lut && gl._lutFor !== p.lutId) { gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, lut.size, lut.size, lut.size, 0, gl.RGB, gl.FLOAT, lut.data); gl._lutFor = p.lutId; }
  gl.uniform1f(U.lutAmt, lut ? p.lutAmount : 0); gl.uniform1f(U.lutSize, lut ? lut.size : 2);
  for (const k of ['exposure', 'temp', 'tint', 'contrast', 'pivot', 'shadows', 'highlights', 'matte', 'saturation', 'vibrance', 'split', 'rolloff', 'vignette', 'grain']) gl.uniform1f(U[k], p[k]);
  gl.uniform1f(U.logm, p.log || 0); gl.uniform1f(U.aspect, w / h); gl.uniform1f(U.seed, (frameSeed = (frameSeed + 1) % 997) * 0.37);
  gl.uniform3fv(U.shTint, p.shadowTint); gl.uniform3fv(U.hiTint, p.highTint);
  gl.uniform3fv(U.lift, p.lift); gl.uniform3fv(U.gam, p.gamma); gl.uniform3fv(U.gain, p.gain);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return cv;
}
