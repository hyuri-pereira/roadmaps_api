import { Injectable } from '@nestjs/common';
import { FirebirdService } from '../../database/firebird.service';
import { Linha, TransacaoFirebird } from '../../database/drivers/driver.interface';
import { paraBooleano, paraDataOuNulo, paraNumero, truncar } from '../../common/utils';

/** Tudo que o worker precisa saber para publicar um card no Asana. */
export interface CardParaSincronizar {
  id: number;
  idRoadmap: number;
  revisao: number;
  titulo: string;
  descricao: string | null;
  dataLimite: Date | null;
  concluido: boolean;
  conclusaoSolicitada: boolean;
  entrarNaSprint: boolean;
  gid: string | null;
  excluidoEm: Date | null;
  situacaoSincronizacao: string;
  idConexao: number;
  gidWorkspace: string;
  /** Destino conforme o checkbox: SPRINT/"A fazer" ou Backlog/"Refino". */
  gidProjetoDestino: string | null;
  gidSecaoDestino: string | null;
  idProjetoDestino: number | null;
  idSecaoDestino: number | null;
  gidProjetoSprint: string | null;
  gidProjetoBacklog: string | null;
  idProjetoSprint: number | null;
  idProjetoBacklog: number | null;
}

@Injectable()
export class SincronizacaoRepository {
  constructor(private readonly db: FirebirdService) {}

  async cardParaSincronizar(idCard: number): Promise<CardParaSincronizar | null> {
    const l = await this.db.queryUm(
      `SELECT I.ID_ROADMAP_ITEM, I.ID_ROADMAP, I.REVISAO, I.TITULO, I.DESCRICAO,
              I.DATA_LIMITE, I.CONCLUIDO, I.CONCLUSAO_SOLICITADA, I.ENTRAR_NA_SPRINT,
              I.ASANA_TAREFA_GID, I.EXCLUIDO_EM, I.SITUACAO_SINCRONIZACAO,
              R.ID_ASANA_CONEXAO,
              W.ASANA_GID AS GID_WORKSPACE,
              R.ID_ASANA_PROJETO_SPRINT, R.ID_ASANA_PROJETO_BACKLOG,
              PS.ASANA_GID AS GID_PROJ_SPRINT, PB.ASANA_GID AS GID_PROJ_BACKLOG,
              IIF(I.ENTRAR_NA_SPRINT, R.ID_ASANA_PROJETO_SPRINT, R.ID_ASANA_PROJETO_BACKLOG)
                AS ID_PROJ_DESTINO,
              IIF(I.ENTRAR_NA_SPRINT, R.ID_ASANA_SECAO_SPRINT, R.ID_ASANA_SECAO_BACKLOG)
                AS ID_SECAO_DESTINO,
              IIF(I.ENTRAR_NA_SPRINT, PS.ASANA_GID, PB.ASANA_GID) AS GID_PROJ_DESTINO,
              IIF(I.ENTRAR_NA_SPRINT, SS.ASANA_GID, SB.ASANA_GID) AS GID_SECAO_DESTINO
         FROM ROADMAP_ITENS I
         JOIN ROADMAPS R ON R.ID_ROADMAP = I.ID_ROADMAP
         JOIN ASANA_PROJETOS PC ON PC.ID_ASANA_PROJETO = R.ID_ASANA_PROJETO_CONTEXTO
         JOIN ASANA_WORKSPACES W ON W.ID_ASANA_WORKSPACE = PC.ID_ASANA_WORKSPACE
         LEFT JOIN ASANA_PROJETOS PS ON PS.ID_ASANA_PROJETO = R.ID_ASANA_PROJETO_SPRINT
         LEFT JOIN ASANA_PROJETOS PB ON PB.ID_ASANA_PROJETO = R.ID_ASANA_PROJETO_BACKLOG
         LEFT JOIN ASANA_SECOES SS ON SS.ID_ASANA_SECAO = R.ID_ASANA_SECAO_SPRINT
         LEFT JOIN ASANA_SECOES SB ON SB.ID_ASANA_SECAO = R.ID_ASANA_SECAO_BACKLOG
        WHERE I.ID_ROADMAP_ITEM = ?`,
      [idCard],
    );
    if (!l) return null;

    return {
      id: Number(l.ID_ROADMAP_ITEM),
      idRoadmap: Number(l.ID_ROADMAP),
      revisao: paraNumero(l.REVISAO),
      titulo: String(l.TITULO),
      descricao: (l.DESCRICAO as string) ?? null,
      dataLimite: paraDataOuNulo(l.DATA_LIMITE),
      concluido: paraBooleano(l.CONCLUIDO),
      conclusaoSolicitada: paraBooleano(l.CONCLUSAO_SOLICITADA),
      entrarNaSprint: paraBooleano(l.ENTRAR_NA_SPRINT),
      gid: (l.ASANA_TAREFA_GID as string) ?? null,
      excluidoEm: paraDataOuNulo(l.EXCLUIDO_EM),
      situacaoSincronizacao: String(l.SITUACAO_SINCRONIZACAO).trim(),
      idConexao: Number(l.ID_ASANA_CONEXAO),
      gidWorkspace: String(l.GID_WORKSPACE),
      gidProjetoDestino: (l.GID_PROJ_DESTINO as string) ?? null,
      gidSecaoDestino: (l.GID_SECAO_DESTINO as string) ?? null,
      idProjetoDestino: l.ID_PROJ_DESTINO ? Number(l.ID_PROJ_DESTINO) : null,
      idSecaoDestino: l.ID_SECAO_DESTINO ? Number(l.ID_SECAO_DESTINO) : null,
      gidProjetoSprint: (l.GID_PROJ_SPRINT as string) ?? null,
      gidProjetoBacklog: (l.GID_PROJ_BACKLOG as string) ?? null,
      idProjetoSprint: l.ID_ASANA_PROJETO_SPRINT ? Number(l.ID_ASANA_PROJETO_SPRINT) : null,
      idProjetoBacklog: l.ID_ASANA_PROJETO_BACKLOG ? Number(l.ID_ASANA_PROJETO_BACKLOG) : null,
    };
  }

  /**
   * Grava o GID recem-criado.
   *
   * Nao mexe em titulo/descricao: se o gestor editou o card enquanto o POST
   * estava em voo, a revisao ja avancou e um job posterior reaplica a
   * alteracao. Aqui so registramos a identidade remota.
   */
  async registrarCriacao(
    idCard: number,
    dados: { gid: string; permalink?: string | null; modificadoEm?: Date | null },
  ): Promise<void> {
    await this.db.executar(
      `UPDATE ROADMAP_ITENS
          SET ASANA_TAREFA_GID = ?,
              ASANA_PERMALINK = ?,
              ASANA_MODIFICADO_EM = ?,
              SINCRONIZADO_EM = CURRENT_TIMESTAMP,
              SITUACAO_SINCRONIZACAO = 'SINCRONIZADO',
              ULTIMO_ERRO = NULL
        WHERE ID_ROADMAP_ITEM = ?`,
      [dados.gid, truncar(dados.permalink ?? null, 1000), dados.modificadoEm ?? null, idCard],
    );
  }

  /**
   * Marca como sincronizado somente se a revisao nao avancou durante o HTTP.
   * Se avancou, o card fica pendente e o proximo job reenvia o estado novo.
   */
  async confirmarSincronizacao(
    idCard: number,
    revisaoNoInicio: number,
    dados: { modificadoEm?: Date | null; permalink?: string | null },
  ): Promise<boolean> {
    return this.db.transacao(async (tx) => {
      const linha = await tx.queryUm<{ ID_ROADMAP_ITEM: number }>(
        `UPDATE ROADMAP_ITENS
            SET SITUACAO_SINCRONIZACAO = 'SINCRONIZADO',
                SINCRONIZADO_EM = CURRENT_TIMESTAMP,
                ASANA_MODIFICADO_EM = COALESCE(?, ASANA_MODIFICADO_EM),
                ASANA_PERMALINK = COALESCE(?, ASANA_PERMALINK),
                ULTIMO_ERRO = NULL
          WHERE ID_ROADMAP_ITEM = ? AND REVISAO = ?
          RETURNING ID_ROADMAP_ITEM`,
        [dados.modificadoEm ?? null, truncar(dados.permalink ?? null, 1000), idCard, revisaoNoInicio],
      );
      return Boolean(linha?.ID_ROADMAP_ITEM);
    });
  }

  async registrarErroNoCard(idCard: number, erro: string, situacao = 'ERRO'): Promise<void> {
    await this.db.executar(
      `UPDATE ROADMAP_ITENS SET ULTIMO_ERRO = ?, SITUACAO_SINCRONIZACAO = ?
        WHERE ID_ROADMAP_ITEM = ?`,
      [erro.slice(0, 4000), situacao, idCard],
    );
  }

  /** Purga fisica: so depois que o Asana confirmou a ausencia. */
  async purgarCard(idCard: number): Promise<void> {
    await this.db.executar('DELETE FROM ROADMAP_ITENS WHERE ID_ROADMAP_ITEM = ?', [idCard]);
  }

  /** Apaga o roadmap so quando nao sobrou nenhum card. */
  async purgarRoadmapSeVazio(idRoadmap: number): Promise<boolean> {
    return this.db.transacao(async (tx) => {
      const excluido = await tx.queryUm<{ TOTAL: number }>(
        'SELECT COUNT(*) AS TOTAL FROM ROADMAPS WHERE ID_ROADMAP = ? AND EXCLUIDO_EM IS NOT NULL',
        [idRoadmap],
      );
      if (Number(excluido?.TOTAL ?? 0) === 0) return false;

      const restantes = await tx.queryUm<{ TOTAL: number }>(
        'SELECT COUNT(*) AS TOTAL FROM ROADMAP_ITENS WHERE ID_ROADMAP = ?',
        [idRoadmap],
      );
      if (Number(restantes?.TOTAL ?? 0) > 0) return false;

      await tx.executar('DELETE FROM ROADMAPS WHERE ID_ROADMAP = ?', [idRoadmap]);
      return true;
    });
  }

  // --------------------------------------------------------- espelhamento

  /**
   * Aplica no banco o estado lido do Asana.
   *
   * Titulo e descricao sao espelho: o que esta no Asana vence, porque foi la
   * que alguem digitou. ORIGEM_ULTIMA_ALTERACAO='ASANA' impede que a trigger
   * BI_CARD_TITULO regenere o titulo padrao por cima.
   */
  async espelharDoAsana(
    idCard: number,
    dados: {
      titulo: string;
      descricao: string | null;
      descricaoBase: string | null;
      dataLimite: Date | null;
      concluido: boolean;
      etapaSprint: string | null;
      responsavelGid: string | null;
      responsavelNome: string | null;
      permalink: string | null;
      modificadoEm: Date | null;
    },
  ): Promise<void> {
    await this.db.executar(
      `UPDATE ROADMAP_ITENS
          SET TITULO = ?, DESCRICAO = ?, DESCRICAO_BASE = ?, DATA_LIMITE = ?,
              CONCLUIDO = ?, ETAPA_SPRINT = ?, ASANA_RESPONSAVEL_GID = ?,
              ASANA_RESPONSAVEL_NOME = ?, ASANA_PERMALINK = ?, ASANA_MODIFICADO_EM = ?,
              ORIGEM_ULTIMA_ALTERACAO = 'ASANA',
              SITUACAO_SINCRONIZACAO = 'SINCRONIZADO',
              SINCRONIZADO_EM = CURRENT_TIMESTAMP,
              ULTIMO_ERRO = NULL
        WHERE ID_ROADMAP_ITEM = ? AND EXCLUIDO_EM IS NULL`,
      [
        truncar(dados.titulo, 1000)!,
        dados.descricao,
        dados.descricaoBase,
        dados.dataLimite,
        dados.concluido,
        dados.etapaSprint,
        dados.responsavelGid,
        truncar(dados.responsavelNome, 150),
        truncar(dados.permalink, 1000),
        dados.modificadoEm,
        idCard,
      ],
    );
  }

  /** Substitui as membresias conhecidas do card pelas que vieram do Asana. */
  async substituirMembresias(
    idCard: number,
    membresias: { idProjeto: number; idSecao: number | null; gerenciada: boolean }[],
  ): Promise<void> {
    await this.db.transacao(async (tx: TransacaoFirebird) => {
      await tx.executar('DELETE FROM ASANA_TAREFA_MEMBRESIAS WHERE ID_ROADMAP_ITEM = ?', [idCard]);
      for (const m of membresias) {
        await tx.executar(
          `INSERT INTO ASANA_TAREFA_MEMBRESIAS
             (ID_ROADMAP_ITEM, ID_ASANA_PROJETO, ID_ASANA_SECAO, GERENCIADA)
           VALUES (?, ?, ?, ?)`,
          [idCard, m.idProjeto, m.idSecao, m.gerenciada],
        );
      }
    });
  }

  /** Cards com GID, para a reconciliacao periodica. */
  async cardsParaReconciliar(limite: number): Promise<{ id: number; gid: string; idConexao: number }[]> {
    const linhas = await this.db.query(
      `SELECT I.ID_ROADMAP_ITEM, I.ASANA_TAREFA_GID, R.ID_ASANA_CONEXAO
         FROM ROADMAP_ITENS I
         JOIN ROADMAPS R ON R.ID_ROADMAP = I.ID_ROADMAP
        WHERE I.EXCLUIDO_EM IS NULL
          AND R.EXCLUIDO_EM IS NULL
          AND I.ASANA_TAREFA_GID IS NOT NULL
          AND R.SITUACAO NOT IN ('CONCLUIDO', 'CANCELADO')
        ORDER BY COALESCE(I.SINCRONIZADO_EM, I.CRIADO_EM)
        FETCH FIRST ? ROWS ONLY`,
      [limite],
    );
    return linhas.map((l: Linha) => ({
      id: Number(l.ID_ROADMAP_ITEM),
      gid: String(l.ASANA_TAREFA_GID),
      idConexao: Number(l.ID_ASANA_CONEXAO),
    }));
  }

  /** Etapa (coluna do SPRINT) correspondente a uma secao do Asana. */
  async etapaPorGidSecao(gidSecao: string): Promise<string | null> {
    const linha = await this.db.queryUm<{ CODIGO: string }>(
      `SELECT E.CODIGO
         FROM EQUIPE_ETAPAS E
         JOIN ASANA_SECOES S ON S.ID_ASANA_SECAO = E.ID_ASANA_SECAO
        WHERE S.ASANA_GID = ?`,
      [gidSecao],
    );
    return linha?.CODIGO ?? null;
  }

  async idsLocaisDe(
    gidProjeto: string,
    gidSecao: string | null,
  ): Promise<{ idProjeto: number; idSecao: number | null } | null> {
    const projeto = await this.db.queryUm<{ ID_ASANA_PROJETO: number }>(
      'SELECT ID_ASANA_PROJETO FROM ASANA_PROJETOS WHERE ASANA_GID = ?',
      [gidProjeto],
    );
    if (!projeto) return null;

    let idSecao: number | null = null;
    if (gidSecao) {
      const secao = await this.db.queryUm<{ ID_ASANA_SECAO: number }>(
        'SELECT ID_ASANA_SECAO FROM ASANA_SECOES WHERE ASANA_GID = ? AND ID_ASANA_PROJETO = ?',
        [gidSecao, Number(projeto.ID_ASANA_PROJETO)],
      );
      idSecao = secao ? Number(secao.ID_ASANA_SECAO) : null;
    }

    return { idProjeto: Number(projeto.ID_ASANA_PROJETO), idSecao };
  }
}
