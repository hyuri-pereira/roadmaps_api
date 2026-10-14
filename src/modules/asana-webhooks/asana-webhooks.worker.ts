import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { AppConfig, CONFIG_APP } from '../../common/config/configuration';
import { AsanaWebhooksService } from './asana-webhooks.service';

/**
 * Aplica os eventos recebidos pelo webhook.
 *
 * A rota de recepcao apenas grava e responde 200 em milissegundos, porque o
 * Asana desativa webhooks que demoram. O trabalho de verdade (buscar o
 * estado atual da tarefa e espelhar no banco) acontece aqui.
 */
@Injectable()
export class AsanaWebhooksWorker implements OnModuleInit {
  private readonly logger = new Logger(AsanaWebhooksWorker.name);
  private rodando = false;

  constructor(
    private readonly service: AsanaWebhooksService,
    private readonly agendador: SchedulerRegistry,
    @Inject(CONFIG_APP) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (!this.config.workers.habilitados) return;

    try {
      const job = new CronJob('*/5 * * * * *', () => void this.rodar());
      this.agendador.addCronJob('webhook-eventos', job as never);
      job.start();
      this.logger.log('Processamento de eventos de webhook ativo (a cada 5s).');
    } catch (erro) {
      this.logger.error(`Nao foi possivel agendar o worker de webhooks: ${(erro as Error).message}`);
    }
  }

  async rodar(): Promise<void> {
    if (this.rodando) return;
    this.rodando = true;
    try {
      const total = await this.service.processarPendentes(50);
      if (total) this.logger.debug(`${total} evento(s) de webhook aplicados.`);
    } catch (erro) {
      this.logger.error(`Falha ao processar eventos de webhook: ${(erro as Error).message}`);
    } finally {
      this.rodando = false;
    }
  }
}
