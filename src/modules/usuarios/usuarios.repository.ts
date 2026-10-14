import { Injectable } from '@nestjs/common';
import { FirebirdService } from '../../database/firebird.service';
import { Linha, TransacaoFirebird } from '../../database/drivers/driver.interface';
import { Perfil } from '../../common/auth.types';
import { paraBooleano, paraDataOuNulo } from '../../common/utils';
import { UsuarioDto } from './usuarios.dto';

export interface UsuarioComSenha extends UsuarioDto {
  senhaHash: string | null;
  authSubject: string | null;
}

const COLUNAS = `
  ID_USUARIO, NOME, EMAIL, SENHA_HASH, AUTH_PROVEDOR, AUTH_SUBJECT, AVATAR_URL,
  EMAIL_NOTIFICACAO, WHATSAPP_E164, EMAIL_VERIFICADO_EM, WHATSAPP_VERIFICADO_EM,
  PERFIL, ATIVO, ULTIMO_LOGIN_EM, CRIADO_EM
`;

export function mapearUsuario(linha: Linha): UsuarioComSenha {
  return {
    id: Number(linha.ID_USUARIO),
    nome: String(linha.NOME),
    email: String(linha.EMAIL),
    senhaHash: (linha.SENHA_HASH as string) ?? null,
    authProvedor: (linha.AUTH_PROVEDOR as string) ?? null,
    authSubject: (linha.AUTH_SUBJECT as string) ?? null,
    avatarUrl: (linha.AVATAR_URL as string) ?? null,
    emailNotificacao: (linha.EMAIL_NOTIFICACAO as string) ?? null,
    whatsappE164: (linha.WHATSAPP_E164 as string) ?? null,
    emailVerificadoEm: paraDataOuNulo(linha.EMAIL_VERIFICADO_EM),
    whatsappVerificadoEm: paraDataOuNulo(linha.WHATSAPP_VERIFICADO_EM),
    perfil: String(linha.PERFIL) as Perfil,
    ativo: paraBooleano(linha.ATIVO),
    ultimoLoginEm: paraDataOuNulo(linha.ULTIMO_LOGIN_EM),
    criadoEm: paraDataOuNulo(linha.CRIADO_EM) as Date,
  };
}

/** Remove o hash antes de qualquer coisa sair pela API. */
export function semSegredo(usuario: UsuarioComSenha): UsuarioDto {
  const { senhaHash: _s, authSubject: _a, ...publico } = usuario;
  return publico;
}

@Injectable()
export class UsuariosRepository {
  constructor(private readonly db: FirebirdService) {}

  async porId(id: number, tx?: TransacaoFirebird): Promise<UsuarioComSenha | null> {
    const sql = `SELECT ${COLUNAS} FROM USUARIOS WHERE ID_USUARIO = ?`;
    const linha = tx ? await tx.queryUm(sql, [id]) : await this.db.queryUm(sql, [id]);
    return linha ? mapearUsuario(linha) : null;
  }

  async porEmail(email: string): Promise<UsuarioComSenha | null> {
    const linha = await this.db.queryUm(
      `SELECT ${COLUNAS} FROM USUARIOS WHERE UPPER(EMAIL) = UPPER(?)`,
      [email],
    );
    return linha ? mapearUsuario(linha) : null;
  }

  async porProvedor(provedor: string, subject: string): Promise<UsuarioComSenha | null> {
    const linha = await this.db.queryUm(
      `SELECT ${COLUNAS} FROM USUARIOS WHERE AUTH_PROVEDOR = ? AND AUTH_SUBJECT = ?`,
      [provedor, subject],
    );
    return linha ? mapearUsuario(linha) : null;
  }

  async listar(busca: string | undefined, offset: number, limite: number) {
    const filtro = busca ? 'WHERE UPPER(NOME) LIKE ? OR UPPER(EMAIL) LIKE ?' : '';
    const parametros = busca ? [`%${busca.toUpperCase()}%`, `%${busca.toUpperCase()}%`] : [];

    const [linhas, total] = await Promise.all([
      this.db.query(
        `SELECT ${COLUNAS} FROM USUARIOS ${filtro} ORDER BY NOME
         OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`,
        [...parametros, offset, limite],
      ),
      this.db.queryUm<{ TOTAL: number }>(
        `SELECT COUNT(*) AS TOTAL FROM USUARIOS ${filtro}`,
        parametros,
      ),
    ]);

    return { itens: linhas.map(mapearUsuario), total: Number(total?.TOTAL ?? 0) };
  }

  async contar(): Promise<number> {
    const linha = await this.db.queryUm<{ TOTAL: number }>('SELECT COUNT(*) AS TOTAL FROM USUARIOS');
    return Number(linha?.TOTAL ?? 0);
  }

  async criar(
    dados: {
      nome: string;
      email: string;
      senhaHash?: string | null;
      perfil: Perfil;
      authProvedor?: string | null;
      authSubject?: string | null;
      avatarUrl?: string | null;
      emailNotificacao?: string | null;
      emailVerificadoEm?: Date | null;
    },
    tx?: TransacaoFirebird,
  ): Promise<number> {
    const sql = `
      INSERT INTO USUARIOS
        (NOME, EMAIL, SENHA_HASH, PERFIL, AUTH_PROVEDOR, AUTH_SUBJECT, AVATAR_URL,
         EMAIL_NOTIFICACAO, EMAIL_VERIFICADO_EM)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING ID_USUARIO`;
    const parametros = [
      dados.nome,
      dados.email,
      dados.senhaHash ?? null,
      dados.perfil,
      dados.authProvedor ?? null,
      dados.authSubject ?? null,
      dados.avatarUrl ?? null,
      dados.emailNotificacao ?? null,
      dados.emailVerificadoEm ?? null,
    ];

    // Sem tx, precisa ser escreverRetornando: queryUm abre transacao
    // SOMENTE LEITURA e o Firebird recusaria este INSERT ... RETURNING.
    const linha = tx
      ? await tx.queryUm<{ ID_USUARIO: number }>(sql, parametros)
      : await this.db.escreverRetornando<{ ID_USUARIO: number }>(sql, parametros);
    return Number(linha!.ID_USUARIO);
  }

  async atualizar(
    id: number,
    campos: Partial<{
      NOME: string;
      PERFIL: string;
      ATIVO: boolean;
      AVATAR_URL: string | null;
      SENHA_HASH: string | null;
      AUTH_PROVEDOR: string | null;
      AUTH_SUBJECT: string | null;
      EMAIL_NOTIFICACAO: string | null;
      WHATSAPP_E164: string | null;
      EMAIL_VERIFICADO_EM: Date | null;
      WHATSAPP_VERIFICADO_EM: Date | null;
      ULTIMO_LOGIN_EM: Date | null;
    }>,
    tx?: TransacaoFirebird,
  ): Promise<void> {
    const chaves = Object.keys(campos);
    if (!chaves.length) return;

    const atribuicoes = chaves.map((c) => `${c} = ?`).join(', ');
    const valores = chaves.map((c) => (campos as Record<string, unknown>)[c] ?? null);
    const sql = `UPDATE USUARIOS SET ${atribuicoes} WHERE ID_USUARIO = ?`;

    if (tx) await tx.executar(sql, [...valores, id] as never[]);
    else await this.db.executar(sql, [...valores, id] as never[]);
  }

  async registrarLogin(id: number): Promise<void> {
    await this.db.executar('UPDATE USUARIOS SET ULTIMO_LOGIN_EM = CURRENT_TIMESTAMP WHERE ID_USUARIO = ?', [
      id,
    ]);
  }
}
