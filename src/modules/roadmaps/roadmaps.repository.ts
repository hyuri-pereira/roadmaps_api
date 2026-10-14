import { Injectable } from '@nestjs/common';
import { FirebirdService } from '../../database/firebird.service';
import { Linha, TransacaoFirebird } from '../../database/drivers/driver.interface';
import { paraDataOuNulo, paraNumero } from '../../common/utils';
import { FiltroRoadmapsDto, RoadmapDto, SituacaoRoadmap } from './roadmaps.dto';

/**
 * Leitura sempre pela VW_ROADMAP_PROGRESSO, que ja calcula o percentual e
 * desconta os cards excluidos logicamente. O percentual nunca e armazenado.
 */
const SELECT_BASE = `
  SELECT R.ID_ROADMAP, R.TITULO, R.OBJETIVO, R.ID_USUARIO_GESTOR, U.NOME AS GESTOR_NOME,
         R.ID_PROJETO, PL.NOME AS PROJETO_NOME,
         R.ID_ASANA_CONEXAO, R.ID_ASANA_EQUIPE, E.NOME AS EQUIPE_NOME,
         R.ID_ASANA_PROJETO_CONTEXTO, P.NOME AS ASANA_PROJETO_NOME,
         R.DATA_INICIO, R.DATA_FIM, R.SITUACAO, R.CONCLUSAO_SOLICITADA_EM, R.CONCLUIDO_EM,
         R.CRIADO_EM, R.ATUALIZADO_EM, R.REVISAO,
         V.TOTAL_CARDS, V.CARDS_CONCLUIDOS, V.CARDS_PENDENTES, V.PERCENTUAL_CONCLUSAO
    FROM ROADMAPS R
    JOIN VW_ROADMAP_PROGRESSO V ON V.ID_ROADMAP = R.ID_ROADMAP
    JOIN USUARIOS U ON U.ID_USUARIO = R.ID_USUARIO_GESTOR
    JOIN PROJETOS PL ON PL.ID_PROJETO = R.ID_PROJETO
    LEFT JOIN ASANA_EQUIPES E ON E.ID_ASANA_EQUIPE = R.ID_ASANA_EQUIPE
    LEFT JOIN ASANA_PROJETOS P ON P.ID_ASANA_PROJETO = R.ID_ASANA_PROJETO_CONTEXTO
   WHERE R.EXCLUIDO_EM IS NULL
`;

function mapear(l: Linha): RoadmapDto {
  return {
    id: Number(l.ID_ROADMAP),
    titulo: String(l.TITULO),
    objetivo: String(l.OBJETIVO ?? ''),
    idUsuarioGestor: Number(l.ID_USUARIO_GESTOR),
    gestorNome: String(l.GESTOR_NOME),
    idProjeto: Number(l.ID_PROJETO),
    projetoContextoNome: String(l.PROJETO_NOME),
    // Roadmap local nao tem equipe nem projeto do Asana.
    vinculadoAsana: l.ID_ASANA_EQUIPE !== null && l.ID_ASANA_EQUIPE !== undefined,
    idAsanaConexao: numeroOuNulo(l.ID_ASANA_CONEXAO),
    idAsanaEquipe: numeroOuNulo(l.ID_ASANA_EQUIPE),
    equipeNome: (l.EQUIPE_NOME as string) ?? null,
    idProjetoContexto: numeroOuNulo(l.ID_ASANA_PROJETO_CONTEXTO),
    asanaProjetoNome: (l.ASANA_PROJETO_NOME as string) ?? null,
    dataInicio: comoDataIso(l.DATA_INICIO),
    dataFim: comoDataIso(l.DATA_FIM),
    situacao: String(l.SITUACAO) as SituacaoRoadmap,
    percentualConclusao: paraNumero(l.PERCENTUAL_CONCLUSAO),
    totalCards: paraNumero(l.TOTAL_CARDS),
    cardsConcluidos: paraNumero(l.CARDS_CONCLUIDOS),
    cardsPendentes: paraNumero(l.CARDS_PENDENTES),
    conclusaoSolicitadaEm: paraDataOuNulo(l.CONCLUSAO_SOLICITADA_EM),
    concluidoEm: paraDataOuNulo(l.CONCLUIDO_EM),
    criadoEm: paraDataOuNulo(l.CRIADO_EM) as Date,
    atualizadoEm: paraDataOuNulo(l.ATUALIZADO_EM) as Date,
    revisao: paraNumero(l.REVISAO),
  };
}

function numeroOuNulo(valor: unknown): number | null {
  return valor === null || valor === undefined ? null : Number(valor);
}

/** DATE do Firebird chega como Date; a API expoe AAAA-MM-DD. */
function comoDataIso(valor: unknown): string {
  const data = paraDataOuNulo(valor);
  if (!data) return '';
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const dia = String(data.getDate()).padStart(2, '0');
  return `${data.getFullYear()}-${mes}-${dia}`;
}

@Injectable()
export class RoadmapsRepository {
  constructor(private readonly db: FirebirdService) {}

  async porId(id: number): Promise<RoadmapDto | null> {
    const linha = await this.db.queryUm(`${SELECT_BASE} AND R.ID_ROADMAP = ?`, [id]);
    return linha ? mapear(linha) : null;
  }

  /** Versao crua, para checagens internas que nao precisam do progresso. */
  async dadosBasicos(
    id: number,
  ): Promise<{
    id: number;
    idGestor: number;
    idProjeto: number;
    /** null = roadmap local */
    idEquipe: number | null;
    idConexao: number | null;
    situacao: SituacaoRoadmap;
    revisao: number;
  } | null> {
    const linha = await this.db.queryUm(
      `SELECT ID_ROADMAP, ID_USUARIO_GESTOR, ID_PROJETO, ID_ASANA_EQUIPE, ID_ASANA_CONEXAO,
              SITUACAO, REVISAO
         FROM ROADMAPS WHERE ID_ROADMAP = ? AND EXCLUIDO_EM IS NULL`,
      [id],
    );
    if (!linha) return null;
    return {
      id: Number(linha.ID_ROADMAP),
      idGestor: Number(linha.ID_USUARIO_GESTOR),
      idProjeto: Number(linha.ID_PROJETO),
      idEquipe: numeroOuNulo(linha.ID_ASANA_EQUIPE),
      idConexao: numeroOuNulo(linha.ID_ASANA_CONEXAO),
      situacao: String(linha.SITUACAO) as SituacaoRoadmap,
      revisao: Number(linha.REVISAO),
    };
  }

  /**
   * `visibilidade` null = ADMIN (ve tudo). Senao: roadmaps das equipes do
   * gestor e os roadmaps locais em que ele e o gestor.
   */
  async listar(
    filtro: FiltroRoadmapsDto,
    visibilidade: { equipes: number[]; idUsuario: number } | null,
    offset: number,
    limite: number,
  ): Promise<{ itens: RoadmapDto[]; total: number }> {
    const condicoes: string[] = [];
    const parametros: unknown[] = [];

    if (filtro.idProjeto) {
      condicoes.push('R.ID_PROJETO = ?');
      parametros.push(filtro.idProjeto);
    }
    if (filtro.idAsanaEquipe) {
      condicoes.push('R.ID_ASANA_EQUIPE = ?');
      parametros.push(filtro.idAsanaEquipe);
    }
    if (filtro.idProjetoContexto) {
      condicoes.push('R.ID_ASANA_PROJETO_CONTEXTO = ?');
      parametros.push(filtro.idProjetoContexto);
    }
    if (filtro.idUsuarioGestor) {
      condicoes.push('R.ID_USUARIO_GESTOR = ?');
      parametros.push(filtro.idUsuarioGestor);
    }
    if (filtro.situacao) {
      condicoes.push('R.SITUACAO = ?');
      parametros.push(filtro.situacao);
    }
    if (filtro.busca) {
      condicoes.push('UPPER(R.TITULO) LIKE ?');
      parametros.push(`%${filtro.busca.toUpperCase()}%`);
    }
    if (visibilidade !== null) {
      const { sql, params } = filtroVisibilidade('R', visibilidade);
      condicoes.push(sql);
      parametros.push(...params);
    }

    const extra = condicoes.length ? ` AND ${condicoes.join(' AND ')}` : '';

    const [linhas, total] = await Promise.all([
      this.db.query(
        `${SELECT_BASE}${extra} ORDER BY R.DATA_INICIO DESC, R.ID_ROADMAP DESC
         OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`,
        [...parametros, offset, limite] as never[],
      ),
      this.db.queryUm<{ TOTAL: number }>(
        `SELECT COUNT(*) AS TOTAL FROM ROADMAPS R WHERE R.EXCLUIDO_EM IS NULL${extra}`,
        parametros as never[],
      ),
    ]);

    return { itens: linhas.map(mapear), total: Number(total?.TOTAL ?? 0) };
  }

  /** Sempre nasce local; o vinculo com o Asana e um passo a parte. */
  async criar(dados: {
    idGestor: number;
    idProjeto: number;
    titulo: string;
    objetivo: string;
    dataInicio: Date;
    dataFim: Date;
    situacao: string;
  }): Promise<number> {
    return this.db.transacao(async (tx) => {
      const linha = await tx.queryUm<{ ID_ROADMAP: number }>(
        `INSERT INTO ROADMAPS
           (ID_USUARIO_GESTOR, ID_PROJETO, TITULO, OBJETIVO, DATA_INICIO, DATA_FIM, SITUACAO)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING ID_ROADMAP`,
        [
          dados.idGestor,
          dados.idProjeto,
          dados.titulo,
          dados.objetivo,
          dados.dataInicio,
          dados.dataFim,
          dados.situacao,
        ],
      );
      return Number(linha!.ID_ROADMAP);
    });
  }

  async atualizar(
    id: number,
    campos: Partial<{
      TITULO: string;
      OBJETIVO: string;
      DATA_INICIO: Date;
      DATA_FIM: Date;
      SITUACAO: string;
    }>,
  ): Promise<void> {
    const chaves = Object.keys(campos);
    if (!chaves.length) return;
    const atribuicoes = chaves.map((c) => `${c} = ?`).join(', ');
    const valores = chaves.map((c) => (campos as Record<string, unknown>)[c]);
    await this.db.executar(`UPDATE ROADMAPS SET ${atribuicoes} WHERE ID_ROADMAP = ?`, [
      ...valores,
      id,
    ] as never[]);
  }

  /**
   * Liga um roadmap local ao Asana, tudo numa transacao:
   *  1. o projeto local ganha o vinculo com o projeto do Asana (se ainda nao tinha);
   *  2. o roadmap recebe conexao, equipe e contexto - a BIU_RM_DESTINOS valida o
   *     gestor na equipe e copia os destinos SPRINT/Backlog;
   *  3. cada card ativo ainda sem tarefa entra na fila (SP_SOLICITAR_SYNC_ITEM),
   *     inclusive os ja concluidos: o worker cria e conclui em seguida.
   */
  async vincularAsana(dados: {
    idRoadmap: number;
    idProjeto: number;
    vincularProjeto: boolean;
    idConexao: number;
    idEquipe: number;
    idProjetoAsana: number;
    idUsuario: number;
  }): Promise<number> {
    return this.db.transacao(async (tx) => {
      if (dados.vincularProjeto) {
        await tx.executar('UPDATE PROJETOS SET ID_ASANA_PROJETO = ? WHERE ID_PROJETO = ?', [
          dados.idProjetoAsana,
          dados.idProjeto,
        ]);
      }

      // O backlog e sobrescrito pela trigger; vai o contexto so para o CHECK.
      await tx.executar(
        `UPDATE ROADMAPS
            SET ID_ASANA_CONEXAO = ?, ID_ASANA_EQUIPE = ?,
                ID_ASANA_PROJETO_CONTEXTO = ?, ID_ASANA_PROJETO_BACKLOG = ?
          WHERE ID_ROADMAP = ? AND ID_ASANA_EQUIPE IS NULL`,
        [
          dados.idConexao,
          dados.idEquipe,
          dados.idProjetoAsana,
          dados.idProjetoAsana,
          dados.idRoadmap,
        ],
      );

      const cards = await tx.query<{ ID_ROADMAP_ITEM: number }>(
        `SELECT ID_ROADMAP_ITEM FROM ROADMAP_ITENS
          WHERE ID_ROADMAP = ? AND EXCLUIDO_EM IS NULL AND ASANA_TAREFA_GID IS NULL
          ORDER BY ORDEM, ID_ROADMAP_ITEM`,
        [dados.idRoadmap],
      );
      for (const card of cards) {
        await tx.executar('EXECUTE PROCEDURE SP_SOLICITAR_SYNC_ITEM(?)', [
          Number(card.ID_ROADMAP_ITEM),
        ]);
      }

      await tx.executar(
        `INSERT INTO AUDITORIA_EVENTOS (ID_USUARIO, TIPO_ENTIDADE, ID_ENTIDADE, ACAO, ORIGEM, RESUMO)
         VALUES (?, 'ROADMAP', ?, 'VINCULAR_ASANA', 'USUARIO', ?)`,
        [
          dados.idUsuario,
          dados.idRoadmap,
          `Roadmap vinculado ao Asana; ${cards.length} card(s) enfileirado(s) para criacao`,
        ],
      );
      return cards.length;
    });
  }

  /** Delega ao banco: a procedure ja cuida da fila e da auditoria. */
  async solicitarConclusao(id: number, idUsuario: number): Promise<void> {
    await this.db.executar('EXECUTE PROCEDURE SP_SOLICITAR_CONCLUSAO_ROADMAP(?, ?)', [
      id,
      idUsuario,
    ]);
  }

  async excluir(id: number, idUsuario: number): Promise<void> {
    await this.db.transacao(async (tx: TransacaoFirebird) => {
      await tx.executar('EXECUTE PROCEDURE SP_EXCLUIR_ROADMAP(?)', [id]);
      await tx.executar(
        `INSERT INTO AUDITORIA_EVENTOS (ID_USUARIO, TIPO_ENTIDADE, ID_ENTIDADE, ACAO, ORIGEM, RESUMO)
         VALUES (?, 'ROADMAP', ?, 'EXCLUIR', 'USUARIO', ?)`,
        [idUsuario, id, 'Roadmap e cards marcados para exclusao'],
      );
    });
  }

  async contarCardsPendentes(id: number): Promise<number> {
    const linha = await this.db.queryUm<{ TOTAL: number }>(
      `SELECT COUNT(*) AS TOTAL FROM ROADMAP_ITENS
        WHERE ID_ROADMAP = ? AND EXCLUIDO_EM IS NULL AND CONCLUIDO = FALSE`,
      [id],
    );
    return Number(linha?.TOTAL ?? 0);
  }
}

/**
 * Recorte de visibilidade para quem nao e ADMIN: roadmaps das equipes do
 * Asana em que participa + os roadmaps locais dos quais e o gestor. Serve
 * para qualquer tabela/view com ID_ASANA_EQUIPE e ID_USUARIO_GESTOR.
 */
export function filtroVisibilidade(
  alias: string,
  visibilidade: { equipes: number[]; idUsuario: number },
): { sql: string; params: unknown[] } {
  const prefixo = alias ? `${alias}.` : '';
  const local = `(${prefixo}ID_ASANA_EQUIPE IS NULL AND ${prefixo}ID_USUARIO_GESTOR = ?)`;
  if (!visibilidade.equipes.length) return { sql: local, params: [visibilidade.idUsuario] };
  const marcadores = visibilidade.equipes.map(() => '?').join(',');
  return {
    sql: `(${prefixo}ID_ASANA_EQUIPE IN (${marcadores}) OR ${local})`,
    params: [...visibilidade.equipes, visibilidade.idUsuario],
  };
}
