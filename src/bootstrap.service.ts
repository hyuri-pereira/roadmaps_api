import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import { AppConfig, CONFIG_APP } from './common/config/configuration';
import { UsuariosRepository } from './modules/usuarios/usuarios.repository';

/**
 * Primeira execucao: cria o administrador inicial se a tabela USUARIOS
 * estiver vazia, para que exista alguem capaz de configurar o sistema.
 *
 * Se apenas o e-mail for informado (sem senha), a conta fica pronta para
 * entrar pelo Google com aquele endereco.
 */
@Injectable()
export class BootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BootstrapService.name);

  constructor(
    private readonly usuarios: UsuariosRepository,
    @Inject(CONFIG_APP) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.criarAdministradorInicial();
    this.avisarSobrePendencias();
  }

  private async criarAdministradorInicial(): Promise<void> {
    const total = await this.usuarios.contar();
    if (total > 0) return;

    const email = this.config.bootstrap.adminEmail;
    if (!email) {
      this.logger.warn(
        'Nenhum usuario cadastrado e BOOTSTRAP_ADMIN_EMAIL esta vazio. ' +
          'Preencha o .env ou o primeiro login pelo Google virara ADMIN automaticamente.',
      );
      return;
    }

    const senha = this.config.bootstrap.adminSenha;
    const id = await this.usuarios.criar({
      nome: this.config.bootstrap.adminNome,
      email: email.toLowerCase(),
      senhaHash: senha ? await hash(senha, { memoryCost: 19456, timeCost: 2, parallelism: 1 }) : null,
      perfil: 'ADMIN',
      emailNotificacao: email.toLowerCase(),
    });

    this.logger.log(
      `Administrador inicial criado (id ${id}, ${email})` +
        (senha ? ' com senha do .env.' : '. Entre pelo Google com esse e-mail.'),
    );
  }

  /** Lista o que ainda falta configurar, para nao descobrir isso em producao. */
  private avisarSobrePendencias(): void {
    const pendencias: string[] = [];

    if (!this.config.google.configurado) {
      pendencias.push('login com Google (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET)');
    }
    if (!this.config.asana.oauthConfigurado) {
      pendencias.push('OAuth do Asana (os gestores so poderao usar PAT)');
    }
    if (!this.config.asana.webhookUrl) {
      pendencias.push('ASANA_WEBHOOK_URL (sem ela o sistema depende so da reconciliacao periodica)');
    }
    if (!this.config.mail.habilitado) pendencias.push('envio de e-mail (MAIL_ENABLED)');
    if (!this.config.waha.habilitado) pendencias.push('WhatsApp via WAHA (WAHA_ENABLED)');

    if (pendencias.length) {
      this.logger.warn(`Recursos ainda nao configurados: ${pendencias.join('; ')}.`);
    }
  }
}
