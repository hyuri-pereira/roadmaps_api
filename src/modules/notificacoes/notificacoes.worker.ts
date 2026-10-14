import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { AppConfig, CONFIG_APP } from '../../common/config/configuration';
import { MailService } from '../../integrations/mail/mail.service';
import { NotificacoesRepository } from './notificacoes.repository';
import { NotificacoesService } from './notificacoes.service';

/**
 * Worker de envio dos avisos (e-mail e WhatsApp).
 *
 * Separado do worker de integracao de proposito: um problema no SMTP ou no
 * WAHA nao pode travar a sincronizacao dos cards com o Asana.
 */
@Injectable()
export class NotificacoesWorker implements OnModuleInit {
  private readonly logger = new Logger(NotificacoesWorker.name);
  private rodando = false;

  constructor(
    private readonly repo: NotificacoesRepository,
    private readonly service: NotificacoesService,
    private readonly mail: MailService,
    private readonly agendador: SchedulerRegistry,
    @Inject(CONFIG_APP) private readonly config: AppConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.mail.semearDoEnv();

    if (!this.config.workers.habilitados) {
      this.logger.warn('WORKERS_ENABLED=false: os avisos nao serao enviados por esta instancia.');
      return;
    }

    try {
      const job = new CronJob(this.config.workers.notificacaoCron, () => void this.rodar());
      this.agendador.addCronJob('notificacoes', job as never);
      job.start();
      this.logger.log(`Worker de avisos ativo ("${this.config.workers.notificacaoCron}").`);
    } catch (erro) {
      this.logger.error(
        `Cron "${this.config.workers.notificacaoCron}" invalido: ${(erro as Error).message}`,
      );
    }
  }

  async rodar(): Promise<void> {
    if (this.rodando) return;
    this.rodando = true;

    try {
      const pendentes = await this.repo.reivindicar(
        this.config.workers.notificacaoLote,
        this.config.workers.notificacaoLeaseSegundos,
      );
      if (!pendentes.length) return;

      this.logger.debug(`Enviando ${pendentes.length} aviso(s).`);
      for (const notificacao of pendentes) {
        await this.service.enviar(notificacao);
      }
    } catch (erro) {
      this.logger.error(`Falha na rodada de avisos: ${(erro as Error).message}`);
    } finally {
      this.rodando = false;
    }
  }
}
