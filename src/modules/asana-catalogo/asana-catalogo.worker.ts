import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { AppConfig, CONFIG_APP } from '../../common/config/configuration';
import { ErroAsana } from '../../integrations/asana/asana.client';
import { AsanaConexoesService } from '../asana-conexoes/asana-conexoes.service';
import { AsanaCatalogoService } from './asana-catalogo.service';

/** Valores de ASANA_CATALOGO_SYNC_CRON que desligam o agendamento. */
const DESLIGADO = new Set(['off', 'false', 'desligado', 'nunca']);

/**
 * Mantem o catalogo local em dia sem depender do botao "Sincronizar".
 *
 * Roda no cron de ASANA_CATALOGO_SYNC_CRON e percorre uma conexao ativa por
 * conta do Asana. A falha de uma conexao (token revogado, por exemplo) fica
 * registrada nela e nao impede as demais. Como os outros workers, obedece a
 * WORKERS_ENABLED para que so uma instancia da API faca o trabalho.
 */
@Injectable()
export class AsanaCatalogoWorker implements OnModuleInit {
  private readonly logger = new Logger(AsanaCatalogoWorker.name);
  private rodando = false;

  constructor(
    private readonly catalogo: AsanaCatalogoService,
    private readonly conexoes: AsanaConexoesService,
    private readonly agendador: SchedulerRegistry,
    @Inject(CONFIG_APP) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (!this.config.workers.habilitados) return;

    const cron = this.config.asana.catalogoSyncCron.trim();
    if (DESLIGADO.has(cron.toLowerCase())) {
      this.logger.log('ASANA_CATALOGO_SYNC_CRON desligado: o catalogo so sincroniza pelo botao.');
      return;
    }

    try {
      const job = new CronJob(cron, () => void this.rodar());
      this.agendador.addCronJob('asana-catalogo', job as never);
      job.start();
      this.logger.log(`Sincronizacao agendada do catalogo ativa: "${cron}".`);
    } catch (erro) {
      this.logger.error(
        `Cron "${cron}" invalido para ASANA_CATALOGO_SYNC_CRON: ${(erro as Error).message}. ` +
          'Use o formato de 6 campos (segundo minuto hora dia mes diaSemana) ou "off".',
      );
    }
  }

  /** Uma rodada: sincroniza com cada conta do Asana, em sequencia. */
  async rodar(): Promise<void> {
    if (this.rodando) {
      this.logger.warn('Sincronizacao anterior do catalogo ainda em andamento; rodada ignorada.');
      return;
    }
    this.rodando = true;
    try {
      const conexoes = await this.conexoes.listarParaSincronizacao();
      if (!conexoes.length) return;

      let ok = 0;
      for (const conexao of conexoes) {
        try {
          await this.catalogo.sincronizarComConexao(conexao);
          ok += 1;
        } catch (erro) {
          const mensagem =
            erro instanceof ErroAsana ? erro.message : (erro as Error)?.message ?? String(erro);
          this.logger.error(
            `Falha ao sincronizar o catalogo com a conexao ${conexao.id} ("${conexao.nome}"): ${mensagem}`,
          );
          await this.conexoes
            .registrarErro(conexao.id, `Sincronizacao agendada do catalogo: ${mensagem}`)
            .catch(() => undefined);
        }
      }
      this.logger.log(`Rodada agendada do catalogo: ${ok}/${conexoes.length} conexoes sincronizadas.`);
    } catch (erro) {
      this.logger.error(`Falha na rodada agendada do catalogo: ${(erro as Error).message}`);
    } finally {
      this.rodando = false;
    }
  }
}
