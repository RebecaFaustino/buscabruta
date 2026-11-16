#!/usr/bin/env bash
# Prepara o ambiente da skill eduvid-celular (idempotente; ~1-2 min na 1ª vez).
set -uo pipefail
HOME_E="${EDUVID_HOME:-$HOME/.eduvid}"
mkdir -p "$HOME_E"
ok() { printf '  ✓ %s\n' "$1"; }

# 1) ffmpeg (sistema; senão binário estático via pip)
if command -v ffmpeg >/dev/null 2>&1; then ok "ffmpeg"; else
  (apt-get install -y -q ffmpeg >/dev/null 2>&1 || (apt-get update -q >/dev/null 2>&1 && apt-get install -y -q ffmpeg >/dev/null 2>&1)) \
    || pip install -q imageio-ffmpeg >/dev/null 2>&1
  if command -v ffmpeg >/dev/null 2>&1; then ok "ffmpeg (apt)"; else
    F=$(python3 -c "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())" 2>/dev/null) && mkdir -p "$HOME_E/bin" && ln -sf "$F" "$HOME_E/bin/ffmpeg" && ok "ffmpeg (pip)" || echo "  ✗ ffmpeg indisponível"
  fi
fi

# 2) Fonte Inter (visual limpo para saúde); sem ela o libass usa a fonte padrão
if fc-list 2>/dev/null | grep -i "inter" >/dev/null; then ok "fonte Inter"; else
  (apt-get install -y -q fonts-inter >/dev/null 2>&1 || (apt-get update -q >/dev/null 2>&1 && apt-get install -y -q fonts-inter >/dev/null 2>&1)) && ok "fonte Inter (apt)" || echo "  ! fonte Inter indisponível, usando a padrão"
fi

# 3) Transcrição local (Whisper base via npm — não depende de huggingface.co)
if [ -f "$HOME_E/whisper/node_modules/@huggingface/transformers/package.json" ] && [ -d "$HOME_E/whisper/models/Xenova/whisper-base" ]; then ok "transcritor Whisper"; else
  if command -v node >/dev/null 2>&1; then
    mkdir -p "$HOME_E/whisper" && cd "$HOME_E/whisper" && [ -f package.json ] || npm init -y >/dev/null 2>&1
    npm i @huggingface/transformers@3.7.5 --silent >/dev/null 2>&1
    npm pack sts-whisper-base@1.0.0 --silent >/dev/null 2>&1 && mkdir -p m && tar xzf sts-whisper-base-1.0.0.tgz -C m && rm -rf models && mv m/package/models models && rm -rf m sts-whisper-base-1.0.0.tgz
    [ -d models/Xenova/whisper-base ] && ok "transcritor Whisper" || echo "  ✗ transcritor indisponível (sem acesso ao npm?) — use --srt"
  else echo "  ✗ node não encontrado — a legenda precisa vir de um .srt"; fi
fi
echo "Pronto."
