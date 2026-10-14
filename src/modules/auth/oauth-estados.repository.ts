import { Injectable } from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import { FirebirdService } from '../../database/firebird.service';
import { deJson, paraJson } from '../../common/utils';

export type ProvedorOAuth = 'GOOGLE' | 'ASANA';

export interface EstadoOAuth {
  id: number;
  provedor: ProvedorOAuth;
  estado: string;
  codeVerifier: string | null;
  idUsuario: number | null;
  redirecionarPara: string | null;
  dados: Record<string, unknown> | null;
}

/**
 * Guarda state e code_verifier (PKCE) dos fluxos OAuth no banco, e nao em
 * memoria: assim o callback pode cair em qualquer instancia da API e o
 * estado sobrevive a um restart no meio do login.
 *
 * Cada estado e de uso unico e vive poucos minutos.
 */
@Injectable()
export class OAuthEstadosRepository {
  private static readonly VALIDADE_MINUTOS = 10;

  constructor(private readonly db: FirebirdService) {}

  async criar(dados: {
    provedor: ProvedorOAuth;
    idUsuario?: number | null;
    redirecionarPara?: string | null;
    dados?: Record<string, unknown> | null;
  }): Promise<{ estado: string; codeVerifier: string; codeChallenge: string }> {
    const estado = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(48).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

    const expira = new Date(Date.now() + OAuthEstadosRepository.VALIDADE_MINUTOS * 60_000);

    await this.db.executar(
      `INSERT INTO OAUTH_ESTADOS
         (PROVEDOR, ESTADO, CODE_VERIFIER, ID_USUARIO, REDIRECIONAR_PARA, DADOS_JSON, EXPIRA_EM)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        dados.provedor,
        estado,
        codeVerifier,
        dados.idUsuario ?? null,
        dados.redirecionarPara ?? null,
        paraJson(dados.dados ?? null),
        expira,
      ],
    );

    return { estado, codeVerifier, codeChallenge };
  }

  /**
   * Consome o estado. O UPDATE condicional garante que duas requisicoes
   * simultaneas com o mesmo state nao passem as duas (replay).
   */
  async consumir(provedor: ProvedorOAuth, estado: string): Promise<EstadoOAuth | null> {
    return this.db.transacao(async (tx) => {
      const linha = await tx.queryUm(
        `SELECT ID_OAUTH_ESTADO, PROVEDOR, ESTADO, CODE_VERIFIER, ID_USUARIO,
                REDIRECIONAR_PARA, DADOS_JSON
           FROM OAUTH_ESTADOS
          WHERE ESTADO = ? AND PROVEDOR = ?
            AND CONSUMIDO_EM IS NULL
            AND EXPIRA_EM > CURRENT_TIMESTAMP`,
        [estado, provedor],
      );
      if (!linha) return null;

      await tx.executar(
        `UPDATE OAUTH_ESTADOS SET CONSUMIDO_EM = CURRENT_TIMESTAMP
          WHERE ID_OAUTH_ESTADO = ? AND CONSUMIDO_EM IS NULL`,
        [Number(linha.ID_OAUTH_ESTADO)],
      );

      return {
        id: Number(linha.ID_OAUTH_ESTADO),
        provedor: String(linha.PROVEDOR) as ProvedorOAuth,
        estado: String(linha.ESTADO),
        codeVerifier: (linha.CODE_VERIFIER as string) ?? null,
        idUsuario: linha.ID_USUARIO ? Number(linha.ID_USUARIO) : null,
        redirecionarPara: (linha.REDIRECIONAR_PARA as string) ?? null,
        dados: deJson<Record<string, unknown>>(linha.DADOS_JSON),
      };
    });
  }

  /** Limpeza periodica: estados expirados nao servem para nada. */
  async limparExpirados(): Promise<number> {
    const linha = await this.db.queryUm<{ TOTAL: number }>(
      'SELECT COUNT(*) AS TOTAL FROM OAUTH_ESTADOS WHERE EXPIRA_EM < CURRENT_TIMESTAMP',
    );
    await this.db.executar('DELETE FROM OAUTH_ESTADOS WHERE EXPIRA_EM < CURRENT_TIMESTAMP');
    return Number(linha?.TOTAL ?? 0);
  }
}
