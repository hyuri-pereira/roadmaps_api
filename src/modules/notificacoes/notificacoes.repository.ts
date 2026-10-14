import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { FirebirdService } from '../../database/firebird.service';
import { paraBooleano, paraDataOuNulo, paraNumero } from '../../common/utils';
import {
  CanalNotificacao,
  EventoNotificacao,
  NotificacaoFilaDto,
  ResumoNotificacoesDto,
} from './notificacoes.dto';

export interface NotificacaoReivindicada {
  id: number;
  idEvento: number;
  idUsuario: number;
  canal: CanalNotificacao;
  destinatario: string;
  idWahaSessao: number | null;
  tentativas: number;
  lockToken: string;
  evento: EventoNotificacao;
  resumo: string;
  idRoadmap: number;
  idCard: number | null;
}

@Injectable()
export class NotificacoesRepository {
  constructor(private readonly db: FirebirdService) {}

  // --------------------------------------------------------- preferencias

  async preferenciasDoUsuario(idUsuario: number) {
    const linhas = await this.db.query(
      `SELECT EVENTO, CANAL, ATIVO, CONSENTIMENTO_EM
         FROM NOTIFICACAO_PREFERENCIAS WHERE ID_USUARIO = ?`,
      [idUsuario],
    );
    return linhas.map((l) => ({
      evento: String(l.EVENTO) as EventoNotificacao,
      canal: String(l.CANAL) as CanalNotificacao,
      ativo: paraBooleano(l.ATIVO),
      consentimentoEm: paraDataOuNulo(l.CONSENTIMENTO_EM),
    }));
  }

  /**
   * Liga/desliga um canal.
   *
   * O CHECK do schema exige CONSENTIMENTO_EM preenchido sempre que ATIVO for
   * true: ativar um aviso e, por definicao, registrar o consentimento.
   */
  async definirPreferencia(
    idUsuario: number,
    evento: EventoNotificacao,
    canal: CanalNotificacao,
    ativo: boolean,
  ): Promise<void> {
    await this.db.executar(
      `UPDATE OR INSERT INTO NOTIFICACAO_PREFERENCIAS
         (ID_USUARIO, EVENTO, CANAL, ATIVO, CONSENTIMENTO_EM)
       VALUES (?, ?, ?, ?, ?)
       MATCHING (ID_USUARIO, EVENTO, CANAL)`,
      [idUsuario, evento, canal, ativo, ativo ? new Date() : null],
    );
  }

  /** Ao remover contato ou desativar aviso, a fila pendente e cancelada. */
  async cancelarPendentes(
    idUsuario: number,
    canal: CanalNotificacao,
    motivo: string,
  ): Promise<number> {
    const antes = await this.db.queryUm<{ TOTAL: number }>(
      `SELECT COUNT(*) AS TOTAL FROM NOTIFICACAO_FILA
        WHERE ID_USUARIO = ? AND CANAL = ? AND SITUACAO IN ('PENDENTE', 'PROCESSANDO')`,
      [idUsuario, canal],
    );

    await this.db.executar(
      `UPDATE NOTIFICACAO_FILA
          SET SITUACAO = 'CANCELADO', ULTIMO_ERRO = ?
        WHERE ID_USUARIO = ? AND CANAL = ? AND SITUACAO IN ('PENDENTE', 'PROCESSANDO')`,
      [motivo, idUsuario, canal],
    );

    return Number(antes?.TOTAL ?? 0);
  }

  // ------------------------------------------------------------------ fila

  /** Mesma disciplina da fila de integracao: lease curta com token unico. */
  async reivindicar(lote: number, leaseSegundos: number): Promise<NotificacaoReivindicada[]> {
    const candidatos = await this.db.query(
      `SELECT F.ID_NOTIFICACAO, F.ID_EVENTO, F.ID_USUARIO, F.CANAL, F.DESTINATARIO,
              F.ID_WAHA_SESSAO, F.TENTATIVAS,
              E.EVENTO, E.RESUMO, E.ID_ROADMAP, E.ID_ROADMAP_ITEM
         FROM NOTIFICACAO_FILA F
         JOIN NOTIFICACAO_EVENTOS E ON E.ID_EVENTO = F.ID_EVENTO
        WHERE (F.SITUACAO = 'PENDENTE' AND F.PROXIMA_TENTATIVA_EM <= CURRENT_TIMESTAMP)
           OR (F.SITUACAO = 'PROCESSANDO' AND F.BLOQUEADO_ATE < CURRENT_TIMESTAMP)
        ORDER BY F.ID_NOTIFICACAO
        FETCH FIRST ? ROWS ONLY`,
      [lote],
    );

    const reivindicadas: NotificacaoReivindicada[] = [];

    for (const l of candidatos) {
      const token = randomUUID();
      const id = Number(l.ID_NOTIFICACAO);

      const ok = await this.db.transacao(async (tx) => {
        const linha = await tx.queryUm<{ ID_NOTIFICACAO: number }>(
          `UPDATE NOTIFICACAO_FILA
              SET SITUACAO = 'PROCESSANDO', LOCK_TOKEN = ?,
                  BLOQUEADO_ATE = DATEADD(? SECOND TO CURRENT_TIMESTAMP),
                  TENTATIVAS = TENTATIVAS + 1
            WHERE ID_NOTIFICACAO = ?
              AND ((SITUACAO = 'PENDENTE' AND PROXIMA_TENTATIVA_EM <= CURRENT_TIMESTAMP)
                OR (SITUACAO = 'PROCESSANDO' AND BLOQUEADO_ATE < CURRENT_TIMESTAMP))
            RETURNING ID_NOTIFICACAO`,
          [token, leaseSegundos, id],
        );
        return Boolean(linha?.ID_NOTIFICACAO);
      });

      if (!ok) continue;

      reivindicadas.push({
        id,
        idEvento: Number(l.ID_EVENTO),
        idUsuario: Number(l.ID_USUARIO),
        canal: String(l.CANAL) as CanalNotificacao,
        destinatario: String(l.DESTINATARIO),
        idWahaSessao: l.ID_WAHA_SESSAO ? Number(l.ID_WAHA_SESSAO) : null,
        tentativas: paraNumero(l.TENTATIVAS) + 1,
        lockToken: token,
        evento: String(l.EVENTO) as EventoNotificacao,
        resumo: String(l.RESUMO),
        idRoadmap: Number(l.ID_ROADMAP),
        idCard: l.ID_ROADMAP_ITEM ? Number(l.ID_ROADMAP_ITEM) : null,
      });
    }

    return reivindicadas;
  }

  async marcarEnviada(id: number, token: string, providerMessageId: string | null): Promise<boolean> {
    return this.db.transacao(async (tx) => {
      const linha = await tx.queryUm<{ ID_NOTIFICACAO: number }>(
        `UPDATE NOTIFICACAO_FILA
            SET SITUACAO = 'ENVIADO', ENVIADO_EM = CURRENT_TIMESTAMP,
                PROVIDER_MESSAGE_ID = ?, LOCK_TOKEN = NULL, BLOQUEADO_ATE = NULL,
                ULTIMO_ERRO = NULL
          WHERE ID_NOTIFICACAO = ? AND LOCK_TOKEN = ?
          RETURNING ID_NOTIFICACAO`,
        [providerMessageId, id, token],
      );
      return Boolean(linha?.ID_NOTIFICACAO);
    });
  }

  async reagendar(id: number, token: string, segundos: number, erro: string): Promise<boolean> {
    return this.db.transacao(async (tx) => {
      const linha = await tx.queryUm<{ ID_NOTIFICACAO: number }>(
        `UPDATE NOTIFICACAO_FILA
            SET SITUACAO = 'PENDENTE',
                PROXIMA_TENTATIVA_EM = DATEADD(? SECOND TO CURRENT_TIMESTAMP),
                LOCK_TOKEN = NULL, BLOQUEADO_ATE = NULL, ULTIMO_ERRO = ?
          WHERE ID_NOTIFICACAO = ? AND LOCK_TOKEN = ?
          RETURNING ID_NOTIFICACAO`,
        [segundos, erro.slice(0, 4000), id, token],
      );
      return Boolean(linha?.ID_NOTIFICACAO);
    });
  }

  async marcarFalha(
    id: number,
    token: string,
    erro: string,
    situacao: 'ERRO' | 'CANCELADO',
  ): Promise<boolean> {
    return this.db.transacao(async (tx) => {
      const linha = await tx.queryUm<{ ID_NOTIFICACAO: number }>(
        `UPDATE NOTIFICACAO_FILA
            SET SITUACAO = ?, LOCK_TOKEN = NULL, BLOQUEADO_ATE = NULL, ULTIMO_ERRO = ?
          WHERE ID_NOTIFICACAO = ? AND LOCK_TOKEN = ?
          RETURNING ID_NOTIFICACAO`,
        [situacao, erro.slice(0, 4000), id, token],
      );
      return Boolean(linha?.ID_NOTIFICACAO);
    });
  }

  /** Cada tentativa fica registrada, com sucesso ou nao. */
  async registrarTentativa(dados: {
    idNotificacao: number;
    inicio: Date;
    sucesso: boolean;
    codigoResposta?: string | null;
    erro?: string | null;
  }): Promise<void> {
    await this.db.executar(
      `INSERT INTO NOTIFICACAO_TENTATIVAS
         (ID_NOTIFICACAO, INICIADO_EM, FINALIZADO_EM, CODIGO_RESPOSTA, SUCESSO, ERRO)
       VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?)`,
      [
        dados.idNotificacao,
        dados.inicio,
        dados.codigoResposta?.slice(0, 30) ?? null,
        dados.sucesso,
        dados.erro?.slice(0, 4000) ?? null,
      ],
    );
  }

  // -------------------------------------------------------------- consulta

  async listarDoUsuario(idUsuario: number, limite = 50): Promise<NotificacaoFilaDto[]> {
    const linhas = await this.db.query(
      `SELECT F.ID_NOTIFICACAO, F.ID_EVENTO, E.EVENTO, E.RESUMO, F.CANAL, F.DESTINATARIO,
              F.SITUACAO, F.TENTATIVAS, F.PROXIMA_TENTATIVA_EM, F.ENVIADO_EM, F.ULTIMO_ERRO
         FROM NOTIFICACAO_FILA F
         JOIN NOTIFICACAO_EVENTOS E ON E.ID_EVENTO = F.ID_EVENTO
        WHERE F.ID_USUARIO = ?
        ORDER BY F.ID_NOTIFICACAO DESC
        FETCH FIRST ? ROWS ONLY`,
      [idUsuario, limite],
    );
    return linhas.map((l) => ({
      id: Number(l.ID_NOTIFICACAO),
      idEvento: Number(l.ID_EVENTO),
      evento: String(l.EVENTO) as EventoNotificacao,
      resumo: String(l.RESUMO),
      canal: String(l.CANAL) as CanalNotificacao,
      destinatario: String(l.DESTINATARIO),
      situacao: String(l.SITUACAO),
      tentativas: paraNumero(l.TENTATIVAS),
      proximaTentativaEm: paraDataOuNulo(l.PROXIMA_TENTATIVA_EM) as Date,
      enviadoEm: paraDataOuNulo(l.ENVIADO_EM),
      ultimoErro: (l.ULTIMO_ERRO as string) ?? null,
    }));
  }

  async resumo(): Promise<ResumoNotificacoesDto> {
    const l = await this.db.queryUm(
      `SELECT
         SUM(CASE WHEN SITUACAO IN ('PENDENTE', 'PROCESSANDO') THEN 1 ELSE 0 END) AS PENDENTES,
         SUM(CASE WHEN SITUACAO = 'ERRO' THEN 1 ELSE 0 END) AS COM_ERRO,
         SUM(CASE WHEN SITUACAO = 'CANCELADO' THEN 1 ELSE 0 END) AS CANCELADAS,
         SUM(CASE WHEN SITUACAO = 'ENVIADO'
                   AND ENVIADO_EM > DATEADD(-24 HOUR TO CURRENT_TIMESTAMP)
                  THEN 1 ELSE 0 END) AS ENVIADAS_24H
       FROM NOTIFICACAO_FILA`,
    );
    return {
      pendentes: paraNumero(l?.PENDENTES),
      comErro: paraNumero(l?.COM_ERRO),
      canceladas: paraNumero(l?.CANCELADAS),
      enviadasUltimas24h: paraNumero(l?.ENVIADAS_24H),
    };
  }

  /** Dados do roadmap/card citados no aviso, para compor a mensagem. */
  async contextoDoEvento(idRoadmap: number, idCard: number | null) {
    const roadmap = await this.db.queryUm(
      `SELECT R.TITULO, P.NOME AS PROJETO
         FROM ROADMAPS R
         JOIN PROJETOS P ON P.ID_PROJETO = R.ID_PROJETO
        WHERE R.ID_ROADMAP = ?`,
      [idRoadmap],
    );

    const card = idCard
      ? await this.db.queryUm(
          'SELECT TITULO, ASANA_PERMALINK FROM ROADMAP_ITENS WHERE ID_ROADMAP_ITEM = ?',
          [idCard],
        )
      : null;

    const progresso = await this.db.queryUm(
      `SELECT PERCENTUAL_CONCLUSAO, TOTAL_CARDS, CARDS_CONCLUIDOS
         FROM VW_ROADMAP_PROGRESSO WHERE ID_ROADMAP = ?`,
      [idRoadmap],
    );

    return {
      roadmapTitulo: roadmap ? String(roadmap.TITULO) : `Roadmap ${idRoadmap}`,
      projeto: roadmap ? String(roadmap.PROJETO) : '',
      cardTitulo: card ? String(card.TITULO) : null,
      cardLink: card ? ((card.ASANA_PERMALINK as string) ?? null) : null,
      percentual: paraNumero(progresso?.PERCENTUAL_CONCLUSAO),
      totalCards: paraNumero(progresso?.TOTAL_CARDS),
      cardsConcluidos: paraNumero(progresso?.CARDS_CONCLUIDOS),
    };
  }
}
