#!/usr/bin/env bash
# Baixa do npm o Whisper base (ONNX q8) e o runtime ONNX, e divide os arquivos grandes em partes
# de até 12 MB (limite de hospedagem da página publicada). Rode a partir da pasta estudio-cursos.
set -euo pipefail
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
( cd "$TMP" && npm pack sts-whisper-base@1.0.0 @huggingface/transformers@3.7.5 --silent >/dev/null && for f in *.tgz; do mkdir -p "${f%.tgz}" && tar xzf "$f" -C "${f%.tgz}"; done )
M=models/Xenova/whisper-base
mkdir -p "$M/onnx" vendor/ort
cp "$TMP"/sts-whisper-base-1.0.0/package/models/Xenova/whisper-base/*.json "$TMP"/sts-whisper-base-1.0.0/package/models/Xenova/whisper-base/merges.txt "$M/"
T="$TMP"/huggingface-transformers-3.7.5/package/dist
python3 -c "import sys;p=sys.argv[1];s=open(p,encoding='utf-8').read();open(sys.argv[2],'w',encoding='utf-8').write(s.replace('\ufffd','\\\\uFFFD'))" "$T/transformers.min.js" vendor/transformers.min.js
cp "$T/ort-wasm-simd-threaded.jsep.mjs" vendor/ort/
split -b 12m -d -a 1 --additional-suffix=.wasm "$T/ort-wasm-simd-threaded.jsep.wasm" vendor/ort/ort-wasm-simd-threaded.jsep.wasm.part
for f in encoder_model_quantized decoder_model_merged_quantized; do
  split -b 12m -d -a 1 --additional-suffix=.wasm "$TMP"/sts-whisper-base-1.0.0/package/models/Xenova/whisper-base/onnx/$f.onnx "$M/onnx/$f.onnx.part"
done
ls -la "$M/onnx" vendor/ort
