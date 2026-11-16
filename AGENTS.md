# Contexto compartilhado — Claude e ChatGPT/Codex

Este arquivo é a fonte única de regras do projeto. O Claude Code lê pelo `CLAUDE.md`, que importa este arquivo; o Codex/ChatGPT lê o `AGENTS.md` direto. Atualize só aqui.

## Quem e o quê
- Dona: Rebeca, agência de marketing. Não é programadora: responda em português, simples, e faça o trabalho em vez de pedir que ela faça.
- Produto principal: `estudio-cursos/`, um app web para editar vídeos de cursos online de clientes (a maioria médicos).
  - Cortes secos, legendas, destaques de palavras-chave ao lado do especialista.
  - Perfil e estilo por cliente, templates, paletas, trilha sonora, efeitos sonoros, capa, Reels automático, capítulos.
  - Exportação para Hotmart, Eduzz e Sympla, até 4K60.
  - Visual minimalista, todo o texto em português, funciona no celular, salva na nuvem ao vivo.
- Publicado como Artifact do claude.ai: https://claude.ai/artifact/TktWxL7iosS8x65jYTAH69
- `skills/eduvid-celular/`: skill que edita vídeos por linha de comando (Python + ffmpeg).

## Como o app é feito
- HTML, CSS e JS puros, com módulos ES, sem etapa de build. Abra `estudio-cursos/index.html` por um servidor local (`python3 -m http.server`).
- Bibliotecas pesadas carregam só quando são usadas (lazy):
  - `vendor/mediabunny.min.mjs`;
  - `js/render-offline.js`;
  - JSZip.
  Mantenha assim: abrir o app precisa ser rápido.
- Navegação: rotas por hash; `addBack()` põe o botão "‹ Voltar" em toda tela que não é a inicial.
- Testes: Playwright emulando iPhone 13 e 4G lento. Toda mudança precisa ser testada antes de publicar.

## Regras de segurança (obrigatórias)
- Nunca grave chaves, senhas, tokens, dados de pacientes ou de clientes em arquivos do repositório nem em mensagens de commit.
- Segredos ficam fora do git (`.env` está no `.gitignore`).
- Não envie dados de clientes para serviços externos sem a Rebeca pedir.
- Nada de `git push --force`, nem apagar branches ou histórico.
- Trabalhe em branch própria; não faça merge na `master` sem a Rebeca pedir.

## Memória compartilhada
- Decisões e o andamento do projeto ficam em `MEMORIA.md`. Leia antes de começar e acrescente uma linha ao terminar algo importante.
- Assim, se uma das IAs ficar sem limite de uso, a outra continua do mesmo ponto.
