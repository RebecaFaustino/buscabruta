// Presets de exportação por plataforma. Valores são recomendações editáveis;
// confira sempre os limites atuais no painel de cada plataforma.
export const PLATFORMS = {
  hotmart: { name: 'Hotmart (Club)', w: 1920, h: 1080, fps: 30, vbr: 8_000_000, note: 'MP4 H.264 + AAC, 16:9. Envie a legenda .srt junto da aula.' },
  eduzz:   { name: 'Eduzz (Nutror)', w: 1920, h: 1080, fps: 30, vbr: 8_000_000, note: 'MP4 H.264, 16:9, 1080p.' },
  sympla:  { name: 'Sympla Play', w: 1920, h: 1080, fps: 30, vbr: 6_000_000, note: 'MP4 16:9, 1080p.' },
  kiwify:  { name: 'Kiwify', w: 1920, h: 1080, fps: 30, vbr: 8_000_000, note: 'MP4 H.264, 1080p.' },
  memberkit: { name: 'Memberkit', w: 1920, h: 1080, fps: 30, vbr: 8_000_000, note: 'MP4 (via Panda/Vimeo/YouTube).' },
  youtube: { name: 'YouTube (não listado)', w: 1920, h: 1080, fps: 30, vbr: 10_000_000, note: 'MP4, ideal para hospedar e incorporar.' },
  reels:   { name: 'Reels / Shorts (divulgação)', w: 1080, h: 1920, fps: 30, vbr: 8_000_000, note: '9:16 vertical para teaser da aula.' },
  rascunho:{ name: 'Rascunho rápido 720p', w: 1280, h: 720, fps: 30, vbr: 3_000_000, note: 'Para aprovação do cliente.' },
};

export const LOOKS = {
  natural:  { name: 'Natural', filter: 'none' },
  clinico:  { name: 'Clínico (limpo e claro)', filter: 'brightness(1.06) contrast(1.05) saturate(0.95)' },
  quente:   { name: 'Consultório quente', filter: 'brightness(1.04) contrast(1.06) saturate(1.08) sepia(0.08)' },
  vivo:     { name: 'Vivo', filter: 'contrast(1.12) saturate(1.2)' },
  suave:    { name: 'Suave', filter: 'brightness(1.05) contrast(0.95) saturate(0.9)' },
  pb:       { name: 'P&B elegante', filter: 'grayscale(1) contrast(1.1)' },
};

export const CAPTION_STYLES = {
  palavra: 'Palavra a palavra (dinâmica)',
  bloco: 'Bloco de frase (clássica)',
  karaoke: 'Frase com palavra ativa destacada',
  nenhuma: 'Sem legenda queimada (só .srt)',
};

// Termos médicos comuns para sugerir palavras-chave automaticamente.
export const MED_TERMS = ['diagnóstico','tratamento','prevenção','sintoma','sintomas','inflamação','hormônio','hormônios','metabolismo','insulina','glicemia','colesterol','pressão','arterial','cardíaco','coração','intestino','microbiota','imunidade','vitamina','proteína','sono','estresse','cortisol','tireoide','obesidade','diabetes','hipertensão','dor','exame','exames','protocolo','evidência','estudo','pacientes','paciente','saúde','longevidade','nutrição','dieta','jejum','exercício','pele','colágeno','cirurgia','procedimento','medicamento','dose','risco','fatores','genética','câncer','ansiedade','depressão','cérebro','memória','fertilidade','gestação','menopausa','testosterona','estrogênio'];
