import { EventoNotificacao } from './notificacoes.dto';

export interface ContextoMensagem {
  roadmapTitulo: string;
  projeto: string;
  cardTitulo: string | null;
  cardLink: string | null;
  percentual: number;
  totalCards: number;
  cardsConcluidos: number;
}

export interface MensagemMontada {
  assunto: string;
  texto: string;
  html: string;
}

const TITULOS: Record<EventoNotificacao, string> = {
  ROADMAP_CONCLUIDO: 'Roadmap concluido',
  CARD_PARADO: 'Card parado',
  CARD_PENDENCIA_EXTERNA: 'Card com pendencia externa',
  CARD_CONCLUIDO: 'Card concluido',
};

/**
 * Monta o texto do aviso.
 *
 * O mesmo conteudo serve para e-mail e WhatsApp: no WhatsApp usamos a versao
 * em texto puro, com negrito do proprio app.
 */
export function montarMensagem(
  evento: EventoNotificacao,
  contexto: ContextoMensagem,
): MensagemMontada {
  const titulo = TITULOS[evento] ?? 'Aviso do roadmap';
  const linhas: string[] = [];

  if (evento === 'ROADMAP_CONCLUIDO') {
    linhas.push(`O roadmap "${contexto.roadmapTitulo}" foi concluido.`);
    linhas.push(`Projeto: ${contexto.projeto}`);
    linhas.push(`Cards concluidos: ${contexto.cardsConcluidos} de ${contexto.totalCards}.`);
  } else {
    linhas.push(`Card: ${contexto.cardTitulo ?? '(sem titulo)'}`);
    linhas.push(`Roadmap: ${contexto.roadmapTitulo}`);
    linhas.push(`Projeto: ${contexto.projeto}`);

    if (evento === 'CARD_PARADO') {
      linhas.push('O card foi movido para a coluna "Parado".');
    } else if (evento === 'CARD_PENDENCIA_EXTERNA') {
      linhas.push('O card foi movido para a coluna "Pendencia externa".');
    } else {
      linhas.push('O card foi concluido.');
    }

    linhas.push(
      `Progresso do roadmap: ${contexto.percentual.toFixed(2)}% ` +
        `(${contexto.cardsConcluidos}/${contexto.totalCards}).`,
    );
    if (contexto.cardLink) linhas.push(`Abrir no Asana: ${contexto.cardLink}`);
  }

  const texto = `*${titulo}*\n\n${linhas.join('\n')}`;

  const html = [
    `<h2 style="margin:0 0 12px;font-family:system-ui,sans-serif">${escapar(titulo)}</h2>`,
    '<div style="font-family:system-ui,sans-serif;line-height:1.6">',
    ...linhas.map((linha) =>
      contexto.cardLink && linha.includes(contexto.cardLink)
        ? `<p><a href="${escapar(contexto.cardLink)}">Abrir o card no Asana</a></p>`
        : `<p>${escapar(linha)}</p>`,
    ),
    '</div>',
  ].join('');

  return {
    assunto: `[Roadmap] ${titulo}: ${contexto.roadmapTitulo}`,
    texto,
    html,
  };
}

function escapar(valor: string): string {
  return valor
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
