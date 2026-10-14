import { BadRequestException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import axios from 'axios';
import { AppConfig, CONFIG_APP } from '../../common/config/configuration';

const URL_AUTORIZACAO = 'https://accounts.google.com/o/oauth2/v2/auth';
const URL_TOKEN = 'https://oauth2.googleapis.com/token';

export interface PerfilGoogle {
  subject: string;
  email: string;
  emailVerificado: boolean;
  nome: string;
  avatarUrl?: string | null;
  dominio?: string | null;
}

/**
 * Login com Google pelo Authorization Code Flow + PKCE.
 *
 * O id_token nao precisa de validacao de assinatura aqui porque e obtido
 * direto do endpoint de token do Google, por TLS, numa chamada servidor a
 * servidor (OpenID Connect Core, secao 3.1.3.7, item 1). Isso evita depender
 * de cache de JWKS. Se um dia o id_token passar a vir pelo navegador, a
 * verificacao de assinatura volta a ser obrigatoria.
 */
@Injectable()
export class GoogleService {
  constructor(@Inject(CONFIG_APP) private readonly config: AppConfig) {}

  garantirConfigurado(): void {
    if (!this.config.google.configurado) {
      throw new BadRequestException(
        'Login com Google nao configurado: preencha GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no .env.',
      );
    }
  }

  montarUrlAutorizacao(estado: string, codeChallenge: string): string {
    this.garantirConfigurado();
    const parametros = new URLSearchParams({
      client_id: this.config.google.clientId,
      redirect_uri: this.config.google.callbackUrl,
      response_type: 'code',
      scope: 'openid email profile',
      state: estado,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      access_type: 'online',
      prompt: 'select_account',
      include_granted_scopes: 'true',
    });
    return `${URL_AUTORIZACAO}?${parametros.toString()}`;
  }

  async trocarCodigo(codigo: string, codeVerifier: string): Promise<PerfilGoogle> {
    this.garantirConfigurado();

    const resposta = await axios.post(
      URL_TOKEN,
      new URLSearchParams({
        code: codigo,
        client_id: this.config.google.clientId,
        client_secret: this.config.google.clientSecret,
        redirect_uri: this.config.google.callbackUrl,
        grant_type: 'authorization_code',
        code_verifier: codeVerifier,
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
        validateStatus: () => true,
      },
    );

    if (resposta.status >= 400) {
      const detalhe = resposta.data?.error_description ?? resposta.data?.error ?? resposta.status;
      throw new UnauthorizedException(`O Google recusou a autenticacao: ${detalhe}`);
    }

    const idToken: string | undefined = resposta.data?.id_token;
    if (!idToken) throw new UnauthorizedException('O Google nao devolveu id_token.');

    const perfil = this.lerIdToken(idToken);
    this.validarDominio(perfil);
    return perfil;
  }

  private lerIdToken(idToken: string): PerfilGoogle {
    const partes = idToken.split('.');
    if (partes.length !== 3) throw new UnauthorizedException('id_token do Google malformado.');

    let carga: Record<string, unknown>;
    try {
      carga = JSON.parse(Buffer.from(partes[1], 'base64url').toString('utf8'));
    } catch {
      throw new UnauthorizedException('Nao foi possivel ler o id_token do Google.');
    }

    // Mesmo sem checar assinatura, conferimos que o token e para esta aplicacao.
    if (carga.aud !== this.config.google.clientId) {
      throw new UnauthorizedException('O id_token do Google foi emitido para outra aplicacao.');
    }
    if (typeof carga.exp === 'number' && carga.exp * 1000 < Date.now()) {
      throw new UnauthorizedException('O id_token do Google ja expirou.');
    }

    const email = String(carga.email ?? '').toLowerCase();
    if (!email) throw new UnauthorizedException('A conta Google nao expos um e-mail.');

    return {
      subject: String(carga.sub),
      email,
      emailVerificado: carga.email_verified === true,
      nome: String(carga.name ?? email),
      avatarUrl: (carga.picture as string) ?? null,
      dominio: (carga.hd as string) ?? email.split('@')[1] ?? null,
    };
  }

  private validarDominio(perfil: PerfilGoogle): void {
    if (!perfil.emailVerificado) {
      throw new UnauthorizedException('O Google informou que este e-mail nao esta verificado.');
    }
    const permitidos = this.config.google.dominiosPermitidos;
    if (!permitidos.length) return;

    const dominio = (perfil.dominio ?? '').toLowerCase();
    if (!permitidos.includes(dominio)) {
      throw new UnauthorizedException(
        `Somente contas dos dominios ${permitidos.join(', ')} podem entrar.`,
      );
    }
  }
}
