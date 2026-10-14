/**
 * Montagem do corpo (notes) da tarefa no Asana.
 *
 * O bloco de referencias e SEMPRE o ultimo pedaco do texto e comeca na linha
 * "Links de referencia:". Isso permite regravar so esse bloco e preservar o
 * que o time escreveu no Asana acima dele, que e exatamente o que o contrato
 * de integracao exige: webhook espelha o texto remoto, edicao local troca
 * apenas o bloco gerenciado.
 *
 * O mesmo formato e gerado pela procedure SP_MONTAR_CARD, para que criar
 * pelo banco ou pela aplicacao produza um corpo identico.
 */

export const MARCADOR_REFERENCIAS = 'Links de referencia:';

export interface ReferenciaParaCorpo {
  rotulo?: string | null;
  url: string;
}

export function montarBlocoReferencias(referencias: ReferenciaParaCorpo[]): string {
  if (!referencias.length) return '';
  const linhas = referencias.map((ref) =>
    ref.rotulo ? `- ${ref.rotulo}: ${ref.url}` : `- ${ref.url}`,
  );
  return `${MARCADOR_REFERENCIAS}\n${linhas.join('\n')}`;
}

/** Texto sem o bloco gerenciado, para guardar como DESCRICAO_BASE. */
export function removerBlocoReferencias(corpo: string | null | undefined): string {
  if (!corpo) return '';
  const posicao = corpo.lastIndexOf(MARCADOR_REFERENCIAS);
  if (posicao === -1) return corpo.trimEnd();
  return corpo.slice(0, posicao).trimEnd();
}

/**
 * Junta a descricao base com o bloco de referencias.
 *
 * @param base texto livre do card (sem o bloco)
 * @param referencias links e arquivos cadastrados
 */
export function montarCorpo(
  base: string | null | undefined,
  referencias: ReferenciaParaCorpo[],
): string {
  const texto = (base ?? '').trimEnd();
  const bloco = montarBlocoReferencias(referencias);
  if (!bloco) return texto;
  return texto ? `${texto}\n\n${bloco}` : bloco;
}

/**
 * Aplica as referencias locais sobre o corpo que veio do Asana.
 *
 * Preserva o texto remoto (que pode ter sido editado por outra pessoa) e
 * substitui apenas o bloco gerenciado.
 */
export function mesclarComCorpoRemoto(
  corpoRemoto: string | null | undefined,
  referencias: ReferenciaParaCorpo[],
): string {
  return montarCorpo(removerBlocoReferencias(corpoRemoto), referencias);
}

/** Nomes legiveis das prioridades, na ordem usada no titulo do card. */
export const NOMES_PRIORIDADE: Record<number, string> = {
  1: 'URGENTE',
  2: 'ALTA',
  3: 'MEDIA',
  4: 'BAIXA',
};

/**
 * Titulo padrao: PROJETO - PRIORIDADE [- DD/MM/AAAA] - ROADMAP
 *
 * O PROJETO e o projeto de contexto do roadmap, nunca o SPRINT. A secao da
 * data some por completo quando nao ha prazo.
 */
export function montarTitulo(dados: {
  projeto: string;
  prioridade: number;
  dataLimite?: Date | string | null;
  roadmap: string;
}): string {
  const partes = [dados.projeto, NOMES_PRIORIDADE[dados.prioridade] ?? 'BAIXA'];

  const prazo = formatarPrazo(dados.dataLimite);
  if (prazo) partes.push(prazo);

  partes.push(dados.roadmap);
  return partes.join(' - ');
}

function formatarPrazo(valor?: Date | string | null): string | null {
  if (!valor) return null;
  const data = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(data.getTime())) return null;
  const dia = String(data.getDate()).padStart(2, '0');
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  return `${dia}/${mes}/${data.getFullYear()}`;
}
