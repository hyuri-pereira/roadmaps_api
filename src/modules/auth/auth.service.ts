import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppConfig, CONFIG_APP } from '../../common/config/configuration';
import { CryptoService } from '../../common/crypto/crypto.service';
import { PayloadJwt } from '../../common/auth.types';
import { UsuarioComSenha, semSegredo } from '../usuarios/usuarios.repository';
import { UsuariosService } from '../usuarios/usuarios.service';
import { AuthSessoesRepository } from './auth-sessoes.repository';
import { GoogleService } from './google.service';
import { OAuthEstadosRepository } from './oauth-estados.repository';
import { TokensDto } from './auth.dto';

export interface ContextoRequisicao {
  userAgent?: string | null;
  ip?: string | null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(CONFIG_APP) private readonly config: AppConfig,
    private readonly jwt: JwtService,
    private readonly usuarios: UsuariosService,
    private readonly sessoes: AuthSessoesRepository,
    private readonly estados: OAuthEstadosRepository,
    private readonly google: GoogleService,
    private readonly crypto: CryptoService,
  ) {}

  // ---------------------------------------------------------------- login

  async loginLocal(
    email: string,
    senha: string,
    contexto: ContextoRequisicao,
  ): Promise<TokensDto> {
    const usuario = await this.usuarios.validarCredenciais(email, senha);
    if (!usuario) throw new UnauthorizedException('E-mail ou senha invalidos.');
    return this.emitirTokens(usuario, contexto);
  }

  /** Passo 1 do login Google: cria o state/PKCE e devolve a URL do consentimento. */
  async iniciarGoogle(redirecionarPara?: string) {
    this.google.garantirConfigurado();

    const destino = this.validarRedirecionamento(redirecionarPara);
    const { estado, codeChallenge } = await this.estados.criar({
      provedor: 'GOOGLE',
      redirecionarPara: destino,
    });

    return { url: this.google.montarUrlAutorizacao(estado, codeChallenge), estado };
  }

  /** Passo 2: o Google devolve o code; trocamos por identidade e emitimos JWT. */
  async concluirGoogle(
    codigo: string,
    estado: string,
    contexto: ContextoRequisicao,
  ): Promise<{ tokens: TokensDto; redirecionarPara: string }> {
    const salvo = await this.estados.consumir('GOOGLE', estado);
    if (!salvo?.codeVerifier) {
      throw new UnauthorizedException(
        'Login expirado ou state invalido. Recomece o login pelo botao do Google.',
      );
    }

    const perfil = await this.google.trocarCodigo(codigo, salvo.codeVerifier);
    const usuario = await this.usuarios.resolverPorProvedor({
      provedor: 'GOOGLE',
      subject: perfil.subject,
      email: perfil.email,
      nome: perfil.nome,
      avatarUrl: perfil.avatarUrl,
    });

    const tokens = await this.emitirTokens(usuario, contexto);
    return {
      tokens,
      redirecionarPara: salvo.redirecionarPara ?? this.config.app.urlFrontend,
    };
  }

  // -------------------------------------------------------------- tokens

  async renovar(refreshToken: string, contexto: ContextoRequisicao): Promise<TokensDto> {
    const hash = this.crypto.hashToken(refreshToken);
    const sessao = await this.sessoes.porHash(hash);
    if (!sessao) throw new UnauthorizedException('Refresh token invalido ou expirado.');

    const usuario = await this.usuarios.obterOuFalhar(sessao.idUsuario);
    if (!usuario.ativo) throw new UnauthorizedException('Usuario desativado.');

    // Rotaciona: o refresh usado morre junto com a emissao do novo.
    await this.sessoes.revogar(hash);
    return this.emitirTokens(usuario, contexto);
  }

  async sair(refreshToken: string): Promise<void> {
    await this.sessoes.revogar(this.crypto.hashToken(refreshToken));
  }

  async sairDeTudo(idUsuario: number): Promise<void> {
    await this.sessoes.revogarTodasDoUsuario(idUsuario);
  }

  private async emitirTokens(
    usuario: UsuarioComSenha,
    contexto: ContextoRequisicao,
  ): Promise<TokensDto> {
    const payload: PayloadJwt = {
      sub: usuario.id,
      email: usuario.email,
      nome: usuario.nome,
      perfil: usuario.perfil,
    };

    const accessToken = await this.jwt.signAsync(payload, {
      expiresIn: this.config.seguranca.jwtAccessTtl,
      issuer: this.config.seguranca.jwtIssuer,
    });

    const refreshToken = this.crypto.gerarTokenAleatorio(48);
    await this.sessoes.criar({
      idUsuario: usuario.id,
      tokenHash: this.crypto.hashToken(refreshToken),
      expiraEm: new Date(Date.now() + duracaoMs(this.config.seguranca.jwtRefreshTtl)),
      userAgent: contexto.userAgent,
      ip: contexto.ip,
    });

    await this.usuarios.registrarLogin(usuario.id);

    return {
      accessToken,
      refreshToken,
      expiraEm: Math.floor(duracaoMs(this.config.seguranca.jwtAccessTtl) / 1000),
      usuario: semSegredo(usuario),
    };
  }

  /**
   * So aceitamos redirecionar para o proprio frontend. Sem isso, o callback
   * do Google viraria um open redirect com token na mao do atacante.
   */
  private validarRedirecionamento(destino?: string): string {
    const padrao = this.config.app.urlFrontend;
    if (!destino) return padrao;
    try {
      const alvo = new URL(destino);
      const origensPermitidas = new Set([
        new URL(padrao).origin,
        ...this.config.app.corsOrigens.map((origem) => new URL(origem).origin),
      ]);
      if (!origensPermitidas.has(alvo.origin)) {
        this.logger.warn(`Redirecionamento pos-login recusado para ${alvo.origin}.`);
        return padrao;
      }
      return alvo.toString();
    } catch {
      return padrao;
    }
  }
}

/** Converte "15m", "30d", "3600" em milissegundos. */
export function duracaoMs(valor: string): number {
  const casado = /^(\d+)\s*([smhd])?$/i.exec(valor.trim());
  if (!casado) return 15 * 60_000;
  const quantidade = Number(casado[1]);
  const unidade = (casado[2] ?? 's').toLowerCase();
  const fatores: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return quantidade * (fatores[unidade] ?? 1000);
}
