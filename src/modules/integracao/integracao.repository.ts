import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { FirebirdService } from '../../database/firebird.service';
import { Linha } from '../../database/drivers/driver.interface';
import { paraDataOuNulo, paraJson, paraNumero } from '../../common/utils';
import {
  FiltroFilaDto,
  JobFilaDto,
  LogIntegracaoDto,
  ResumoFilaDto,
  SituacaoFila,
  TipoOperacao,
} from './integracao.dto';

export interface JobReivindicado extends JobFilaDto {
  lockToken: string;
  payload: Record<string, unknown> | null;
}

const COLUNAS = `
  ID_INTEGRACAO_FILA, ID_ASANA_CONEXAO, TIPO_OPERACAO, TIPO_ENTIDADE_LOCAL,
  ID_ENTIDADE_LOCAL, RECURSO_GID, CHAVE_IDEMPOTENCIA, PAYLOAD_JSON, SITUACAO,
  PRIORIDADE_FILA, TENTATIVAS, PROXIMA_TENTATIVA_EM, LOCK_TOKEN, BLOQUEADO_ATE,
  BLOQUEADO_POR, ULTIMO_ERRO, CRIADO_EM, PROCESSADO_EM
`;

function mapear(l: Linha): JobFilaDto {
  return {
    id: Number(l.ID_INTEGRACAO_FILA),
    idAsanaConexao: l.ID_ASANA_CONEXAO ? Number(l.ID_ASANA_CONEXAO) : null,
    // trim: valores vindos de IIF em procedure podem chegar completados com espacos.
    tipoOperacao: String(l.TIPO_OPERACAO).trim() as TipoOperacao,
    tipoEntidadeLocal: String(l.TIPO_ENTIDADE_LOCAL),
    idEntidadeLocal: l.ID_ENTIDADE_LOCAL ? Number(l.ID_ENTIDADE_LOCAL) : null,
    recursoGid: (l.RECURSO_GID as string) ?? null,
    chaveIdempotencia: String(l.CHAVE_IDEMPOTENCIA),
    situacao: String(l.SITUACAO) as SituacaoFila,
    prioridadeFila: paraNumero(l.PRIORIDADE_FILA),
    tentativas: paraNumero(l.TENTATIVAS),
    proximaTentativaEm: paraDataOuNulo(l.PROXIMA_TENTATIVA_EM) as Date,
    bloqueadoAte: paraDataOuNulo(l.BLOQUEADO_ATE),
    bloqueadoPor: (l.BLOQUEADO_POR as string) ?? null,
    ultimoErro: (l.ULTIMO_ERRO as string) ?? null,
    criadoEm: paraDataOuNulo(l.CRIADO_EM) as Date,
    processadoEm: paraDataOuNulo(l.PROCESSADO_EM),
  };
}

@Injectable()
export class IntegracaoRepository {
  constructor(private readonly db: FirebirdService) {}

  /**
   * Reivindica jobs para este worker.
   *
   * Regras do contrato aplicadas aqui:
   *  - transacao curta: so marca PROCESSANDO com lease e faz commit; o HTTP
   *    acontece fora, depois;
   *  - um job por entidade por rodada, o que garante que CRIAR_TAREFA (id
   *    menor, enfileirado antes) sempre rode antes de ATUALIZAR ou EXCLUIR
   *    do mesmo card;
   *  - lease com token unico: na hora de confirmar, o worker so grava se
   *    ainda for o dono.
   */
  async reivindicar(
    workerId: string,
    lote: number,
    leaseSegundos: number,
  ): Promise<JobReivindicado[]> {
    // Candidatos: pendentes no prazo, ou presos com lease expirada.
    const candidatos = await this.db.query(
      `SELECT ${COLUNAS} FROM INTEGRACAO_FILA
        WHERE (SITUACAO = 'PENDENTE' AND PROXIMA_TENTATIVA_EM <= CURRENT_TIMESTAMP)
           OR (SITUACAO = 'PROCESSANDO' AND BLOQUEADO_ATE < CURRENT_TIMESTAMP)
        ORDER BY PRIORIDADE_FILA, ID_INTEGRACAO_FILA
        FETCH FIRST ? ROWS ONLY`,
      [lote * 4],
    );

    const porEntidade = new Set<string>();
    const selecionados: Linha[] = [];
    for (const linha of candidatos) {
      const chave = `${linha.TIPO_ENTIDADE_LOCAL}:${linha.ID_ENTIDADE_LOCAL ?? 0}`;
      if (porEntidade.has(chave)) continue;
      porEntidade.add(chave);
      selecionados.push(linha);
      if (selecionados.length >= lote) break;
    }

    const reivindicados: JobReivindicado[] = [];
    for (const linha of selecionados) {
      const token = randomUUID();
      const id = Number(linha.ID_INTEGRACAO_FILA);

      const ok = await this.db.transacao(async (tx) => {
        // O WHERE repete a condicao de elegibilidade: se outro worker pegou
        // o job entre o SELECT e agora, este UPDATE nao afeta nada.
        const atualizado = await tx.queryUm<{ ID_INTEGRACAO_FILA: number }>(
          `UPDATE INTEGRACAO_FILA
              SET SITUACAO = 'PROCESSANDO',
                  LOCK_TOKEN = ?,
                  BLOQUEADO_POR = ?,
                  BLOQUEADO_ATE = DATEADD(? SECOND TO CURRENT_TIMESTAMP),
                  TENTATIVAS = TENTATIVAS + 1
            WHERE ID_INTEGRACAO_FILA = ?
              AND ((SITUACAO = 'PENDENTE' AND PROXIMA_TENTATIVA_EM <= CURRENT_TIMESTAMP)
                OR (SITUACAO = 'PROCESSANDO' AND BLOQUEADO_ATE < CURRENT_TIMESTAMP))
            RETURNING ID_INTEGRACAO_FILA`,
          [token, workerId.slice(0, 100), leaseSegundos, id],
        );
        return Boolean(atualizado?.ID_INTEGRACAO_FILA);
      });

      if (!ok) continue;

      reivindicados.push({
        ...mapear(linha),
        situacao: 'PROCESSANDO',
        tentativas: paraNumero(linha.TENTATIVAS) + 1,
        lockToken: token,
        payload: lerPayload(linha.PAYLOAD_JSON),
      });
    }

    return reivindicados;
  }

  /** Só grava se a lease ainda for deste worker. */
  async concluir(id: number, token: string, recursoGid?: string | null): Promise<boolean> {
    return this.db.transacao(async (tx) => {
      const linha = await tx.queryUm<{ ID_INTEGRACAO_FILA: number }>(
        `UPDATE INTEGRACAO_FILA
            SET SITUACAO = 'CONCLUIDO',
                PROCESSADO_EM = CURRENT_TIMESTAMP,
                RECURSO_GID = COALESCE(?, RECURSO_GID),
                LOCK_TOKEN = NULL,
                BLOQUEADO_ATE = NULL,
                ULTIMO_ERRO = NULL
          WHERE ID_INTEGRACAO_FILA = ? AND LOCK_TOKEN = ?
          RETURNING ID_INTEGRACAO_FILA`,
        [recursoGid ?? null, id, token],
      );
      return Boolean(linha?.ID_INTEGRACAO_FILA);
    });
  }

  async reagendar(
    id: number,
    token: string,
    segundos: number,
    erro: string,
  ): Promise<boolean> {
    return this.db.transacao(async (tx) => {
      const linha = await tx.queryUm<{ ID_INTEGRACAO_FILA: number }>(
        `UPDATE INTEGRACAO_FILA
            SET SITUACAO = 'PENDENTE',
                PROXIMA_TENTATIVA_EM = DATEADD(? SECOND TO CURRENT_TIMESTAMP),
                LOCK_TOKEN = NULL,
                BLOQUEADO_ATE = NULL,
                ULTIMO_ERRO = ?
          WHERE ID_INTEGRACAO_FILA = ? AND LOCK_TOKEN = ?
          RETURNING ID_INTEGRACAO_FILA`,
        [segundos, erro.slice(0, 4000), id, token],
      );
      return Boolean(linha?.ID_INTEGRACAO_FILA);
    });
  }

  async falhar(id: number, token: string, erro: string): Promise<boolean> {
    return this.db.transacao(async (tx) => {
      const linha = await tx.queryUm<{ ID_INTEGRACAO_FILA: number }>(
        `UPDATE INTEGRACAO_FILA
            SET SITUACAO = 'ERRO',
                PROCESSADO_EM = CURRENT_TIMESTAMP,
                LOCK_TOKEN = NULL,
                BLOQUEADO_ATE = NULL,
                ULTIMO_ERRO = ?
          WHERE ID_INTEGRACAO_FILA = ? AND LOCK_TOKEN = ?
          RETURNING ID_INTEGRACAO_FILA`,
        [erro.slice(0, 4000), id, token],
      );
      return Boolean(linha?.ID_INTEGRACAO_FILA);
    });
  }

  async cancelar(id: number, token: string, motivo: string): Promise<boolean> {
    return this.db.transacao(async (tx) => {
      const linha = await tx.queryUm<{ ID_INTEGRACAO_FILA: number }>(
        `UPDATE INTEGRACAO_FILA
            SET SITUACAO = 'CANCELADO',
                PROCESSADO_EM = CURRENT_TIMESTAMP,
                LOCK_TOKEN = NULL,
                BLOQUEADO_ATE = NULL,
                ULTIMO_ERRO = ?
          WHERE ID_INTEGRACAO_FILA = ? AND LOCK_TOKEN = ?
          RETURNING ID_INTEGRACAO_FILA`,
        [motivo.slice(0, 4000), id, token],
      );
      return Boolean(linha?.ID_INTEGRACAO_FILA);
    });
  }

  async enfileirar(dados: {
    idConexao: number | null;
    tipoOperacao: TipoOperacao;
    tipoEntidade: string;
    idEntidade: number | null;
    recursoGid?: string | null;
    chave: string;
    payload?: Record<string, unknown> | null;
    prioridade?: number;
  }): Promise<void> {
    await this.db.transacao(async (tx) => {
      const existe = await tx.queryUm<{ TOTAL: number }>(
        'SELECT COUNT(*) AS TOTAL FROM INTEGRACAO_FILA WHERE CHAVE_IDEMPOTENCIA = ?',
        [dados.chave],
      );
      if (Number(existe?.TOTAL ?? 0) > 0) return;

      await tx.executar(
        `INSERT INTO INTEGRACAO_FILA
           (ID_ASANA_CONEXAO, TIPO_OPERACAO, TIPO_ENTIDADE_LOCAL, ID_ENTIDADE_LOCAL,
            RECURSO_GID, CHAVE_IDEMPOTENCIA, PAYLOAD_JSON, PRIORIDADE_FILA)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          dados.idConexao,
          dados.tipoOperacao,
          dados.tipoEntidade,
          dados.idEntidade,
          dados.recursoGid ?? null,
          dados.chave,
          paraJson(dados.payload ?? null),
          dados.prioridade ?? 5,
        ],
      );
    });
  }

  /** Existe criacao ainda nao concluida para este card? */
  async criacaoPendente(idCard: number): Promise<boolean> {
    const linha = await this.db.queryUm<{ TOTAL: number }>(
      `SELECT COUNT(*) AS TOTAL FROM INTEGRACAO_FILA
        WHERE CHAVE_IDEMPOTENCIA = ? AND SITUACAO IN ('PENDENTE', 'PROCESSANDO')`,
      [`CRIAR_TAREFA:${idCard}`],
    );
    return Number(linha?.TOTAL ?? 0) > 0;
  }

  // ----------------------------------------------------------------- logs

  async registrarLog(dados: {
    idJob?: number | null;
    nivel: 'DEBUG' | 'INFO' | 'ALERTA' | 'ERRO';
    codigoHttp?: number | null;
    mensagem: string;
    requisicao?: unknown;
    resposta?: unknown;
  }): Promise<void> {
    await this.db.executar(
      `INSERT INTO INTEGRACAO_LOGS
         (ID_INTEGRACAO_FILA, NIVEL, CODIGO_HTTP, MENSAGEM, REQUISICAO_JSON, RESPOSTA_JSON)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        dados.idJob ?? null,
        dados.nivel,
        dados.codigoHttp ?? null,
        dados.mensagem,
        paraJson(dados.requisicao),
        paraJson(dados.resposta),
      ],
    );
  }

  async listarLogs(idJob: number, limite = 50): Promise<LogIntegracaoDto[]> {
    const linhas = await this.db.query(
      `SELECT ID_INTEGRACAO_LOG, ID_INTEGRACAO_FILA, NIVEL, CODIGO_HTTP, MENSAGEM,
              REQUISICAO_JSON, RESPOSTA_JSON, CRIADO_EM
         FROM INTEGRACAO_LOGS
        WHERE ID_INTEGRACAO_FILA = ?
        ORDER BY CRIADO_EM DESC
        FETCH FIRST ? ROWS ONLY`,
      [idJob, limite],
    );
    return linhas.map((l) => ({
      id: Number(l.ID_INTEGRACAO_LOG),
      idIntegracaoFila: l.ID_INTEGRACAO_FILA ? Number(l.ID_INTEGRACAO_FILA) : null,
      nivel: String(l.NIVEL),
      codigoHttp: l.CODIGO_HTTP ? Number(l.CODIGO_HTTP) : null,
      mensagem: String(l.MENSAGEM),
      requisicao: (l.REQUISICAO_JSON as string) ?? null,
      resposta: (l.RESPOSTA_JSON as string) ?? null,
      criadoEm: paraDataOuNulo(l.CRIADO_EM) as Date,
    }));
  }

  // -------------------------------------------------------------- consulta

  async listar(filtro: FiltroFilaDto, offset: number, limite: number) {
    const condicoes: string[] = [];
    const parametros: unknown[] = [];

    if (filtro.situacao) {
      condicoes.push('SITUACAO = ?');
      parametros.push(filtro.situacao);
    }
    if (filtro.tipoOperacao) {
      condicoes.push('TIPO_OPERACAO = ?');
      parametros.push(filtro.tipoOperacao);
    }
    if (filtro.idEntidadeLocal) {
      condicoes.push('ID_ENTIDADE_LOCAL = ?');
      parametros.push(filtro.idEntidadeLocal);
    }

    const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
    const [linhas, total] = await Promise.all([
      this.db.query(
        `SELECT ${COLUNAS} FROM INTEGRACAO_FILA ${where}
          ORDER BY ID_INTEGRACAO_FILA DESC
          OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`,
        [...parametros, offset, limite] as never[],
      ),
      this.db.queryUm<{ TOTAL: number }>(
        `SELECT COUNT(*) AS TOTAL FROM INTEGRACAO_FILA ${where}`,
        parametros as never[],
      ),
    ]);

    return { itens: linhas.map(mapear), total: Number(total?.TOTAL ?? 0) };
  }

  async resumo(): Promise<ResumoFilaDto> {
    const linha = await this.db.queryUm(
      `SELECT
         SUM(CASE WHEN SITUACAO = 'PENDENTE' THEN 1 ELSE 0 END) AS PENDENTES,
         SUM(CASE WHEN SITUACAO = 'PROCESSANDO' THEN 1 ELSE 0 END) AS PROCESSANDO,
         SUM(CASE WHEN SITUACAO = 'ERRO' THEN 1 ELSE 0 END) AS COM_ERRO,
         SUM(CASE WHEN SITUACAO = 'CANCELADO' THEN 1 ELSE 0 END) AS CANCELADOS,
         SUM(CASE WHEN SITUACAO = 'CONCLUIDO'
                   AND PROCESSADO_EM > DATEADD(-1 HOUR TO CURRENT_TIMESTAMP)
                  THEN 1 ELSE 0 END) AS CONCLUIDOS_HORA,
         MIN(CASE WHEN SITUACAO = 'PENDENTE' THEN CRIADO_EM END) AS MAIS_ANTIGO
       FROM INTEGRACAO_FILA`,
    );
    return {
      pendentes: paraNumero(linha?.PENDENTES),
      processando: paraNumero(linha?.PROCESSANDO),
      comErro: paraNumero(linha?.COM_ERRO),
      cancelados: paraNumero(linha?.CANCELADOS),
      concluidosUltimaHora: paraNumero(linha?.CONCLUIDOS_HORA),
      maisAntigoPendenteEm: paraDataOuNulo(linha?.MAIS_ANTIGO),
    };
  }

  async reenfileirar(id: number): Promise<boolean> {
    return this.db.transacao(async (tx) => {
      const linha = await tx.queryUm<{ ID_INTEGRACAO_FILA: number }>(
        `UPDATE INTEGRACAO_FILA
            SET SITUACAO = 'PENDENTE', TENTATIVAS = 0,
                PROXIMA_TENTATIVA_EM = CURRENT_TIMESTAMP,
                LOCK_TOKEN = NULL, BLOQUEADO_ATE = NULL, BLOQUEADO_POR = NULL,
                PROCESSADO_EM = NULL
          WHERE ID_INTEGRACAO_FILA = ? AND SITUACAO IN ('ERRO', 'CANCELADO')
          RETURNING ID_INTEGRACAO_FILA`,
        [id],
      );
      return Boolean(linha?.ID_INTEGRACAO_FILA);
    });
  }

  async porId(id: number): Promise<JobFilaDto | null> {
    const linha = await this.db.queryUm(
      `SELECT ${COLUNAS} FROM INTEGRACAO_FILA WHERE ID_INTEGRACAO_FILA = ?`,
      [id],
    );
    return linha ? mapear(linha) : null;
  }
}

function lerPayload(valor: unknown): Record<string, unknown> | null {
  if (!valor) return null;
  try {
    return typeof valor === 'string'
      ? (JSON.parse(valor) as Record<string, unknown>)
      : (valor as Record<string, unknown>);
  } catch {
    return null;
  }
}
