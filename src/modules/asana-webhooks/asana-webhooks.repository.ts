import { Injectable } from '@nestjs/common';
import { FirebirdService } from '../../database/firebird.service';
import { paraBooleano, paraDataOuNulo, truncar } from '../../common/utils';

export interface WebhookRegistrado {
  id: number;
  idConexao: number;
  idProjeto: number | null;
  asanaWebhookGid: string | null;
  recursoGid: string;
  tipoRecurso: string;
  urlDestino: string;
  segredoCifrado: Buffer | null;
  versaoChave: string | null;
  ativo: boolean;
  ultimoHeartbeatEm: Date | null;
}

@Injectable()
export class AsanaWebhooksRepository {
  constructor(private readonly db: FirebirdService) {}

  async criar(dados: {
    idConexao: number;
    idProjeto: number | null;
    recursoGid: string;
    tipoRecurso: string;
    urlDestino: string;
  }): Promise<number> {
    const linha = await this.db.escreverRetornando<{ ID_ASANA_WEBHOOK: number }>(
      `INSERT INTO ASANA_WEBHOOKS
         (ID_ASANA_CONEXAO, ID_ASANA_PROJETO, RECURSO_GID, TIPO_RECURSO, URL_DESTINO)
       VALUES (?, ?, ?, ?, ?)
       RETURNING ID_ASANA_WEBHOOK`,
      [dados.idConexao, dados.idProjeto, dados.recursoGid, dados.tipoRecurso, dados.urlDestino],
    );
    return Number(linha!.ID_ASANA_WEBHOOK);
  }

  async gravarSegredo(
    id: number,
    segredo: { conteudo: Buffer; nonceBase64: string; versaoChave: string },
  ): Promise<void> {
    await this.db.executar(
      `UPDATE ASANA_WEBHOOKS
          SET SEGREDO_CIFRADO = ?, SEGREDO_NONCE_BASE64 = ?, VERSAO_CHAVE = ?,
              ATUALIZADO_EM = CURRENT_TIMESTAMP
        WHERE ID_ASANA_WEBHOOK = ?`,
      [segredo.conteudo, segredo.nonceBase64, segredo.versaoChave, id],
    );
  }

  async vincularGid(id: number, gid: string): Promise<void> {
    await this.db.executar(
      'UPDATE ASANA_WEBHOOKS SET ASANA_WEBHOOK_GID = ? WHERE ID_ASANA_WEBHOOK = ?',
      [gid, id],
    );
  }

  async porGid(gid: string): Promise<WebhookRegistrado | null> {
    return this.buscar('ASANA_WEBHOOK_GID = ?', [gid]);
  }

  async porId(id: number): Promise<WebhookRegistrado | null> {
    return this.buscar('ID_ASANA_WEBHOOK = ?', [id]);
  }

  /** Handshake: o webhook ainda nao tem GID, so o recurso e a URL. */
  async pendenteDeHandshake(recursoGid: string): Promise<WebhookRegistrado | null> {
    return this.buscar('RECURSO_GID = ? AND ASANA_WEBHOOK_GID IS NULL', [recursoGid]);
  }

  private async buscar(where: string, parametros: unknown[]): Promise<WebhookRegistrado | null> {
    const l = await this.db.queryUm(
      `SELECT ID_ASANA_WEBHOOK, ID_ASANA_CONEXAO, ID_ASANA_PROJETO, ASANA_WEBHOOK_GID,
              RECURSO_GID, TIPO_RECURSO, URL_DESTINO, SEGREDO_CIFRADO, VERSAO_CHAVE,
              ATIVO, ULTIMO_HEARTBEAT_EM
         FROM ASANA_WEBHOOKS WHERE ${where}
        ORDER BY ID_ASANA_WEBHOOK DESC
        FETCH FIRST 1 ROWS ONLY`,
      parametros as never[],
    );
    if (!l) return null;
    return {
      id: Number(l.ID_ASANA_WEBHOOK),
      idConexao: Number(l.ID_ASANA_CONEXAO),
      idProjeto: l.ID_ASANA_PROJETO ? Number(l.ID_ASANA_PROJETO) : null,
      asanaWebhookGid: (l.ASANA_WEBHOOK_GID as string) ?? null,
      recursoGid: String(l.RECURSO_GID),
      tipoRecurso: String(l.TIPO_RECURSO),
      urlDestino: String(l.URL_DESTINO),
      segredoCifrado: comoBuffer(l.SEGREDO_CIFRADO),
      versaoChave: (l.VERSAO_CHAVE as string) ?? null,
      ativo: paraBooleano(l.ATIVO),
      ultimoHeartbeatEm: paraDataOuNulo(l.ULTIMO_HEARTBEAT_EM),
    };
  }

  async listar(): Promise<WebhookRegistrado[]> {
    const linhas = await this.db.query(
      'SELECT ID_ASANA_WEBHOOK FROM ASANA_WEBHOOKS ORDER BY ID_ASANA_WEBHOOK DESC',
    );
    const itens: WebhookRegistrado[] = [];
    for (const l of linhas) {
      const item = await this.porId(Number(l.ID_ASANA_WEBHOOK));
      if (item) itens.push(item);
    }
    return itens;
  }

  async registrarHeartbeat(id: number): Promise<void> {
    await this.db.executar(
      'UPDATE ASANA_WEBHOOKS SET ULTIMO_HEARTBEAT_EM = CURRENT_TIMESTAMP WHERE ID_ASANA_WEBHOOK = ?',
      [id],
    );
  }

  async desativar(id: number): Promise<void> {
    await this.db.executar('UPDATE ASANA_WEBHOOKS SET ATIVO = FALSE WHERE ID_ASANA_WEBHOOK = ?', [
      id,
    ]);
  }

  async remover(id: number): Promise<void> {
    await this.db.executar('DELETE FROM ASANA_WEBHOOKS WHERE ID_ASANA_WEBHOOK = ?', [id]);
  }

  // ---------------------------------------------------------------- eventos

  /**
   * Grava o evento. A UNIQUE de CHAVE_DEDUPLICACAO faz a deduplicacao: o
   * Asana reenvia o mesmo evento quando nao recebe 200 a tempo.
   */
  async registrarEvento(dados: {
    idWebhook: number | null;
    chaveDeduplicacao: string;
    recursoGid: string | null;
    tipoRecurso: string | null;
    acao: string | null;
    campoAlterado: string | null;
    payload: unknown;
  }): Promise<number | null> {
    try {
      const linha = await this.db.escreverRetornando<{ ID_WEBHOOK_EVENTO: number }>(
        `INSERT INTO ASANA_WEBHOOK_EVENTOS
           (ID_ASANA_WEBHOOK, CHAVE_DEDUPLICACAO, RECURSO_GID, TIPO_RECURSO, ACAO,
            CAMPO_ALTERADO, PAYLOAD_JSON)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING ID_WEBHOOK_EVENTO`,
        [
          dados.idWebhook,
          truncar(dados.chaveDeduplicacao, 128)!,
          truncar(dados.recursoGid, 64),
          truncar(dados.tipoRecurso, 30),
          truncar(dados.acao, 30),
          truncar(dados.campoAlterado, 100),
          JSON.stringify(dados.payload),
        ],
      );
      return Number(linha!.ID_WEBHOOK_EVENTO);
    } catch (erro) {
      // Violacao de UNIQUE = evento repetido, o que e esperado e benigno.
      if ((erro as Error).message?.includes('UK_EVENTO_DEDUP')) return null;
      throw erro;
    }
  }

  async eventosPendentes(limite: number) {
    const linhas = await this.db.query(
      `SELECT ID_WEBHOOK_EVENTO, RECURSO_GID, TIPO_RECURSO, ACAO, CAMPO_ALTERADO,
              PAYLOAD_JSON, TENTATIVAS, ID_ASANA_WEBHOOK
         FROM ASANA_WEBHOOK_EVENTOS
        WHERE SITUACAO = 'PENDENTE'
        ORDER BY RECEBIDO_EM
        FETCH FIRST ? ROWS ONLY`,
      [limite],
    );
    return linhas.map((l) => ({
      id: Number(l.ID_WEBHOOK_EVENTO),
      recursoGid: (l.RECURSO_GID as string) ?? null,
      tipoRecurso: (l.TIPO_RECURSO as string) ?? null,
      acao: (l.ACAO as string) ?? null,
      campoAlterado: (l.CAMPO_ALTERADO as string) ?? null,
      payload: l.PAYLOAD_JSON as string,
      tentativas: Number(l.TENTATIVAS ?? 0),
      idWebhook: l.ID_ASANA_WEBHOOK ? Number(l.ID_ASANA_WEBHOOK) : null,
    }));
  }

  async marcarEvento(
    id: number,
    situacao: 'PROCESSADO' | 'IGNORADO' | 'ERRO',
    erro?: string,
  ): Promise<void> {
    await this.db.executar(
      `UPDATE ASANA_WEBHOOK_EVENTOS
          SET SITUACAO = ?, PROCESSADO_EM = CURRENT_TIMESTAMP,
              TENTATIVAS = TENTATIVAS + 1, ULTIMO_ERRO = ?
        WHERE ID_WEBHOOK_EVENTO = ?`,
      [situacao, erro?.slice(0, 4000) ?? null, id],
    );
  }
}

function comoBuffer(valor: unknown): Buffer | null {
  if (!valor) return null;
  if (Buffer.isBuffer(valor)) return valor;
  return Buffer.from(String(valor), 'binary');
}
