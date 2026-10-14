import { Injectable } from '@nestjs/common';
import { FirebirdService } from '../../database/firebird.service';
import { truncar } from '../../common/utils';

export interface SessaoAuth {
  id: number;
  idUsuario: number;
  expiraEm: Date;
}

/**
 * Refresh tokens. Guardamos apenas o SHA-256 do token: um vazamento do banco
 * nao permite reconstruir a sessao de ninguem.
 */
@Injectable()
export class AuthSessoesRepository {
  constructor(private readonly db: FirebirdService) {}

  async criar(dados: {
    idUsuario: number;
    tokenHash: string;
    expiraEm: Date;
    userAgent?: string | null;
    ip?: string | null;
  }): Promise<void> {
    await this.db.executar(
      `INSERT INTO AUTH_SESSOES (ID_USUARIO, TOKEN_HASH, EXPIRA_EM, USER_AGENT, IP_ORIGEM)
       VALUES (?, ?, ?, ?, ?)`,
      [
        dados.idUsuario,
        dados.tokenHash,
        dados.expiraEm,
        truncar(dados.userAgent ?? null, 500),
        truncar(dados.ip ?? null, 64),
      ],
    );
  }

  async porHash(tokenHash: string): Promise<SessaoAuth | null> {
    const linha = await this.db.queryUm(
      `SELECT ID_AUTH_SESSAO, ID_USUARIO, EXPIRA_EM
         FROM AUTH_SESSOES
        WHERE TOKEN_HASH = ? AND REVOGADO_EM IS NULL AND EXPIRA_EM > CURRENT_TIMESTAMP`,
      [tokenHash],
    );
    if (!linha) return null;
    return {
      id: Number(linha.ID_AUTH_SESSAO),
      idUsuario: Number(linha.ID_USUARIO),
      expiraEm: new Date(String(linha.EXPIRA_EM)),
    };
  }

  async revogar(tokenHash: string): Promise<void> {
    await this.db.executar(
      `UPDATE AUTH_SESSOES SET REVOGADO_EM = CURRENT_TIMESTAMP
        WHERE TOKEN_HASH = ? AND REVOGADO_EM IS NULL`,
      [tokenHash],
    );
  }

  async revogarTodasDoUsuario(idUsuario: number): Promise<void> {
    await this.db.executar(
      `UPDATE AUTH_SESSOES SET REVOGADO_EM = CURRENT_TIMESTAMP
        WHERE ID_USUARIO = ? AND REVOGADO_EM IS NULL`,
      [idUsuario],
    );
  }

  async limparExpiradas(): Promise<void> {
    await this.db.executar(
      `DELETE FROM AUTH_SESSOES
        WHERE EXPIRA_EM < DATEADD(-7 DAY TO CURRENT_TIMESTAMP)`,
    );
  }
}
