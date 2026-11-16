#!/usr/bin/env python3
"""eduvid — edição automática de aulas para cursos online (médicos e profissionais de saúde).

Fluxo em duas etapas, para que a transcrição possa ser revisada antes de gravar a legenda:

  1) analisar   VIDEO --pasta TRAB           -> trechos com fala + transcrição (transcricao.json)
  2) renderizar VIDEO --pasta TRAB [opções]  -> aula_16x9.mp4, aula_9x16.mp4, legenda.srt, capcut/

Tudo roda localmente com ffmpeg (e Whisper via Node para a transcrição).
"""
import argparse, json, os, re, shutil, subprocess, sys, unicodedata
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HOME_E = Path(os.environ.get('EDUVID_HOME', Path.home() / '.eduvid'))
os.environ['PATH'] = f"{HOME_E / 'bin'}:{os.environ['PATH']}"
HERE = Path(__file__).resolve().parent


def run(cmd, **kw):
    r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, **kw)
    if r.returncode != 0:
        sys.exit(f"Erro ao executar {' '.join(map(str, cmd[:6]))}...\n{r.stderr[-1500:]}")
    return r


def probe(video):
    r = run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate',
             '-of', 'json', str(video)])
    d = json.loads(r.stdout)
    v = next((s for s in d['streams'] if s['codec_type'] == 'video'), {})
    num, den = (v.get('r_frame_rate', '30/1') + '/1').split('/')[:2]
    fps = float(num) / float(den or 1) if float(den or 1) else 30
    return {'dur': float(d['format']['duration']), 'w': v.get('width', 1920), 'h': v.get('height', 1080),
            'fps': fps if 10 < fps < 121 else 30, 'audio': any(s['codec_type'] == 'audio' for s in d['streams'])}


# ------------------------------------------------------------------ análise
def speech_ranges(video, limiar=-35.0, pausa=0.45, respiro=0.08, dur=None):
    r = subprocess.run(['ffmpeg', '-hide_banner', '-i', str(video), '-vn', '-af',
                        f'silencedetect=noise={limiar}dB:d={pausa}', '-f', 'null', '-'],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    sil, start = [], None
    for line in r.stderr.splitlines():
        m = re.search(r'silence_start: ([\d.]+)', line)
        if m: start = float(m.group(1))
        m = re.search(r'silence_end: ([\d.]+)', line)
        if m and start is not None: sil.append((start, float(m.group(1)))); start = None
    if start is not None: sil.append((start, dur))
    out, t = [], 0.0
    for a, b in sil:
        if a - t > 0.25: out.append([max(0, t - respiro), min(dur, a + respiro)])
        t = b
    if dur - t > 0.25: out.append([max(0, t - respiro), dur])
    merged = []
    for a, b in out:
        if merged and a <= merged[-1][1]: merged[-1][1] = b
        else: merged.append([a, b])
    return merged


def clean_text(t):
    s = re.sub(r'\s+', ' ', t).strip()
    for n in range(6, 1, -1):
        s = re.sub(r'((?:\S+\s+){%d}\S+)(?:\s+\1){2,}' % (n - 1), r'\1', s, flags=re.I)
    return s


def transcribe(video, pasta, dur, trechos):
    wdir = HOME_E / 'whisper'
    if not (wdir / 'models' / 'Xenova' / 'whisper-base').exists():
        print('  ! transcritor não instalado (rode scripts/setup.sh) — sem legenda automática')
        return []
    f32 = pasta / 'audio16k.f32'
    run(['ffmpeg', '-y', '-v', 'error', '-i', str(video), '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', str(f32)])
    shutil.copy(HERE / 'transcrever.mjs', wdir / 'transcrever.mjs')
    out = pasta / 'whisper_bruto.json'
    print('  transcrevendo (aprox. 1/5 da duração do vídeo)…', flush=True)
    run(['node', 'transcrever.mjs', str(f32), str(out)], cwd=wdir)
    f32.unlink(missing_ok=True)
    frases = []
    for c in json.loads(out.read_text()):
        a = c['s'] or 0.0
        b = c['e'] if c['e'] is not None else min(dur, a + 4)
        txt = clean_text(c['texto'])
        if not txt or re.fullmatch(r'[\[(].*[\])]', txt): continue
        if not any(r[1] > a and r[0] < b for r in trechos): continue  # alucinação em silêncio
        frases.append({'s': round(a, 2), 'e': round(max(b, a + 0.3), 2), 'texto': txt})
    return frases


def parse_srt(text):
    frases = []
    pat = re.compile(r'(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)[^\n]*\n(.*?)(?:\n\s*\n|\Z)', re.S)
    for m in pat.finditer(text.replace('\r', '')):
        g = list(map(int, m.groups()[:8]))
        a = g[0] * 3600 + g[1] * 60 + g[2] + g[3] / 1000
        b = g[4] * 3600 + g[5] * 60 + g[6] + g[7] / 1000
        frases.append({'s': a, 'e': b, 'texto': re.sub(r'<[^>]+>', '', m.group(9)).strip().replace('\n', ' ')})
    return frases


def cmd_analisar(a):
    video, pasta = Path(a.video).resolve(), Path(a.pasta).resolve()
    pasta.mkdir(parents=True, exist_ok=True)
    info = probe(video)
    print(f"Vídeo: {info['w']}x{info['h']} · {info['dur']:.1f}s")
    trechos = speech_ranges(video, a.limiar, a.pausa, a.respiro, info['dur']) if info['audio'] else [[0, info['dur']]]
    if not trechos: sys.exit('Nenhuma fala detectada. Tente --limiar -45.')
    fala = sum(b - a_ for a_, b in trechos)
    print(f"  {len(trechos)} trechos com fala · {info['dur'] - fala:.1f}s de pausas serão removidos")
    frases = parse_srt(Path(a.srt).read_text(encoding='utf-8', errors='ignore')) if a.srt else transcribe(video, pasta, info['dur'], trechos)
    (pasta / 'info.json').write_text(json.dumps(info))
    (pasta / 'trechos.json').write_text(json.dumps(trechos))
    (pasta / 'transcricao.json').write_text(json.dumps(frases, ensure_ascii=False, indent=1))
    print(f"  {len(frases)} frases em {pasta / 'transcricao.json'}")
    print('Revise transcricao.json (termos médicos) e depois rode "renderizar".')


# ------------------------------------------------------------------ montagem
def ass_color(hexc, alpha=0):
    h = hexc.lstrip('#')
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f'&H{alpha:02X}{b}{g}{r}'.upper()


def norm(s):
    s = unicodedata.normalize('NFD', s.lower())
    return re.sub(r'[^\w\s-]', '', ''.join(c for c in s if unicodedata.category(c) != 'Mn')).strip()


def is_kw(word, kws):
    n = norm(word)
    return bool(n) and any(k and (n == k or (len(k) > 4 and n.startswith(k[:-1]))) for k in kws)


def to_timeline(trechos, t):
    acc = 0.0
    for a, b in trechos:
        if a <= t < b: return acc + t - a
        if t < a:  # caiu numa pausa cortada: encosta no início do trecho seguinte
            return acc if a - t < 1.5 else None
        acc += b - a
    return acc - 0.05 if trechos and t - trechos[-1][1] < 1.5 else None


def timeline_words(frases, trechos):
    """Distribui as palavras de cada frase só pelos trechos de fala mantidos e converte para o tempo da aula editada."""
    words = []
    for f in frases:
        toks = f['texto'].split()
        if not toks: continue
        pieces = [(max(a, f['s']), min(b, f['e'])) for a, b in trechos if b > f['s'] and a < f['e']]
        pieces = [(a, b) for a, b in pieces if b - a > 0.05]
        if not pieces:  # frase toda dentro de uma pausa: encosta no trecho mais próximo
            t0 = to_timeline(trechos, f['s'])
            if t0 is None: continue
            pieces_tl = [(t0, t0 + 0.35 * len(toks))]
        else:
            pieces_tl = [(to_timeline(trechos, a), to_timeline(trechos, a) + (b - a)) for a, b in pieces]
        kept = sum(b - a for a, b in pieces_tl)
        tot = sum(len(w) + 1 for w in toks)
        pos = 0.0
        for w in toks:
            d = kept * (len(w) + 1) / tot
            # posição "pos" ao longo do tempo mantido -> tempo da aula
            acc, start = 0.0, pieces_tl[-1][0]
            for a, b in pieces_tl:
                if pos < acc + (b - a): start = a + (pos - acc); break
                acc += b - a
            words.append({'w': w, 's': start, 'e': start + d})
            pos += d
    for i in range(1, len(words)):  # mantém a ordem e evita sobreposição
        p = words[i - 1]
        if words[i]['s'] < p['s'] + 0.05: words[i]['s'] = p['s'] + 0.05
        p['e'] = min(p['e'], words[i]['s'])
        words[i]['e'] = max(words[i]['e'], words[i]['s'] + 0.05)
    return words


def group_phrases(words, max_words=6, max_chars=40):
    out, cur = [], []
    for w in words:
        if cur and (w['s'] - cur[-1]['e'] > 0.6): out.append(cur); cur = []
        cur.append(w)
        if len(cur) >= max_words or len(' '.join(x['w'] for x in cur)) >= max_chars or re.search(r'[.!?;:]$', w['w']):
            out.append(cur); cur = []
    if cur: out.append(cur)
    return out


def ts_ass(t):
    t = max(0, t); h = int(t // 3600); m = int(t % 3600 // 60); s = t % 60
    return f'{h}:{m:02d}:{s:05.2f}'


def ts_srt(t):
    ms = int(round(max(0, t) * 1000))
    return f'{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}'


def esc_ass(s):
    return s.replace('\\', '').replace('{', '(').replace('}', ')')


def build_ass(path, W, H, words, phrases, opt, total):
    vertical = H > W
    u = H / 1080 if not vertical else W / 1080
    prim, dest = opt.cor, opt.destaque
    font = opt.fonte
    cap_size = int((64 if vertical else 50) * u * (1.25 if vertical else 1))
    styles = [
        f'Style: Leg,{font},{cap_size},&H00FFFFFF,&H00FFFFFF,&H00141414,&H80000000,-1,0,0,0,100,100,0,0,1,{max(2, int(3.2*u))},{max(1, int(1.5*u))},2,{int(70*u)},{int(70*u)},{int((560 if vertical else 80)*u)},1',
        f'Style: Card,{font},{int(68*u)},{ass_color(prim)},&H00FFFFFF,&H0AFFFFFF,&H00000000,-1,0,0,0,100,100,0,0,3,{int(30*u)},0,7,0,0,0,1',
        f'Style: Sub,{font},{int(28*u)},&H00606B6B,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1',
        f'Style: Nome,{font},{int(44*u)},{ass_color(prim)},&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1',
        f'Style: Tit,{font},{int(68*u)},{ass_color(opt.texto)},&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,{int(80*u)},{int(80*u)},0,1',
        f'Style: Desenho,{font},20,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1',
    ]
    ev = []
    kws = [norm(k) for k in opt.palavras if k.strip()]
    D = lambda layer, a, b, style, text: ev.append(f'Dialogue: {layer},{ts_ass(a)},{ts_ass(b)},{style},,0,0,0,,{text}')

    # Legenda: frase inteira, palavra falada na cor de destaque, palavras-chave sempre destacadas
    if opt.legenda != 'nenhuma':
        for k, ph in enumerate(phrases):
            fim = ph[-1]['e'] + 0.1
            if k + 1 < len(phrases): fim = min(fim, phrases[k + 1][0]['s'])
            for i, w in enumerate(ph):
                a = w['s'] if i else ph[0]['s']
                b = min(ph[i + 1]['s'], fim) if i + 1 < len(ph) else fim
                if b - a < 0.04: continue
                parts = []
                for j, x in enumerate(ph):
                    txt = esc_ass(x['w'].upper() if vertical else x['w'])
                    if j == i: parts.append(f'{{\\c{ass_color(dest)}}}{txt}{{\\c&HFFFFFF&}}')
                    elif is_kw(x['w'], kws): parts.append(f'{{\\c{ass_color(dest)}}}{txt}{{\\c&HFFFFFF&}}')
                    else: parts.append(txt)
                D(1, a, b, 'Leg', ' '.join(parts))

    # Cartões de palavra-chave do lado oposto ao expert
    lado = 'direita' if opt.lado == 'esquerda' else 'esquerda'
    last, usos, cartoes = -99, {}, []
    for w in words:  # no máximo 1 destaque a cada 20 s e até 3 aparições por palavra
        k = norm(w['w'])
        if is_kw(w['w'], kws) and w['s'] - last >= 20 and usos.get(k, 0) < 3 and w['s'] > (3.4 if opt.abertura else 0):
            last = w['s']; usos[k] = usos.get(k, 0) + 1; cartoes.append(w['s'])
            a, b = w['s'], min(total, w['s'] + opt.dur_cartao)
            txt = esc_ass(re.sub(r'[^\w\s-]', '', w['w']).upper())
            if vertical:
                x0, y0 = int(W / 2), int(H * 0.17)
                D(3, a, b, 'Card', f'{{\\an8\\pos({x0},{y0})\\fad(250,250)}}{txt}')
                D(4, a, b, 'Desenho', f'{{\\an8\\pos({x0},{y0 - int(20*u)})\\c{ass_color(dest)}\\fad(250,250)\\p1}}m 0 0 l {int(60*u)} 0 {int(60*u)} {int(6*u)} 0 {int(6*u)}{{\\p0}}')
            else:
                margin = int(110 * u)
                y0 = int(H * 0.30)
                an = 9 if lado == 'direita' else 7
                x0 = W - margin if lado == 'direita' else margin
                dx = 60 if lado == 'direita' else -60
                D(3, a, b, 'Card', f'{{\\an{an}\\move({x0 + dx},{y0},{x0},{y0},0,300)\\fad(250,250)}}{txt}')
                bar_x = x0 - int(30*u) if lado == 'esquerda' else x0
                D(4, a, b, 'Desenho', f'{{\\an{an}\\move({bar_x + dx},{y0 - int(20*u)},{bar_x},{y0 - int(20*u)},0,300)\\c{ass_color(dest)}\\fad(250,250)\\p1}}m 0 0 l {int(56*u)} 0 {int(56*u)} {int(6*u)} 0 {int(6*u)}{{\\p0}}')

    # Nome + CRM na tela (lado do expert), num painel branco com barra na cor de destaque
    if opt.nome:
        a, b = (3.6, 9.0) if opt.abertura else (0.6, 6.0)
        if total > a + 1:
            right = opt.lado == 'direita' and not vertical
            sub = '  ·  '.join(x for x in [opt.especialidade, opt.crm] if x)
            pw = int(max(len(opt.nome) * 25.5, len(sub) * 14.5) * u + 64 * u)
            ph = int((118 if sub else 80) * u)
            x0 = (W - int(80 * u) - pw) if right else int(80 * u)
            y0 = int(H * (0.60 if not vertical else 0.78))
            fad = '\\fad(300,300)'
            D(5, a, b, 'Desenho', f'{{\\an7\\pos({x0},{y0}){fad}\\c&HFFFFFF&\\alpha&H08&\\p1}}m 0 0 l {pw} 0 {pw} {ph} 0 {ph}{{\\p0}}')
            D(6, a, b, 'Desenho', f'{{\\an7\\pos({x0},{y0}){fad}\\c{ass_color(dest)}\\p1}}m 0 0 l {int(7*u)} 0 {int(7*u)} {ph} 0 {ph}{{\\p0}}')
            D(7, a, b, 'Nome', f'{{\\an7\\pos({x0 + int(32*u)},{y0 + int(16*u)}){fad}}}{esc_ass(opt.nome)}')
            if sub: D(7, a, b, 'Sub', f'{{\\an7\\pos({x0 + int(32*u)},{y0 + int(72*u)}){fad}}}{esc_ass(sub)}')

    # Abertura com o título da aula
    if opt.abertura and opt.titulo:
        D(8, 0, 2.9, 'Desenho', f'{{\\pos(0,0)\\c{ass_color(prim)}\\alpha&H14&\\fad(0,450)\\p1}}m 0 0 l {W} 0 {W} {H} 0 {H}{{\\p0}}')
        D(9, 0, 2.9, 'Desenho', f'{{\\an5\\pos({W//2},{int(H/2 - 95*u)})\\c{ass_color(dest)}\\fad(200,450)\\p1}}m 0 0 l {int(80*u)} 0 {int(80*u)} {int(6*u)} 0 {int(6*u)}{{\\p0}}')
        D(9, 0, 2.9, 'Tit', f'{{\\pos({W//2},{int(H/2)})\\fad(200,450)}}{esc_ass(opt.titulo)}')
        if opt.nome:
            D(9, 0, 2.9, 'Tit', f'{{\\pos({W//2},{int(H/2 + 90*u)})\\fs{int(30*u)}\\b0\\fad(200,450)}}{esc_ass(opt.nome)}')

    path.write_text('[Script Info]\nScriptType: v4.00+\nWrapStyle: 0\nScaledBorderAndShadow: yes\n'
                    f'PlayResX: {W}\nPlayResY: {H}\n\n[V4+ Styles]\n'
                    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n'
                    + '\n'.join(styles) + '\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
                    + '\n'.join(ev) + '\n', encoding='utf-8')
    return cartoes


def gerar_efeitos(path, total, cartoes, opt, sr=48000):
    """Trilha de efeitos sonoros sintetizados (sino na abertura, tique no nome, whoosh + pop nos destaques)."""
    try:
        import numpy as np
    except ImportError:
        print('  ! numpy indisponível — sem efeitos sonoros'); return False
    import wave
    out = np.zeros(int((total + 2) * sr), dtype=np.float32)
    rng = np.random.default_rng(7)
    def put(sig, t):
        i = int(t * sr)
        if i >= len(out): return
        n = min(len(sig), len(out) - i); out[i:i + n] += sig[:n]
    def whoosh():
        n = int(0.5 * sr); t = np.linspace(0, 1, n); x = rng.uniform(-1, 1, n)
        lp = np.zeros(n); bp = np.zeros(n); a = 0.0; b = 0.0
        k = 0.02 + 0.25 * t
        for i in range(n):  # filtro que abre ao longo do som
            a += k[i] * (x[i] - a); b += 0.5 * (a - b); lp[i] = a - b
        return (lp * np.sin(np.pi * np.minimum(1, t * 1.15)) ** 2 * 1.6).astype(np.float32)
    def pop():
        t = np.arange(int(0.16 * sr)) / sr; f = np.maximum(200, 1100 - 2600 * t)
        return (np.sin(np.cumsum(2 * np.pi * f / sr)) * np.exp(-t * 32) * 0.55).astype(np.float32)
    def sino():
        t = np.arange(int(1.6 * sr)) / sr
        return ((np.sin(2*np.pi*880*t)*0.5 + np.sin(2*np.pi*1320*t)*0.25 + np.sin(2*np.pi*2640*t)*0.08) * np.exp(-t*3.2) * np.minimum(1, t*200) * 0.45).astype(np.float32)
    def tique():
        t = np.arange(int(0.08 * sr)) / sr
        return ((np.sin(2*np.pi*2400*t)*0.6 + rng.uniform(-0.2, 0.2, len(t))) * np.exp(-t*70) * 0.5).astype(np.float32)
    v = opt.volume_efeitos
    if opt.abertura and opt.titulo: put(sino() * v * 0.8, 0.05)
    if opt.nome: put(tique() * v * 0.7, 3.6 if opt.abertura else 0.6)
    w, p = whoosh(), pop()
    for t in cartoes: put(w * v, t); put(p * v * 0.6, t + 0.18)
    pcm = (np.clip(out, -1, 1) * 32767).astype('<i2')
    with wave.open(str(path), 'wb') as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(sr); f.writeframes(pcm.tobytes())
    return True


LOOKS = {
    'natural': '',
    'clinico': ',eq=brightness=0.03:contrast=1.05:saturation=0.95',
    'quente': ',eq=brightness=0.02:contrast=1.06:saturation=1.08,colorbalance=rm=0.03:bm=-0.03',
    'vivo': ',eq=contrast=1.1:saturation=1.2',
}
VOZ = 'highpass=f=85,equalizer=f=300:t=q:w=1:g=-2.5,equalizer=f=3200:t=q:w=0.9:g=3,acompressor=threshold=-24dB:ratio=3:attack=5:release=200:makeup=2,loudnorm=I=-16:TP=-1.5:LRA=11'


def encode_segment(args):
    video, i, a, b, zoom, fx, W, H, fps, pasta = args
    out = pasta / 'seg' / f'{i:05d}.mp4'
    z = zoom
    vf = (f'scale={int(W*z)}:{int(H*z)}:force_original_aspect_ratio=increase,'
          f'crop={W}:{H}:(iw-{W})*{fx}:(ih-{H})*0.38,setsar=1,fps={fps}')
    d = b - a
    af = f'afade=t=in:d=0.015,afade=t=out:st={max(0, d - 0.02):.3f}:d=0.02,aresample=48000'
    run(['ffmpeg', '-y', '-v', 'error', '-ss', f'{a:.3f}', '-i', str(video), '-t', f'{d:.3f}', '-vf', vf, '-af', af,
         '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-ac', '2', str(out.with_suffix('.mov'))])
    return out.with_suffix('.mov')


def cmd_renderizar(a):
    video, pasta = Path(a.video).resolve(), Path(a.pasta).resolve()
    info = json.loads((pasta / 'info.json').read_text())
    trechos = json.loads((pasta / 'trechos.json').read_text()) if not a.sem_cortes else [[0, info['dur']]]
    frases = json.loads((pasta / 'transcricao.json').read_text())
    a.palavras = [p.strip() for p in (a.palavras or '').split(',') if p.strip()]
    fps = a.fps or round(info['fps']) or 30
    W, H = (3840, 2160) if a.resolucao == '4k' else (1920, 1080)
    if a.resolucao == '4k' and a.preset == 'medium': a.preset = 'veryfast'  # 4K: mantém o tempo razoável
    fx = {'esquerda': 0.35, 'direita': 0.65, 'centro': 0.5}.get(a.lado, 0.5) if a.foco is None else a.foco
    (pasta / 'seg').mkdir(exist_ok=True)
    jobs = [(video, i, s, e, (1.12 if (i % 2 and not a.sem_zoom) else 1.0), fx, W, H, fps, pasta) for i, (s, e) in enumerate(trechos)]
    print(f'Montando {len(jobs)} trechos…', flush=True)
    with ThreadPoolExecutor(max_workers=min(4, os.cpu_count() or 2)) as ex:
        segs = list(ex.map(encode_segment, jobs))
    lst = pasta / 'seg' / 'lista.txt'
    lst.write_text(''.join(f"file '{s.name}'\n" for s in segs))
    mont = pasta / 'montagem.mov'
    run(['ffmpeg', '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', str(lst), '-c', 'copy', str(mont)])
    total = sum(e - s for s, e in trechos)

    words = timeline_words(frases, trechos)
    phrases = group_phrases(words)
    phrases_v = group_phrases(words, 3, 18)
    srt = ''.join(f"{i + 1}\n{ts_srt(p[0]['s'])} --> {ts_srt(min(p[-1]['e'] + 0.1, phrases[i + 1][0]['s']) if i + 1 < len(phrases) else p[-1]['e'] + 0.1)}\n{' '.join(w['w'] for w in p)}\n\n" for i, p in enumerate(phrases))
    out = Path(a.saida or pasta / 'final')
    out.mkdir(parents=True, exist_ok=True)
    nome = re.sub(r'[^\w-]+', '-', norm(a.titulo or 'aula')).strip('-') or 'aula'
    (out / f'{nome}.srt').write_text(srt, encoding='utf-8')
    fonts = HOME_E / 'fonts'
    fdir = f":fontsdir={fonts}" if fonts.exists() else ''
    look = LOOKS.get(a.look, '')
    enc = ['-c:v', 'libx264', '-preset', a.preset, '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
           '-c:a', 'aac', '-b:a', '160k', '-ar', '48000']
    resultados = []
    sfx_wav = pasta / 'efeitos.wav'
    def sfx_in(cartoes):
        ok = a.efeitos and gerar_efeitos(sfx_wav, total, cartoes, a)
        sfx_in.on = bool(ok)
        return ['-i', str(sfx_wav)] if ok else []
    def audio_graph():
        return f"[0:a]{VOZ}[voz];[voz][1:a]amix=inputs=2:normalize=0:duration=first[a]" if sfx_in.on else f"[0:a]{VOZ}[a]"
    if '16x9' in a.formatos:
        ass = pasta / 'leg_16x9.ass'
        cartoes = build_ass(ass, W, H, words, phrases, a, total)
        f = out / f'{nome}_16x9{"_4k" if W > 1920 else ""}{"_60fps" if fps >= 50 else ""}.mp4'
        print(f'Gerando versão 16:9 ({W}x{H}, {fps} fps)…', flush=True)
        run(['ffmpeg', '-y', '-v', 'error', '-i', str(mont), *sfx_in(cartoes), '-filter_complex', f"[0:v]ass={ass}{fdir}{look}[v];{audio_graph()}", '-map', '[v]', '-map', '[a]', *enc, '-crf', '20', str(f)])
        resultados.append(f)
    if '9x16' in a.formatos:
        ass = pasta / 'leg_9x16.ass'
        Wv, Hv = (2160, 3840) if W > 1920 else (1080, 1920)
        cartoes_v = build_ass(ass, Wv, Hv, words, phrases_v, a, total)
        f = out / f'{nome}_9x16_celular.mp4'
        print('Gerando versão vertical 9:16 (celular / Reels)…', flush=True)
        vf = f"crop=ih*9/16:ih:(iw-ih*9/16)*{fx}:0,scale={Wv}:{Hv},setsar=1,ass={ass}{fdir}{look}"
        run(['ffmpeg', '-y', '-v', 'error', '-i', str(mont), *sfx_in(cartoes_v), '-filter_complex', f"[0:v]{vf}[v];{audio_graph()}", '-map', '[v]', '-map', '[a]', *enc, '-crf', '23', str(f)])
        resultados.append(f)
    if a.capcut:
        cdir = out / 'capcut'
        cdir.mkdir(exist_ok=True)
        print('Gerando pacote para o CapCut (vídeo limpo + legenda .srt)…', flush=True)
        run(['ffmpeg', '-y', '-v', 'error', '-i', str(mont), '-vf', f'null{look}', '-af', VOZ, *enc, '-crf', '18', str(cdir / f'{nome}_sem_legenda.mp4')])
        (cdir / f'{nome}.srt').write_text(srt, encoding='utf-8')
        (cdir / 'palavras-chave.txt').write_text('\n'.join(a.palavras), encoding='utf-8')
        resultados.append(cdir)
    shutil.rmtree(pasta / 'seg', ignore_errors=True)
    print(json.dumps({'duracao_original': round(info['dur'], 1), 'duracao_final': round(total, 1), 'cortes': len(trechos),
                      'frases_legenda': len(phrases), 'arquivos': [str(x) for x in resultados] + [str(out / f'{nome}.srt')]}, ensure_ascii=False, indent=1))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = p.add_subparsers(dest='cmd', required=True)
    an = sp.add_parser('analisar')
    an.add_argument('video'); an.add_argument('--pasta', required=True)
    an.add_argument('--limiar', type=float, default=-35, help='dB abaixo do qual é silêncio (-30 ruidoso … -45 sala silenciosa)')
    an.add_argument('--pausa', type=float, default=0.45, help='pausa mínima a cortar, em segundos')
    an.add_argument('--respiro', type=float, default=0.08)
    an.add_argument('--srt', help='usar esta legenda em vez de transcrever')
    rd = sp.add_parser('renderizar')
    rd.add_argument('video'); rd.add_argument('--pasta', required=True); rd.add_argument('--saida')
    rd.add_argument('--titulo', default=''); rd.add_argument('--nome', default='')
    rd.add_argument('--especialidade', default=''); rd.add_argument('--crm', default='')
    rd.add_argument('--palavras', default='', help='palavras-chave separadas por vírgula')
    rd.add_argument('--cor', default='#0F3D3E'); rd.add_argument('--destaque', default='#2BB3A3'); rd.add_argument('--texto', default='#FFFFFF')
    rd.add_argument('--lado', default='esquerda', choices=['esquerda', 'direita', 'centro'], help='onde o expert aparece no vídeo')
    rd.add_argument('--foco', type=float, help='centro do rosto na horizontal, 0 a 1 (padrão pelo lado)')
    rd.add_argument('--fonte', default='Inter')
    rd.add_argument('--look', default='clinico', choices=list(LOOKS))
    rd.add_argument('--legenda', default='karaoke', choices=['karaoke', 'nenhuma'])
    rd.add_argument('--formatos', default='16x9,9x16')
    rd.add_argument('--capcut', action='store_true'); rd.add_argument('--sem-zoom', action='store_true')
    rd.add_argument('--sem-cortes', action='store_true'); rd.add_argument('--sem-abertura', dest='abertura', action='store_false')
    rd.add_argument('--dur-cartao', type=float, default=2.8)
    rd.add_argument('--preset', default='medium')
    rd.add_argument('--resolucao', default='1080', choices=['1080', '4k'], help='4k = 3840x2160 (2160x3840 na vertical)')
    rd.add_argument('--fps', type=int, help='quadros por segundo da saída (ex.: 60); padrão = o do vídeo original')
    rd.add_argument('--sem-efeitos', dest='efeitos', action='store_false', help='não adicionar efeitos sonoros')
    rd.add_argument('--volume-efeitos', type=float, default=0.5)
    a = p.parse_args()
    {'analisar': cmd_analisar, 'renderizar': cmd_renderizar}[a.cmd](a)


if __name__ == '__main__':
    main()
