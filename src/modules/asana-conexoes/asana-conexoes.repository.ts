import { Injectable } from '@nestjs/common';
import { FirebirdService } from '../../database/firebird.service';
import { Linha } from '../../database/drivers/driver.interface';
import { paraBooleano, paraDataOuNulo, truncar } from '../../common/utils';
import { ConexaoAsanaDto, TipoAutenticacaoAsana } from './asana-conexoes.dto';

/** Registro completo, com os envelopes cifrados. Nunca sai pela API. */
export interface ConexaoAsanaInterna extends ConexaoAsanaDto {
  accessTokenCifrado: Buffer | null;
  refreshTokenCifrado: Buffer | null;
  versaoChave: string | null;
  escopoOAuth: string | null;
}

const COLUNAS = `
  ID_ASANA_CONEXAO, ID_USUARIO, NOME, TIPO_AUTENTICACAO, ASANA_USUARIO_GID,
  ASANA_USUARIO_NOME, ASANA_USUARIO_EMAIL, ACCESS_TOKEN_CIFRADO, REFRESH_TOKEN_CIFRADO,
  VERSAO_CHAVE, ESCOPO_OAUTH, TOKEN_EXPIRA_EM, PADRAO, ATIVO,
  ULTIMA_SINCRONIZACAO_EM, ULTIMO_ERRO, CRIADO_EM
`;

function mapear(linha: Linha): ConexaoAsanaInterna {
  return {
    id: Number(linha.ID_ASANA_CONEXAO),
    idUsuario: Number(linha.ID_USUARIO),
    nome: String(linha.NOME),
    tipoAutenticacao: String(linha.TIPO_AUTENTICACAO) as TipoAutenticacaoAsana,
    asanaUsuarioGid: (linha.ASANA_USUARIO_GID as string) ?? null,
    asanaUsuarioNome: (linha.ASANA_USUARIO_NOME as string) ?? null,
    asanaUsuarioEmail: (linha.ASANA_USUARIO_EMAIL as string) ?? null,
    accessTokenCifrado: comoBuffer(linha.ACCESS_TOKEN_CIFRADO),
    refreshTokenCifrado: comoBuffer(linha.REFRESH_TOKEN_CIFRADO),
    versaoChave: (linha.VERSAO_CHAVE as string) ?? null,
    escopoOAuth: (linha.ESCOPO_OAUTH as string) ?? null,
    tokenExpiraEm: paraDataOuNulo(linha.TOKEN_EXPIRA_EM),
    padrao: paraBooleano(linha.PADRAO),
    ativo: paraBooleano(linha.ATIVO),
    ultimaSincronizacaoEm: paraDataOuNulo(linha.ULTIMA_SINCRONIZACAO_EM),
    ultimoErro: (linha.ULTIMO_ERRO as string) ?? null,
    criadoEm: paraDataOuNulo(linha.CRIADO_EM) as Date,
  };
}

/** O driver pode devolver BLOB binario ja como Buffer ou como string. */
function comoBuffer(valor: unknown): Buffer | null {
  if (!valor) return null;
  if (Buffer.isBuffer(valor)) return valor;
  return Buffer.from(String(valor), 'binary');
}

/** Versao segura para a API: sem envelopes nem escopo interno. */
export function semCredenciais(conexao: ConexaoAsanaInterna): ConexaoAsanaDto {
  const {
    accessTokenCifrado: _a,
    refreshTokenCifrado: _r,
    versaoChave: _v,
    escopoOAuth: _e,
    ...publico
  } = conexao;
  return publico;
}

@Injectable()
export class AsanaConexoesRepository {
  constructor(private readonly db: FirebirdService) {}

  async porId(id: number): Promise<ConexaoAsanaInterna | null> {
    const linha = await this.db.queryUm(
      `SELECT ${COLUNAS} FROM ASANA_CONEXOES WHERE ID_ASANA_CONEXAO = ?`,
      [id],
    );
    return linha ? mapear(linha) : null;
  }

  async listarDoUsuario(idUsuario: number): Promise<ConexaoAsanaInterna[]> {
    const linhas = await this.db.query(
      `SELECT ${COLUNAS} FROM ASANA_CONEXOES
        WHERE ID_USUARIO = ? ORDER BY PADRAO DESC, NOME`,
      [idUsuario],
    );
    return linhas.map(mapear);
  }

  /** Conexoes ativas de todos os usuarios, as ha mais tempo sem sincronizar primeiro. */
  async listarAtivas(): Promise<ConexaoAsanaInterna[]> {
    const linhas = await this.db.query(
      `SELECT ${COLUNAS} FROM ASANA_CONEXOES
        WHERE ATIVO = TRUE
        ORDER BY ULTIMA_SINCRONIZACAO_EM NULLS FIRST, PADRAO DESC, ID_ASANA_CONEXAO`,
    );
    return linhas.map(mapear);
  }

  async padraoDoUsuario(idUsuario: number): Promise<ConexaoAsanaInterna | null> {
    const linha = await this.db.queryUm(
      `SELECT ${COLUNAS} FROM ASANA_CONEXOES
        WHERE ID_USUARIO = ? AND ATIVO = TRUE
        ORDER BY PADRAO DESC, ID_ASANA_CONEXAO
        FETCH FIRST 1 ROWS ONLY`,
      [idUsuario],
    );
    return linha ? mapear(linha) : null;
  }

  async criar(dados: {
    idUsuario: number;
    nome: string;
    tipo: TipoAutenticacaoAsana;
    accessTokenCifrado: Buffer;
    nonceAccess: string;
    refreshTokenCifrado?: Buffer | null;
    nonceRefresh?: string | null;
    versaoChave: string;
    escopo?: string | null;
    expiraEm?: Date | null;
    clientId?: string | null;
    usuarioGid?: string | null;
    usuarioNome?: string | null;
    usuarioEmail?: string | null;
  }): Promise<number> {
    return this.db.transacao(async (tx) => {
      const jaTem = await tx.queryUm<{ TOTAL: number }>(
        'SELECT COUNT(*) AS TOTAL FROM ASANA_CONEXOES WHERE ID_USUARIO = ?',
        [dados.idUsuario],
      );
      const primeira = Number(jaTem?.TOTAL ?? 0) === 0;

      const linha = await tx.queryUm<{ ID_ASANA_CONEXAO: number }>(
        `INSERT INTO ASANA_CONEXOES
           (ID_USUARIO, NOME, TIPO_AUTENTICACAO, ASANA_USUARIO_GID, ASANA_USUARIO_NOME,
            ASANA_USUARIO_EMAIL, OAUTH_CLIENT_ID, ACCESS_TOKEN_CIFRADO, REFRESH_TOKEN_CIFRADO,
            TOKEN_NONCE_BASE64, REFRESH_NONCE_BASE64, VERSAO_CHAVE, ESCOPO_OAUTH,
            TOKEN_EXPIRA_EM, PADRAO)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING ID_ASANA_CONEXAO`,
        [
          dados.idUsuario,
          dados.nome,
          dados.tipo,
          dados.usuarioGid ?? null,
          truncar(dados.usuarioNome ?? null, 150),
          truncar(dados.usuarioEmail ?? null, 254),
          dados.clientId ?? null,
          dados.accessTokenCifrado,
          dados.refreshTokenCifrado ?? null,
          dados.nonceAccess,
          dados.nonceRefresh ?? null,
          dados.versaoChave,
          truncar(dados.escopo ?? null, 1000),
          dados.expiraEm ?? null,
          primeira,
        ],
      );
      return Number(linha!.ID_ASANA_CONEXAO);
    });
  }

  async atualizarToken(
    id: number,
    dados: {
      accessTokenCifrado: Buffer;
      nonceAccess: string;
      refreshTokenCifrado?: Buffer | null;
      nonceRefresh?: string | null;
      versaoChave: string;
      expiraEm?: Date | null;
    },
  ): Promise<void> {
    await this.db.executar(
      `UPDATE ASANA_CONEXOES
          SET ACCESS_TOKEN_CIFRADO = ?, TOKEN_NONCE_BASE64 = ?,
              REFRESH_TOKEN_CIFRADO = COALESCE(?, REFRESH_TOKEN_CIFRADO),
              REFRESH_NONCE_BASE64 = COALESCE(?, REFRESH_NONCE_BASE64),
              VERSAO_CHAVE = ?, TOKEN_EXPIRA_EM = ?, ULTIMO_ERRO = NULL
        WHERE ID_ASANA_CONEXAO = ?`,
      [
        dados.accessTokenCifrado,
        dados.nonceAccess,
        dados.refreshTokenCifrado ?? null,
        dados.nonceRefresh ?? null,
        dados.versaoChave,
        dados.expiraEm ?? null,
        id,
      ],
    );
  }

  async atualizarIdentidade(
    id: number,
    dados: { gid: string; nome?: string | null; email?: string | null },
  ): Promise<void> {
    await this.db.executar(
      `UPDATE ASANA_CONEXOES
          SET ASANA_USUARIO_GID = ?, ASANA_USUARIO_NOME = ?, ASANA_USUARIO_EMAIL = ?,
              ULTIMA_SINCRONIZACAO_EM = CURRENT_TIMESTAMP
        WHERE ID_ASANA_CONEXAO = ?`,
      [dados.gid, truncar(dados.nome ?? null, 150), truncar(dados.email ?? null, 254), id],
    );
  }

  async renomear(id: number, nome: string): Promise<void> {
    await this.db.executar('UPDATE ASANA_CONEXOES SET NOME = ? WHERE ID_ASANA_CONEXAO = ?', [
      nome,
      id,
    ]);
  }

  async definirPadrao(idUsuario: number, id: number): Promise<void> {
    await this.db.transacao(async (tx) => {
      await tx.executar('UPDATE ASANA_CONEXOES SET PADRAO = FALSE WHERE ID_USUARIO = ?', [
        idUsuario,
      ]);
      await tx.executar(
        'UPDATE ASANA_CONEXOES SET PADRAO = TRUE WHERE ID_ASANA_CONEXAO = ? AND ID_USUARIO = ?',
        [id, idUsuario],
      );
    });
  }

  async desativar(id: number): Promise<void> {
    await this.db.executar(
      'UPDATE ASANA_CONEXOES SET ATIVO = FALSE, PADRAO = FALSE WHERE ID_ASANA_CONEXAO = ?',
      [id],
    );
  }

  async registrarErro(id: number, erro: string): Promise<void> {
    await this.db.executar('UPDATE ASANA_CONEXOES SET ULTIMO_ERRO = ? WHERE ID_ASANA_CONEXAO = ?', [
      erro.slice(0, 4000),
      id,
    ]);
  }

  async marcarSincronizada(id: number): Promise<void> {
    await this.db.executar(
      'UPDATE ASANA_CONEXOES SET ULTIMA_SINCRONIZACAO_EM = CURRENT_TIMESTAMP WHERE ID_ASANA_CONEXAO = ?',
      [id],
    );
  }

  /** Um roadmap so pode ser excluido junto; aqui checamos antes de desativar. */
  async contarRoadmapsAtivos(idConexao: number): Promise<number> {
    const linha = await this.db.queryUm<{ TOTAL: number }>(
      'SELECT COUNT(*) AS TOTAL FROM ROADMAPS WHERE ID_ASANA_CONEXAO = ? AND EXCLUIDO_EM IS NULL',
      [idConexao],
    );
    return Number(linha?.TOTAL ?? 0);
  }
}
