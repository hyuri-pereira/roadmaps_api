import { Injectable } from '@nestjs/common';
import { FirebirdService } from '../../database/firebird.service';
import { paraBooleano, paraDataOuNulo, truncar } from '../../common/utils';

export interface ServidorWaha {
  id: number;
  nome: string;
  baseUrl: string;
  apiKeyCifrada: Buffer;
  webhookSecretCifrado: Buffer | null;
  versaoChave: string;
  ativo: boolean;
}

export interface SessaoWaha {
  id: number;
  idUsuario: number;
  idServidor: number;
  nomeSessao: string;
  situacao: string;
  numeroConectado: string | null;
  chatIdProprio: string | null;
  conectadoEm: Date | null;
  ultimoErro: string | null;
}

@Injectable()
export class WahaRepository {
  constructor(private readonly db: FirebirdService) {}

  // ------------------------------------------------------------ servidores

  async servidorAtivo(): Promise<ServidorWaha | null> {
    const l = await this.db.queryUm(
      `SELECT ID_WAHA_SERVIDOR, NOME, BASE_URL, API_KEY_CIFRADA, WEBHOOK_SECRET_CIFRADO,
              VERSAO_CHAVE, ATIVO
         FROM WAHA_SERVIDORES WHERE ATIVO = TRUE
        ORDER BY ID_WAHA_SERVIDOR FETCH FIRST 1 ROWS ONLY`,
    );
    return l ? mapearServidor(l) : null;
  }

  async servidorPorId(id: number): Promise<ServidorWaha | null> {
    const l = await this.db.queryUm(
      `SELECT ID_WAHA_SERVIDOR, NOME, BASE_URL, API_KEY_CIFRADA, WEBHOOK_SECRET_CIFRADO,
              VERSAO_CHAVE, ATIVO
         FROM WAHA_SERVIDORES WHERE ID_WAHA_SERVIDOR = ?`,
      [id],
    );
    return l ? mapearServidor(l) : null;
  }

  async salvarServidor(dados: {
    nome: string;
    baseUrl: string;
    apiKeyCifrada: Buffer;
    apiKeyNonce: string;
    webhookSecretCifrado?: Buffer | null;
    webhookNonce?: string | null;
    versaoChave: string;
  }): Promise<number> {
    const linha = await this.db.escreverRetornando<{ ID_WAHA_SERVIDOR: number }>(
      `UPDATE OR INSERT INTO WAHA_SERVIDORES
         (NOME, BASE_URL, API_KEY_CIFRADA, API_KEY_NONCE_BASE64, WEBHOOK_SECRET_CIFRADO,
          WEBHOOK_NONCE_BASE64, VERSAO_CHAVE, ATIVO)
       VALUES (?, ?, ?, ?, ?, ?, ?, TRUE)
       MATCHING (NOME)
       RETURNING ID_WAHA_SERVIDOR`,
      [
        dados.nome,
        dados.baseUrl,
        dados.apiKeyCifrada,
        dados.apiKeyNonce,
        dados.webhookSecretCifrado ?? null,
        dados.webhookNonce ?? null,
        dados.versaoChave,
      ],
    );
    return Number(linha!.ID_WAHA_SERVIDOR);
  }

  // --------------------------------------------------------------- sessoes

  async sessaoDoUsuario(idUsuario: number): Promise<SessaoWaha | null> {
    const l = await this.db.queryUm(
      `SELECT ID_WAHA_SESSAO, ID_USUARIO, ID_WAHA_SERVIDOR, NOME_SESSAO, SITUACAO,
              NUMERO_CONECTADO_E164, CHAT_ID_PROPRIO, CONECTADO_EM, ULTIMO_ERRO
         FROM WAHA_SESSOES WHERE ID_USUARIO = ?`,
      [idUsuario],
    );
    return l ? mapearSessao(l) : null;
  }

  async criarSessao(dados: {
    idUsuario: number;
    idServidor: number;
    nomeSessao: string;
  }): Promise<number> {
    const linha = await this.db.escreverRetornando<{ ID_WAHA_SESSAO: number }>(
      `INSERT INTO WAHA_SESSOES (ID_USUARIO, ID_WAHA_SERVIDOR, NOME_SESSAO)
       VALUES (?, ?, ?)
       RETURNING ID_WAHA_SESSAO`,
      [dados.idUsuario, dados.idServidor, dados.nomeSessao],
    );
    return Number(linha!.ID_WAHA_SESSAO);
  }

  async atualizarSessao(
    id: number,
    dados: {
      situacao: string;
      numeroConectado?: string | null;
      chatIdProprio?: string | null;
      conectadoEm?: Date | null;
      ultimoErro?: string | null;
    },
  ): Promise<void> {
    await this.db.executar(
      `UPDATE WAHA_SESSOES
          SET SITUACAO = ?, NUMERO_CONECTADO_E164 = ?, CHAT_ID_PROPRIO = ?,
              CONECTADO_EM = ?, ULTIMO_ERRO = ?, ATUALIZADO_EM = CURRENT_TIMESTAMP
        WHERE ID_WAHA_SESSAO = ?`,
      [
        truncar(dados.situacao, 30)!,
        truncar(dados.numeroConectado ?? null, 20),
        truncar(dados.chatIdProprio ?? null, 150),
        dados.conectadoEm ?? null,
        dados.ultimoErro?.slice(0, 4000) ?? null,
        id,
      ],
    );
  }

  async removerSessao(id: number): Promise<void> {
    // A fila de notificacoes referencia a sessao; cancelamos o que estiver
    // pendente antes de apagar, para nao deixar registro orfao.
    await this.db.transacao(async (tx) => {
      await tx.executar(
        `UPDATE NOTIFICACAO_FILA
            SET SITUACAO = 'CANCELADO', ULTIMO_ERRO = 'Sessao WhatsApp removida'
          WHERE ID_WAHA_SESSAO = ? AND SITUACAO IN ('PENDENTE', 'PROCESSANDO')`,
        [id],
      );
      await tx.executar('UPDATE NOTIFICACAO_FILA SET ID_WAHA_SESSAO = NULL WHERE ID_WAHA_SESSAO = ?', [
        id,
      ]);
      await tx.executar('DELETE FROM WAHA_SESSOES WHERE ID_WAHA_SESSAO = ?', [id]);
    });
  }

  async sessaoPorNome(nome: string): Promise<SessaoWaha | null> {
    const l = await this.db.queryUm(
      `SELECT ID_WAHA_SESSAO, ID_USUARIO, ID_WAHA_SERVIDOR, NOME_SESSAO, SITUACAO,
              NUMERO_CONECTADO_E164, CHAT_ID_PROPRIO, CONECTADO_EM, ULTIMO_ERRO
         FROM WAHA_SESSOES WHERE NOME_SESSAO = ?`,
      [nome],
    );
    return l ? mapearSessao(l) : null;
  }

  async sessaoPorId(id: number): Promise<SessaoWaha | null> {
    const l = await this.db.queryUm(
      `SELECT ID_WAHA_SESSAO, ID_USUARIO, ID_WAHA_SERVIDOR, NOME_SESSAO, SITUACAO,
              NUMERO_CONECTADO_E164, CHAT_ID_PROPRIO, CONECTADO_EM, ULTIMO_ERRO
         FROM WAHA_SESSOES WHERE ID_WAHA_SESSAO = ?`,
      [id],
    );
    return l ? mapearSessao(l) : null;
  }
}

function mapearServidor(l: Record<string, unknown>): ServidorWaha {
  return {
    id: Number(l.ID_WAHA_SERVIDOR),
    nome: String(l.NOME),
    baseUrl: String(l.BASE_URL),
    apiKeyCifrada: comoBuffer(l.API_KEY_CIFRADA)!,
    webhookSecretCifrado: comoBuffer(l.WEBHOOK_SECRET_CIFRADO),
    versaoChave: String(l.VERSAO_CHAVE),
    ativo: paraBooleano(l.ATIVO),
  };
}

function mapearSessao(l: Record<string, unknown>): SessaoWaha {
  return {
    id: Number(l.ID_WAHA_SESSAO),
    idUsuario: Number(l.ID_USUARIO),
    idServidor: Number(l.ID_WAHA_SERVIDOR),
    nomeSessao: String(l.NOME_SESSAO),
    situacao: String(l.SITUACAO),
    numeroConectado: (l.NUMERO_CONECTADO_E164 as string) ?? null,
    chatIdProprio: (l.CHAT_ID_PROPRIO as string) ?? null,
    conectadoEm: paraDataOuNulo(l.CONECTADO_EM),
    ultimoErro: (l.ULTIMO_ERRO as string) ?? null,
  };
}

function comoBuffer(valor: unknown): Buffer | null {
  if (!valor) return null;
  if (Buffer.isBuffer(valor)) return valor;
  return Buffer.from(String(valor), 'binary');
}
