import { Inject, Injectable, Logger } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';
import { AppConfig, CONFIG_APP } from '../../common/config/configuration';
import { CryptoService } from '../../common/crypto/crypto.service';
import { FirebirdService } from '../../database/firebird.service';

const PROPOSITO_SMTP = 'smtp:password';

export interface ConfiguracaoEmail {
  remetenteEmail: string;
  remetenteNome: string;
  host: string;
  porta: number;
  seguranca: 'TLS' | 'STARTTLS';
  usuario: string | null;
  senha: string | null;
  ativo: boolean;
}

/**
 * Envio de e-mail pelo SMTP unico do sistema (tabela EMAIL_CONFIG, linha 1).
 *
 * O remetente e definido pelo administrador; cada gestor escolhe apenas se
 * quer receber e em qual endereco.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporte?: Transporter;
  private assinaturaTransporte = '';

  constructor(
    private readonly db: FirebirdService,
    private readonly crypto: CryptoService,
    @Inject(CONFIG_APP) private readonly config: AppConfig,
  ) {}

  async obterConfiguracao(): Promise<ConfiguracaoEmail | null> {
    const l = await this.db.queryUm(
      `SELECT REMETENTE_EMAIL, REMETENTE_NOME, SMTP_HOST, SMTP_PORTA, SMTP_SEGURANCA,
              SMTP_USUARIO, SEGREDO_CIFRADO, VERSAO_CHAVE, ATIVO
         FROM EMAIL_CONFIG WHERE ID_EMAIL_CONFIG = 1`,
    );
    if (!l) return null;

    let senha: string | null = null;
    if (l.SEGREDO_CIFRADO) {
      try {
        senha = this.crypto.decifrar(
          comoBuffer(l.SEGREDO_CIFRADO),
          PROPOSITO_SMTP,
          (l.VERSAO_CHAVE as string) ?? undefined,
        );
      } catch (erro) {
        this.logger.error(`Senha SMTP ilegivel: ${(erro as Error).message}`);
      }
    }

    return {
      remetenteEmail: String(l.REMETENTE_EMAIL),
      remetenteNome: String(l.REMETENTE_NOME),
      host: String(l.SMTP_HOST),
      porta: Number(l.SMTP_PORTA),
      seguranca: String(l.SMTP_SEGURANCA) as 'TLS' | 'STARTTLS',
      usuario: (l.SMTP_USUARIO as string) ?? null,
      senha,
      ativo: l.ATIVO === true || l.ATIVO === 1,
    };
  }

  async salvarConfiguracao(dados: {
    remetenteEmail: string;
    remetenteNome: string;
    host: string;
    porta: number;
    seguranca: 'TLS' | 'STARTTLS';
    usuario?: string | null;
    senha?: string | null;
    ativo: boolean;
  }): Promise<void> {
    const envelope = dados.senha ? this.crypto.cifrar(dados.senha, PROPOSITO_SMTP) : null;

    await this.db.executar(
      `UPDATE OR INSERT INTO EMAIL_CONFIG
         (ID_EMAIL_CONFIG, REMETENTE_EMAIL, REMETENTE_NOME, SMTP_HOST, SMTP_PORTA,
          SMTP_SEGURANCA, SMTP_USUARIO, SEGREDO_CIFRADO, SEGREDO_NONCE_BASE64,
          VERSAO_CHAVE, ATIVO, ATUALIZADO_EM)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       MATCHING (ID_EMAIL_CONFIG)`,
      [
        dados.remetenteEmail,
        dados.remetenteNome,
        dados.host,
        dados.porta,
        dados.seguranca,
        dados.usuario ?? null,
        envelope?.conteudo ?? null,
        envelope?.nonceBase64 ?? null,
        envelope?.versaoChave ?? null,
        dados.ativo,
      ],
    );

    // Forca a recriacao do transporte na proxima mensagem.
    this.transporte = undefined;
    this.assinaturaTransporte = '';
  }

  /** Popula EMAIL_CONFIG na primeira execucao, a partir do .env. */
  async semearDoEnv(): Promise<void> {
    if (!this.config.mail.habilitado) return;
    const existente = await this.obterConfiguracao();
    if (existente) return;
    if (!this.config.mail.host || !this.config.mail.remetenteEmail) {
      this.logger.warn('MAIL_ENABLED=true mas MAIL_HOST/MAIL_FROM_EMAIL estao vazios.');
      return;
    }

    await this.salvarConfiguracao({
      remetenteEmail: this.config.mail.remetenteEmail,
      remetenteNome: this.config.mail.remetenteNome,
      host: this.config.mail.host,
      porta: this.config.mail.porta,
      seguranca: this.config.mail.seguranca,
      usuario: this.config.mail.usuario || null,
      senha: this.config.mail.senha || null,
      ativo: true,
    });
    this.logger.log('EMAIL_CONFIG criada a partir do .env.');
  }

  async enviar(dados: {
    para: string;
    assunto: string;
    texto: string;
    html?: string;
  }): Promise<{ messageId: string | null }> {
    const configuracao = await this.obterConfiguracao();
    if (!configuracao?.ativo) {
      throw new Error('Envio de e-mail desativado: configure EMAIL_CONFIG e marque como ativo.');
    }

    const transporte = this.obterTransporte(configuracao);
    const resultado = await transporte.sendMail({
      from: `"${configuracao.remetenteNome}" <${configuracao.remetenteEmail}>`,
      to: dados.para,
      subject: dados.assunto,
      text: dados.texto,
      html: dados.html,
    });

    return { messageId: resultado.messageId ?? null };
  }

  /** Reaproveita o transporte enquanto a configuracao nao mudar. */
  private obterTransporte(configuracao: ConfiguracaoEmail): Transporter {
    const assinatura = [
      configuracao.host,
      configuracao.porta,
      configuracao.seguranca,
      configuracao.usuario,
    ].join('|');

    if (this.transporte && this.assinaturaTransporte === assinatura) return this.transporte;

    this.transporte = createTransport({
      host: configuracao.host,
      port: configuracao.porta,
      // TLS implicito (465) x STARTTLS (587).
      secure: configuracao.seguranca === 'TLS',
      requireTLS: configuracao.seguranca === 'STARTTLS',
      auth: configuracao.usuario
        ? { user: configuracao.usuario, pass: configuracao.senha ?? '' }
        : undefined,
      tls: { rejectUnauthorized: this.config.mail.rejeitarNaoAutorizado },
    });
    this.assinaturaTransporte = assinatura;
    return this.transporte;
  }

  async verificarConexao(): Promise<boolean> {
    const configuracao = await this.obterConfiguracao();
    if (!configuracao) return false;
    try {
      await this.obterTransporte(configuracao).verify();
      return true;
    } catch (erro) {
      this.logger.warn(`SMTP indisponivel: ${(erro as Error).message}`);
      return false;
    }
  }
}

function comoBuffer(valor: unknown): Buffer {
  if (Buffer.isBuffer(valor)) return valor;
  return Buffer.from(String(valor), 'binary');
}
