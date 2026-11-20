# Memória do projeto (compartilhada entre Claude e ChatGPT/Codex)

Lida automaticamente no início de toda conversa do Claude Code neste repositório (gancho SessionStart).
Ao terminar algo importante, acrescente uma linha no Diário e atualize o "Estado atual" se mudou.

## Estado atual (resumo para começar qualquer conversa)

**Quem:** Rebeca Faustino, agência Rebeca Faustino Marketing (Fortaleza-CE). Não programa; trabalha pelo celular (iPhone, 2 TB).
Também tem 2 TB no Google Drive. Quer tudo pronto, testado, sem erros, em português, e custo zero (só ferramentas gratuitas).

**Como trabalhar com ela:** agir sozinho, testar tudo antes de entregar, só chamar quando estiver ok; respostas curtas e diretas;
nunca inventar dados de clientes (marcar "a confirmar"); ser honesto sobre o que não dá para fazer.

**Produtos:**
- Estúdio de Cursos (este repo, `estudio-cursos/`): editor de aulas para médicos, publicado em https://claude.ai/artifact/TktWxL7iosS8x65jYTAH69
  (branch `claude/course-editing-app-8rz12e`).
- Skill `skills/eduvid-celular`: edição por linha de comando (ffmpeg) no notebook — caminho mais rápido para aulas longas em 4K.
- Estúdio de Marketing: hospedado no ChatGPT (pede login; sem API). Cópia de referência: artifact claude.ai X7YMfxB66uQFPikWN4N5tq.
- App antigo "Estúdio Video AI" (repos `estudio-video-ai` público/desativado e `estudio-video-ai-dados` privado): guardava mídias no GitHub
  (limite ~1 GB e 100 MB/arquivo) e processava no GitHub Actions. Não serve para vídeos de 40 GB.

**Memória e dados compartilhados:**
- Notion: página "Memória compartilhada — Claude + ChatGPT" e tabela "Clientes — estilos e particularidades"
  (data source collection://41a6c06c-d7f3-81e9-aab7-000bfbca9205). O app lê a tabela ao vivo.
- Google Drive: "PACOTE COMPLETO PARA O CHATGPT (v2).md", pasta 00 MARCAS (logos), Fábrica de Produção.

**Clientes (10):** Dra. Ana Eduvirges; Clínica Pediátrica Alberto Lima; Clínica A Cabana · Dra. Máyra Laís; Dra. Adelina Feitosa; EMI;
Dra. Grace Teles; Dra. Danielle Gurgel Astolfi; Markoo; Monte Sinai Ensino e Consultoria; Rebeca Faustino Marketing (agência).
Ela está fechando mais 2 (no app antigo há também André Cabral, Jangadeiro Praia Hotel e Planeta Tur). Só cadastrar quando ela pedir.

**Preferências decididas:**
- Vídeos ficam guardados NO CELULAR (armazenamento do app). Na nuvem vão só os projetos (cortes, legendas, estilos).
- Backup automático dos projetos no Google Drive (pasta "Estúdio de Cursos — backups"); vídeos finais: salvar no aparelho/Fotos.
- Exportação sempre 60 fps e nunca abaixo de Full HD (1080p, 1440p ou 4K).
- Repositórios do GitHub devem ser PRIVADOS (pedido em 20/11/2026).
- LUTs pagos (ex.: curso Escola Marcelo Santana) não podem ser copiados; ela pode importar os .cube que comprou.

## Diário

Formato de cada linha: data — quem — o que foi feito ou decidido.

- 2026-11 — Claude — App Estúdio de Cursos v11 publicado:
  - abertura rápida (360 KB);
  - botão Voltar;
  - prévias dos estilos;
  - trilha sonora sintetizada;
  - capa da aula;
  - Reels automático com prévia vertical;
  - capítulos;
  - sincronização na nuvem entre aparelhos.
- 2026-11 — Claude — Skill eduvid-celular ganhou `--trilha`, `--volume-trilha` e `--trecho` (Reels).
- 2026-11 — Claude — GitHub liberado para gravação; branch de trabalho `claude/course-editing-app-8rz12e`.
- 2026-11 — Claude — Contexto unificado: `AGENTS.md` (regras), `MEMORIA.md` (memória), skills em `skills/`, com links em `.claude/skills` e `.agents/skills`.
- 2026-11 — Claude — Revisão em 3 tamanhos de tela (iPhone SE, iPhone 13, computador): nada vaza da tela; título da aula com rótulo; capítulos sem IA usam as palavras-chave do cliente.
- 2026-11 — Claude — Criada página no Notion "Memória compartilhada — Claude + ChatGPT" (as duas IAs têm conector Notion).
- 2026-11 — Rebeca — ChatGPT conectado ao Notion; memória comum ativa.
- 2026-11 — Claude — v13: barra de progresso fiel, plurais corretos, botões do editor em grade no celular, abas com indicação de rolagem, régua da linha do tempo sem número cortado.
- 2026-11 — Claude — v14: app lê ao vivo (conector Notion, a cada 1 min) a tabela Notion "Clientes — estilos e particularidades" (collection 41a6c06c-d7f3-81e9-aab7-000bfbca9205) e aplica cores/modelo/plataforma/trilha/palavras-chave; tom, público, proibidas e particularidades orientam a IA. Código em estudio-cursos/js/marketing.js.
- 2026-11 — Claude — v15: 9 clientes reais na tabela do Notion (fonte: PACOTE COMPLETO v2 no Drive); grade compacta no celular; aviso de termos proibidos; demo removido quando chegam clientes reais.
- 2026-11 — Claude — v16: 10 clientes do Estúdio de Marketing (inclui a agência) com paletas/fontes/tom; texto legível sobre cor clara; espaço entre palavras na legenda palavra-a-palavra.
- 2026-11 — Claude — v17: edição pelo texto (✂ por frase) e remoção de repetições (app e skill --sem-repeticoes); bateria completa passou.
- 2026-11 — Claude — v18: linha do tempo do editor refeita no padrão do Edvid (edvid-desktop, MIT): faixas Legendas/Destaques/Vídeo/Voz/Trilha, régua MM:SS, agulha laranja, alças de aparar com encaixe, C/Delete/Ctrl+Z/Shift+Ctrl+Z, zoom 1–8×, IN/OUT + Cortar trecho, mudo. Código em estudio-cursos/js/timeline.js.
- 2026-11 — Claude — v19: kit de marca por cliente (paleta completa, fontes Google Fonts com troca automática de fontes pagas, logo puxado do Google Drive pelo link na tabela do Notion); 'Aprender o estilo com vídeos de exemplo' (cores, ritmo, fala + leitura de quadros pelo Claude); áudio da exportação estilo Edvid: corte em J 0,15 s, nivelamento entre takes ±6 dB, −14 LUFS / pico −1 dB (medido: −14,2 LUFS, −1,1 dBFS).
- 2026-11-20 — Claude — v20 (em finalização): aulas longas e arquivos gigantes (vídeo usado direto do aparelho e copiado em fluxo para o armazenamento do app; aviso para reencontrar o arquivo), exportação em blocos direto no disco com tempo restante, qualidade 1080p/1440p/4K sempre a 60 fps (testado 4K60), linha do tempo leve para 1 h+, color grading em WebGL (15 looks, ajustes finos, LUT .cube), tratamento de voz profissional (redução de ruído e de-esser espectrais, 4 presets), backup dos projetos no Google Drive, vídeos não vão mais para a nuvem.
- 2026-11-20 — Rebeca — Pediu: vídeos no celular, nuvem/backup só dos projetos salvos; repositórios GitHub privados; memória sempre lida no começo das conversas.
