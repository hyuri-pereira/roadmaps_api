import { Injectable } from '@nestjs/common';
import { FirebirdService } from '../../database/firebird.service';
import { TransacaoFirebird } from '../../database/drivers/driver.interface';
import { paraBooleano, paraDataOuNulo } from '../../common/utils';
import {
  DestinosEquipeDto,
  EquipeConfiguradaDto,
  EtapaConfiguradaDto,
  GestorDaEquipeDto,
} from './equipes.dto';

export interface AcessoEquipe {
  participa: boolean;
  podeEditar: boolean;
}

@Injectable()
export class EquipesRepository {
  constructor(private readonly db: FirebirdService) {}

  // -------------------------------------------------------------- acessos

  async acessoDoUsuario(idEquipe: number, idUsuario: number): Promise<AcessoEquipe> {
    const linha = await this.db.queryUm(
      `SELECT PODE_EDITAR FROM EQUIPE_GESTORES
        WHERE ID_ASANA_EQUIPE = ? AND ID_USUARIO = ? AND ATIVO = TRUE`,
      [idEquipe, idUsuario],
    );
    if (!linha) return { participa: false, podeEditar: false };
    return { participa: true, podeEditar: paraBooleano(linha.PODE_EDITAR) };
  }

  async listarDoUsuario(idUsuario: number): Promise<EquipeConfiguradaDto[]> {
    const linhas = await this.db.query(
      `SELECT E.ID_ASANA_EQUIPE, E.NOME, E.ASANA_GID, G.PODE_EDITAR,
              IIF(D.ID_ASANA_EQUIPE IS NULL, FALSE, TRUE) AS TEM_DESTINOS,
              (SELECT COUNT(*) FROM EQUIPE_ETAPAS T WHERE T.ID_ASANA_EQUIPE = E.ID_ASANA_EQUIPE)
                AS ETAPAS
         FROM EQUIPE_GESTORES G
         JOIN ASANA_EQUIPES E ON E.ID_ASANA_EQUIPE = G.ID_ASANA_EQUIPE
         LEFT JOIN EQUIPE_DESTINOS D ON D.ID_ASANA_EQUIPE = E.ID_ASANA_EQUIPE
        WHERE G.ID_USUARIO = ? AND G.ATIVO = TRUE
        ORDER BY E.NOME`,
      [idUsuario],
    );
    return linhas.map((l) => ({
      id: Number(l.ID_ASANA_EQUIPE),
      nome: String(l.NOME),
      asanaGid: String(l.ASANA_GID),
      podeEditar: paraBooleano(l.PODE_EDITAR),
      destinosConfigurados: paraBooleano(l.TEM_DESTINOS),
      etapasMapeadas: Number(l.ETAPAS ?? 0),
    }));
  }

  async listarGestores(idEquipe: number): Promise<GestorDaEquipeDto[]> {
    const linhas = await this.db.query(
      `SELECT U.ID_USUARIO, U.NOME, U.EMAIL, G.PODE_EDITAR, G.ATIVO
         FROM EQUIPE_GESTORES G
         JOIN USUARIOS U ON U.ID_USUARIO = G.ID_USUARIO
        WHERE G.ID_ASANA_EQUIPE = ?
        ORDER BY U.NOME`,
      [idEquipe],
    );
    return linhas.map((l) => ({
      idUsuario: Number(l.ID_USUARIO),
      nome: String(l.NOME),
      email: String(l.EMAIL),
      podeEditar: paraBooleano(l.PODE_EDITAR),
      ativo: paraBooleano(l.ATIVO),
    }));
  }

  async adicionarGestor(idEquipe: number, idUsuario: number, podeEditar: boolean): Promise<void> {
    await this.db.executar(
      `UPDATE OR INSERT INTO EQUIPE_GESTORES (ID_ASANA_EQUIPE, ID_USUARIO, PODE_EDITAR, ATIVO)
       VALUES (?, ?, ?, TRUE)
       MATCHING (ID_ASANA_EQUIPE, ID_USUARIO)`,
      [idEquipe, idUsuario, podeEditar],
    );
  }

  async removerGestor(idEquipe: number, idUsuario: number): Promise<void> {
    // Desativa em vez de apagar: roadmaps antigos continuam apontando o dono.
    await this.db.executar(
      `UPDATE EQUIPE_GESTORES SET ATIVO = FALSE
        WHERE ID_ASANA_EQUIPE = ? AND ID_USUARIO = ?`,
      [idEquipe, idUsuario],
    );
  }

  async contarEditores(idEquipe: number): Promise<number> {
    const linha = await this.db.queryUm<{ TOTAL: number }>(
      `SELECT COUNT(*) AS TOTAL FROM EQUIPE_GESTORES
        WHERE ID_ASANA_EQUIPE = ? AND ATIVO = TRUE AND PODE_EDITAR = TRUE`,
      [idEquipe],
    );
    return Number(linha?.TOTAL ?? 0);
  }

  // ------------------------------------------------------------- destinos

  async obterDestinos(idEquipe: number): Promise<DestinosEquipeDto | null> {
    const linha = await this.db.queryUm(
      `SELECT D.ID_ASANA_EQUIPE, E.NOME AS EQUIPE_NOME,
              D.ID_PROJETO_SPRINT, PS.NOME AS PROJETO_SPRINT_NOME,
              D.ID_SECAO_A_FAZER, SF.NOME AS SECAO_FAZER_NOME,
              D.ID_PROJETO_BACKLOG, PB.NOME AS PROJETO_BACKLOG_NOME,
              D.ID_SECAO_REFINO, SR.NOME AS SECAO_REFINO_NOME,
              D.ATUALIZADO_EM
         FROM EQUIPE_DESTINOS D
         JOIN ASANA_EQUIPES E ON E.ID_ASANA_EQUIPE = D.ID_ASANA_EQUIPE
         JOIN ASANA_PROJETOS PS ON PS.ID_ASANA_PROJETO = D.ID_PROJETO_SPRINT
         JOIN ASANA_SECOES SF ON SF.ID_ASANA_SECAO = D.ID_SECAO_A_FAZER
         JOIN ASANA_PROJETOS PB ON PB.ID_ASANA_PROJETO = D.ID_PROJETO_BACKLOG
         JOIN ASANA_SECOES SR ON SR.ID_ASANA_SECAO = D.ID_SECAO_REFINO
        WHERE D.ID_ASANA_EQUIPE = ?`,
      [idEquipe],
    );
    if (!linha) return null;
    return {
      idEquipe: Number(linha.ID_ASANA_EQUIPE),
      equipeNome: String(linha.EQUIPE_NOME),
      idProjetoSprint: Number(linha.ID_PROJETO_SPRINT),
      projetoSprintNome: String(linha.PROJETO_SPRINT_NOME),
      idSecaoAFazer: Number(linha.ID_SECAO_A_FAZER),
      secaoAFazerNome: String(linha.SECAO_FAZER_NOME),
      idProjetoBacklog: Number(linha.ID_PROJETO_BACKLOG),
      projetoBacklogNome: String(linha.PROJETO_BACKLOG_NOME),
      idSecaoRefino: Number(linha.ID_SECAO_REFINO),
      secaoRefinoNome: String(linha.SECAO_REFINO_NOME),
      atualizadoEm: paraDataOuNulo(linha.ATUALIZADO_EM) as Date,
    };
  }

  /** As validacoes reais (secao pertence ao projeto etc.) estao na trigger. */
  async gravarDestinos(
    idEquipe: number,
    dados: {
      idProjetoSprint: number;
      idSecaoAFazer: number;
      idProjetoBacklog: number;
      idSecaoRefino: number;
    },
  ): Promise<void> {
    await this.db.executar(
      `UPDATE OR INSERT INTO EQUIPE_DESTINOS
         (ID_ASANA_EQUIPE, ID_PROJETO_SPRINT, ID_SECAO_A_FAZER,
          ID_PROJETO_BACKLOG, ID_SECAO_REFINO)
       VALUES (?, ?, ?, ?, ?)
       MATCHING (ID_ASANA_EQUIPE)`,
      [
        idEquipe,
        dados.idProjetoSprint,
        dados.idSecaoAFazer,
        dados.idProjetoBacklog,
        dados.idSecaoRefino,
      ],
    );
  }

  // --------------------------------------------------------------- etapas

  async listarEtapas(idEquipe: number): Promise<EtapaConfiguradaDto[]> {
    const linhas = await this.db.query(
      `SELECT T.CODIGO, T.NOME, T.ORDEM, M.ID_ASANA_SECAO, S.NOME AS SECAO_NOME
         FROM ETAPAS_SPRINT T
         LEFT JOIN EQUIPE_ETAPAS M ON M.CODIGO = T.CODIGO AND M.ID_ASANA_EQUIPE = ?
         LEFT JOIN ASANA_SECOES S ON S.ID_ASANA_SECAO = M.ID_ASANA_SECAO
        ORDER BY T.ORDEM`,
      [idEquipe],
    );
    return linhas.map((l) => ({
      codigo: String(l.CODIGO),
      nome: String(l.NOME),
      ordem: Number(l.ORDEM),
      idSecao: l.ID_ASANA_SECAO ? Number(l.ID_ASANA_SECAO) : null,
      secaoNome: (l.SECAO_NOME as string) ?? null,
    }));
  }

  async gravarEtapas(
    idEquipe: number,
    etapas: { codigo: string; idSecao: number }[],
  ): Promise<void> {
    await this.db.transacao(async (tx: TransacaoFirebird) => {
      // Regravar o mapa inteiro evita sobra de coluna renomeada no Asana.
      await tx.executar('DELETE FROM EQUIPE_ETAPAS WHERE ID_ASANA_EQUIPE = ?', [idEquipe]);
      for (const etapa of etapas) {
        await tx.executar(
          `INSERT INTO EQUIPE_ETAPAS (ID_ASANA_EQUIPE, CODIGO, ID_ASANA_SECAO)
           VALUES (?, ?, ?)`,
          [idEquipe, etapa.codigo, etapa.idSecao],
        );
      }
    });
  }

  /** Secao -> codigo de etapa. Usado ao processar webhooks. */
  async etapaPorSecao(idSecao: number): Promise<string | null> {
    const linha = await this.db.queryUm<{ CODIGO: string }>(
      'SELECT CODIGO FROM EQUIPE_ETAPAS WHERE ID_ASANA_SECAO = ?',
      [idSecao],
    );
    return linha?.CODIGO ?? null;
  }

  async equipesConfiguradas(): Promise<{ idEquipe: number; gidEquipe: string }[]> {
    const linhas = await this.db.query(
      `SELECT E.ID_ASANA_EQUIPE, E.ASANA_GID
         FROM EQUIPE_DESTINOS D
         JOIN ASANA_EQUIPES E ON E.ID_ASANA_EQUIPE = D.ID_ASANA_EQUIPE`,
    );
    return linhas.map((l) => ({
      idEquipe: Number(l.ID_ASANA_EQUIPE),
      gidEquipe: String(l.ASANA_GID),
    }));
  }
}
