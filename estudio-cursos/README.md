# Estúdio de Cursos

Editor de cursos online para clientes (foco em médicos): cortes secos, junção de gravações, zoom dinâmico,
legendas automáticas, palavras-chave em destaque ao lado do expert e exportação pronta para Hotmart,
Eduzz, Sympla, Kiwify, Memberkit e YouTube — com perfil visual próprio para cada cliente.

Roda 100% no navegador. Vídeos e projetos ficam salvos no próprio computador (IndexedDB); nada é enviado a servidores.

## Como abrir

```bash
cd estudio-cursos
python3 -m http.server 8080   # ou: npx serve .
```

Abra http://localhost:8080 no **Google Chrome ou Edge** (exporta MP4 H.264).
Também funciona publicado no GitHub Pages (pasta `/estudio-cursos/`).

## Fluxo

1. **Cliente** — nome, especialidade, CRM/RQE, cores, logo, palavras-chave, lado do expert no vídeo, look de cor,
   estilo de legenda, plataforma padrão e parâmetros de corte. Cada cliente tem sua identidade.
2. **Curso** — módulos e aulas (renomear, reordenar, excluir) e descrição para a página de vendas.
3. **Editor da aula**
   - Importar um ou vários vídeos (são unidos em sequência — junção de cortes).
   - **Cortes secos automáticos** por detecção de silêncio (limiar, pausa mínima, respiro).
   - **Zoom dinâmico** alternado a cada corte (ritmo de jump-cut), zoom por clipe e zoom suave contínuo.
   - Ferramentas: dividir (S), excluir (Delete), zoom (Z), mover clipe, aparar arrastando as bordas, desfazer (Ctrl+Z).
   - **Legendas**: transcrição automática com Whisper no navegador (palavra a palavra), importação .srt/.vtt,
     revisão frase a frase, estilos *palavra a palavra*, *karaokê* e *bloco*. Exporta .srt/.vtt já sincronizado com os cortes.
   - **Destaques**: palavras-chave do cliente ficam coloridas na legenda e geram cartões animados no lado oposto
     ao expert; sugestões automáticas de termos médicos da aula.
   - **Visual**: abertura com título da aula, nome + CRM na tela, logo, looks de cor, voz limpa (EQ + compressor).
4. **Exportar** — preset por plataforma (1080p 16:9 ou 9:16 para Reels), renderização de todas as aulas
   e pacote `.zip` organizado por módulo com vídeos, `.srt`, descrições e planilha da grade do curso.

## Observações

- A renderização acontece em tempo real (uma aula de 10 min leva ~10 min). Mantenha a aba visível.
- Os limites de cada plataforma mudam com o tempo; os presets são recomendações e podem ser ajustados em `js/presets.js`.
- A transcrição baixa o modelo Whisper (~80–250 MB) na primeira vez e depois fica em cache.
