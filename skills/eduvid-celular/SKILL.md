---
name: eduvid-celular
description: "Máquina de editar aulas de cursos online de médicos e profissionais de saúde, pensada para quem manda o vídeo pelo celular. Faz cortes secos, zoom dinâmico, legenda automática revisada (termos médicos), palavras-chave em destaque ao lado do expert, nome + CRM na tela, abertura com título, voz tratada e entrega a aula pronta para Hotmart, Eduzz, Sympla e Kiwify (16:9), uma versão vertical para celular/Reels (9:16) e um pacote para finalizar no CapCut. Use sempre que a Rebeca mandar vídeo de aula, módulo de curso, gravação de médico(a) ou pedir para 'editar a aula', 'deixar no padrão do curso', 'subir na Hotmart', 'mandar pro CapCut' ou citar o estilo Edvid — mesmo que ela não diga 'curso'. Para Reels e vídeos curtos de redes sociais, a skill editor-video-pro costuma ser melhor."
---

# Eduvid Celular — aulas de curso prontas a partir do celular

A Rebeca cuida de cursos de clientes, quase todos médicos. Ela costuma estar no celular: manda o vídeo e quer receber a aula pronta, sem precisar decidir detalhes técnicos. Responda sempre em português, com mensagens curtas e fáceis de ler numa tela pequena. Cada pergunta desnecessária é atrito: use os padrões abaixo e só pergunte o que não dá para deduzir.

## 1. Preparar (1ª vez na sessão)

```bash
bash <pasta-da-skill>/scripts/setup.sh
```
Instala ou confere ffmpeg, a fonte Inter e o transcritor Whisper local (vem do npm, então funciona mesmo sem acesso ao huggingface.co). Leva ~1 min na primeira vez e depois é instantâneo.

## 2. O que perguntar (o mínimo)

Do vídeo você precisa de: **nome do expert**, **especialidade**, **CRM/RQE**, **título da aula**. Se a mensagem já traz isso, ou você já sabe da conversa, não pergunte. Se faltar o CRM, siga sem ele.

Cores: se ela não disser, use o padrão clínico (`--cor #0F3D3E --destaque #2BB3A3`). Se mandar a logo ou o Instagram do cliente, tire as cores de lá.

Lado do expert: olhe um quadro do vídeo (`ffmpeg -ss 5 -i VIDEO -frames:v 1 quadro.jpg` e veja a imagem). Se a pessoa está à esquerda, use `--lado esquerda` e os destaques vão para a direita. Se está centralizada, use `--lado centro` (os destaques ficam no lado direito).

Link do YouTube: não dá para baixar vídeo do YouTube daqui. Peça o arquivo pelo próprio chat ou um link do Google Drive, que dá para baixar com o conector do Drive. Explique em uma frase: "O YouTube bloqueia o download; me manda o arquivo ou o link do Drive."

## 3. Analisar

```bash
python3 <skill>/scripts/eduvid.py analisar VIDEO.mp4 --pasta trab
```
Gera `trab/trechos.json` (partes com fala) e `trab/transcricao.json` (frases com tempo).
- Muito ruído de fundo: use `--limiar -30`. Sala silenciosa: `-45`.
- Ritmo: `--pausa 0.3` deixa mais ágil; `0.6` mais natural (bom para explicações densas).
- Se ela mandou um `.srt`: use `--srt arquivo.srt` em vez de transcrever.

## 4. Revisar a legenda (o passo que faz a diferença)

O Whisper erra termos técnicos, nomes de remédios e siglas. Leia `trab/transcricao.json` inteiro e corrija o campo `texto` de cada frase pelo contexto da aula e da especialidade (por exemplo, "insulir" vira "insulina" e "a1c" vira "HbA1c"). Mantenha `s` e `e`. Não resuma nem reescreva o estilo de fala do expert: a legenda precisa bater com o que é dito. Remova frases que claramente não foram ditas, como repetições sem sentido ou textos em silêncio.

Depois escolha **4 a 8 palavras-chave**: os termos centrais da aula que o aluno deve memorizar (doenças, hormônios, exames, conceitos). Prefira palavras únicas e fortes, que aparecem na fala. Elas vão colorir a legenda e virar cartões animados ao lado do expert.

## 5. Renderizar

```bash
python3 <skill>/scripts/eduvid.py renderizar VIDEO.mp4 --pasta trab --saida entrega \
  --titulo "Título da aula" --nome "Dra. Nome" --especialidade "Especialidade" --crm "CRM-UF 000000" \
  --palavras "termo1,termo2,termo3" --lado esquerda --cor "#0F3D3E" --destaque "#2BB3A3" --capcut
```
Saídas em `entrega/`:
- `<titulo>_16x9.mp4`: 1920×1080, H.264 + AAC, faststart, voz tratada (EQ + compressor + -16 LUFS). É o arquivo da Hotmart, Eduzz, Sympla, Kiwify e Memberkit.
- `<titulo>_9x16_celular.mp4`: vertical 1080×1920, legenda maior e no centro. Serve para assistir no celular, mandar ao cliente aprovar pelo WhatsApp ou usar trechos em Reels.
- `<titulo>.srt`: legenda sincronizada com os cortes. Suba junto da aula na plataforma.
- `capcut/`: vídeo limpo (sem legenda gravada) + `.srt` + `palavras-chave.txt`, para finalizar no CapCut.

**4K 60 fps**: some `--resolucao 4k --fps 60` (3840×2160; vertical 2160×3840). Use quando ela pedir 4K ou "máxima qualidade". Avise que o arquivo fica ~4× maior e que a renderização demora mais (~5× a duração da aula). Se o vídeo original for 1080p/30, explique em uma linha que o 4K amplia a imagem e que os 60 fps repetem quadros: a nitidez real continua a do original.

**Efeitos sonoros** (ligados por padrão): sino suave na abertura, tique quando entra o nome + CRM, whoosh + pop em cada destaque. Use `--volume-efeitos 0.3` para mais discretos ou `--sem-efeitos` para desligar. São sintetizados na hora: não precisa baixar nada.

Opções úteis: `--formatos 16x9` (só a versão do curso, mais rápido), `--sem-zoom`, `--sem-abertura`, `--look natural|clinico|quente|vivo`, `--legenda nenhuma` (quando a plataforma vai exibir só o .srt), `--preset veryfast` (aulas longas; a qualidade fica quase igual).

Tempo: a análise leva cerca de 1/5 da duração. A renderização leva perto de 1× a duração por formato. Para aulas acima de 20 min, avise antes ("vai levar uns X min").

## 6. Conferir antes de entregar

Extraia 2 ou 3 quadros (`ffmpeg -ss T -i entrega/..._16x9.mp4 -frames:v 1 q.jpg`) num momento com legenda, num com cartão de destaque e no nome + CRM, e olhe as imagens. Confira se nada está cortado ou sobreposto ao rosto. Se o cartão cobrir o rosto, troque `--lado`.

## 7. Entregar (pensado para o celular)

Envie os arquivos com a ferramenta de arquivos disponível (SendUserFile ou present_files): primeiro o 16:9, depois o 9:16 e o .srt. O pacote do CapCut vai só se ela pediu. Depois, uma mensagem curta assim:

```
Aula pronta ✅ 12min → 9min (−25%)
• 16:9 para a Hotmart + legenda .srt
• Vertical para ver no celular
Destaques: insulina, metabolismo, HbA1c

Descrição para a plataforma:
<3–4 linhas>
```

A descrição da aula deve ter tom acolhedor e claro para leigos, sem promessa de cura nem de resultado, e respeitar as normas de publicidade médica do CFM.

Vídeos acima de ~100 MB podem demorar para abrir no celular. Nesse caso, avise e mande primeiro o vertical, que é mais leve, para ela conferir.

## CapCut

Não existe integração direta com o CapCut. O caminho é o pacote `capcut/`:
1. No CapCut, crie um projeto com `<titulo>_sem_legenda.mp4`.
2. **CapCut no computador**: Texto → Legendas → **Importar legendas** → escolha o `.srt`. Depois aplique o estilo da marca de uma vez.
3. **CapCut no celular**: a importação de .srt pode não estar disponível. Use **Legendas automáticas** e confira os termos médicos pelo `palavras-chave.txt`, ou use o vídeo 16:9 já legendado.

## Plataformas (padrões que funcionam)

| Plataforma | Arquivo | Observação |
|---|---|---|
| Hotmart (Club) | 16:9 MP4 + .srt | Legenda: enviar o .srt na aula |
| Eduzz (Nutror) | 16:9 MP4 | |
| Sympla Play | 16:9 MP4 | |
| Kiwify / Memberkit | 16:9 MP4 | Memberkit costuma usar Panda/Vimeo |
| Reels / Stories | 9:16 | Corte um trecho de 30–60 s do vertical |

Os limites das plataformas mudam. Se houver erro de upload, o mais comum é o tamanho do arquivo: renderize de novo com `--preset slow` (arquivo menor) ou divida a aula.

## Se algo falhar

- **"transcritor não instalado"**: rode o setup de novo. Se o npm estiver bloqueado, peça um .srt (o YouTube Studio e o CapCut geram) e use `--srt`.
- **Nenhuma fala detectada**: use `--limiar -45`.
- **Cortes bruscos demais**: use `--pausa 0.6` ou `--respiro 0.15`.
- **Vídeo do iPhone (.mov, HEVC)**: o ffmpeg lê normalmente. A saída é sempre H.264.
