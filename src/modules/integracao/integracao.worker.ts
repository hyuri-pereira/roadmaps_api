import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { AppConfig, CONFIG_APP } from '../../common/config/configuration';
import { IntegracaoRepository } from './integracao.repository';
import { IntegracaoService } from './integracao.service';
import { SincronizacaoRepository } from './sincronizacao.repository';

/**
 * Worker da fila de integracao com o Asana.
 *
 * Nenhuma trigger do banco faz HTTP: e este processo que tira os jobs da
 * INTEGRACAO_FILA e conversa com o Asana. O cron e configuravel no .env e o
 * worker pode ser desligado (WORKERS_ENABLED=false) quando a API roda em
 * varias instancias e so uma deve processar a fila.
 */
@Injectable()
export class IntegracaoWorker implements OnModuleInit {
  private readonly logger = new Logger(IntegracaoWorker.name);
  private rodando = false;

  constructor(
    private readonly fila: IntegracaoRepository,
    private readonly servico: IntegracaoService,
    private readonly sinc: SincronizacaoRepository,
    private readonly agendador: SchedulerRegistry,
    @Inject(CONFIG_APP) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (!this.config.workers.habilitados) {
      this.logger.warn('WORKERS_ENABLED=false: a fila de integracao nao sera processada.');
      return;
    }

    this.registrar('integracao-fila', this.config.workers.integracaoCron, () => this.rodar());
    this.registrar('asana-reconciliacao', this.config.asana.reconciliacaoCron, () =>
      this.reconciliar(),
    );

    this.logger.log(
      `Worker ${this.config.workers.id} ativo. Fila: "${this.config.workers.integracaoCron}", ` +
        `reconciliacao: "${this.config.asana.reconciliacaoCron}".`,
    );
  }

  private registrar(nome: string, cron: string, acao: () => Promise<void>): void {
    try {
      const job = new CronJob(cron, () => void acao());
      this.agendador.addCronJob(nome, job as never);
      job.start();
    } catch (erro) {
      this.logger.error(
        `Cron "${cron}" invalido para ${nome}: ${(erro as Error).message}. ` +
          'Use o formato de 6 campos (segundo minuto hora dia mes diaSemana).',
      );
    }
  }

  /** Uma rodada: reivindica um lote e processa em sequencia. */
  async rodar(): Promise<void> {
    // Sem sobreposicao: se a rodada anterior ainda esta em andamento, espera.
    if (this.rodando) return;
    this.rodando = true;

    try {
      const jobs = await this.fila.reivindicar(
        this.config.workers.id,
        this.config.workers.integracaoLote,
        this.config.workers.integracaoLeaseSegundos,
      );
      if (!jobs.length) return;

      this.logger.debug(`Processando ${jobs.length} job(s) da fila de integracao.`);

      // Sequencial de proposito: o rate limit do Asana e por token e a ordem
      // entre operacoes do mesmo card precisa ser respeitada.
      for (const job of jobs) {
        await this.servico.processar(job);
      }
    } catch (erro) {
      this.logger.error(`Falha na rodada da fila: ${(erro as Error).message}`);
    } finally {
      this.rodando = false;
    }
  }

  /**
   * Rede de seguranca do webhook: relê periodicamente os cards mais
   * desatualizados. Mudanca de membresia nem sempre altera modified_at, entao
   * a leitura completa e necessaria de tempos em tempos.
   */
  async reconciliar(): Promise<void> {
    try {
      const cards = await this.sinc.cardsParaReconciliar(this.config.workers.integracaoLote);
      if (!cards.length) return;

      for (const card of cards) {
        await this.fila.enfileirar({
          idConexao: card.idConexao,
          tipoOperacao: 'RECONCILIAR_TAREFA',
          tipoEntidade: 'ROADMAP_ITEM',
          idEntidade: card.id,
          recursoGid: card.gid,
          // A chave muda a cada janela de 15 minutos: reconciliar de novo e
          // legitimo, mas nao queremos multiplos jobs identicos na fila.
          chave: `RECONCILIAR:${card.id}:${Math.floor(Date.now() / 900_000)}`,
          prioridade: 8,
        });
      }
      this.logger.debug(`${cards.length} card(s) enfileirados para reconciliacao.`);
    } catch (erro) {
      this.logger.error(`Falha ao agendar reconciliacao: ${(erro as Error).message}`);
    }
  }
}
