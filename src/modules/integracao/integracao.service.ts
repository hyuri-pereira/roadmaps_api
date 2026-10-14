import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig, CONFIG_APP } from '../../common/config/configuration';
import { calcularBackoffSegundos, paraDataAsana } from '../../common/utils';
import { AsanaClient, ErroAsana } from '../../integrations/asana/asana.client';
import { AsanaTarefa } from '../../integrations/asana/asana.types';
import { AsanaConexoesService } from '../asana-conexoes/asana-conexoes.service';
import { removerBlocoReferencias } from '../cards/card-corpo.util';
import { IntegracaoRepository, JobReivindicado } from './integracao.repository';
import { CardParaSincronizar, SincronizacaoRepository } from './sincronizacao.repository';

/** O que fazer com o job depois de tentar executa-lo. */
type Desfecho =
  | { tipo: 'concluido'; recursoGid?: string | null }
  | { tipo: 'reagendar'; segundos: number; motivo: string }
  | { tipo: 'erro'; motivo: string }
  | { tipo: 'cancelado'; motivo: string };

@Injectable()
export class IntegracaoService {
  private readonly logger = new Logger(IntegracaoService.name);

  constructor(
    private readonly fila: IntegracaoRepository,
    private readonly sinc: SincronizacaoRepository,
    private readonly conexoes: AsanaConexoesService,
    @Inject(CONFIG_APP) private readonly config: AppConfig,
  ) {}

  /**
   * Executa um job ja reivindicado.
   *
   * Todo o HTTP acontece aqui, FORA da transacao que pegou a lease. O
   * desfecho so e gravado se a lease ainda pertencer a este worker.
   */
  async processar(job: JobReivindicado): Promise<void> {
    let desfecho: Desfecho;

    try {
      desfecho = await this.executar(job);
    } catch (erro) {
      desfecho = this.traduzirFalha(job, erro);
    }

    await this.aplicarDesfecho(job, desfecho);
  }

  private async executar(job: JobReivindicado): Promise<Desfecho> {
    if (!job.idAsanaConexao) {
      return { tipo: 'erro', motivo: 'Job sem conexao Asana associada.' };
    }

    const cliente = this.conexoes.criarCliente(job.idAsanaConexao, (registro) => {
      if (!this.config.log.registrarPayloadIntegracao) return;
      void this.fila.registrarLog({
        idJob: job.id,
        nivel: registro.status >= 400 ? 'ERRO' : 'DEBUG',
        codigoHttp: registro.status,
        mensagem: `${registro.metodo} ${registro.caminho} (${registro.duracaoMs}ms)`,
        requisicao: registro.requisicao,
        resposta: registro.resposta,
      });
    });

    switch (job.tipoOperacao) {
      case 'CRIAR_TAREFA':
        return this.criarTarefa(job, cliente);
      case 'ATUALIZAR_TAREFA':
        return this.atualizarTarefa(job, cliente);
      case 'CONCLUIR_TAREFA':
        return this.concluirTarefa(job, cliente);
      case 'EXCLUIR_TAREFA':
        return this.excluirTarefa(job, cliente);
      case 'RECONCILIAR_TAREFA':
        return this.reconciliarTarefa(job, cliente);
      default:
        return { tipo: 'cancelado', motivo: `Operacao ${job.tipoOperacao} nao implementada.` };
    }
  }

  // ------------------------------------------------------------ operacoes

  private async criarTarefa(job: JobReivindicado, cliente: AsanaClient): Promise<Desfecho> {
    const card = await this.carregarCard(job);
    if (!card) return { tipo: 'cancelado', motivo: 'Card nao existe mais.' };

    if (card.excluidoEm) {
      // O gestor excluiu antes de a criacao sair. Nada a criar.
      return { tipo: 'cancelado', motivo: 'Card foi excluido antes de ser criado no Asana.' };
    }
    if (card.gid) {
      return { tipo: 'concluido', recursoGid: card.gid };
    }
    if (!card.gidProjetoDestino) {
      return {
        tipo: 'erro',
        motivo:
          'Destino nao resolvido: a equipe precisa ter SPRINT/"A fazer" e Backlog/"Refino" ' +
          'configurados e o catalogo sincronizado.',
      };
    }

    let tarefa: AsanaTarefa;
    try {
      tarefa = await cliente.criarTarefa({
        workspace: card.gidWorkspace,
        projeto: card.gidProjetoDestino,
        nome: card.titulo,
        notas: card.descricao ?? '',
        prazo: paraDataAsana(card.dataLimite),
      });
    } catch (erro) {
      // Timeout ou 5xx deixam a duvida: a tarefa pode ter sido criada.
      // Procuramos antes de qualquer nova tentativa, como manda o contrato.
      if (erro instanceof ErroAsana && erro.temporario) {
        const encontrada = await this.procurarTarefaCriada(cliente, card);
        if (encontrada) {
          await this.sinc.registrarCriacao(card.id, {
            gid: encontrada.gid,
            permalink: encontrada.permalink_url,
            modificadoEm: encontrada.modified_at ? new Date(encontrada.modified_at) : null,
          });
          await this.posicionarNaSecao(cliente, card, encontrada.gid);
          return { tipo: 'concluido', recursoGid: encontrada.gid };
        }
      }
      throw erro;
    }

    await this.sinc.registrarCriacao(card.id, {
      gid: tarefa.gid,
      permalink: tarefa.permalink_url,
      modificadoEm: tarefa.modified_at ? new Date(tarefa.modified_at) : null,
    });

    await this.posicionarNaSecao(cliente, card, tarefa.gid);

    // O card ja nasceu com pedido de conclusao (botao "Concluir roadmap"
    // apertado antes de a criacao sair)? Entao conclui agora.
    if (card.conclusaoSolicitada || card.concluido) {
      await cliente.atualizarTarefa(tarefa.gid, { concluida: true });
    }

    this.logger.log(`Card ${card.id} criado no Asana como tarefa ${tarefa.gid}.`);
    return { tipo: 'concluido', recursoGid: tarefa.gid };
  }

  private async atualizarTarefa(job: JobReivindicado, cliente: AsanaClient): Promise<Desfecho> {
    const card = await this.carregarCard(job);
    if (!card) return { tipo: 'cancelado', motivo: 'Card nao existe mais.' };
    if (card.excluidoEm) return { tipo: 'cancelado', motivo: 'Card excluido.' };

    if (!card.gid) {
      // A criacao ainda nao saiu. Aguardamos: o job de criacao tem id menor e
      // sera processado antes na proxima rodada.
      if (await this.fila.criacaoPendente(card.id)) {
        return { tipo: 'reagendar', segundos: 15, motivo: 'Aguardando a criacao da tarefa.' };
      }
      return { tipo: 'erro', motivo: 'Card sem GID e sem criacao pendente na fila.' };
    }

    // Snapshot ANTES do HTTP: se a revisao mudar no meio, nao marcamos como
    // sincronizado e um job posterior reenvia o estado mais novo.
    const revisaoNoInicio = card.revisao;

    const tarefa = await cliente.atualizarTarefa(card.gid, {
      nome: card.titulo,
      notas: card.descricao ?? '',
      prazo: paraDataAsana(card.dataLimite),
    });

    await this.moverConformeCheckbox(cliente, card);

    const confirmado = await this.sinc.confirmarSincronizacao(card.id, revisaoNoInicio, {
      modificadoEm: tarefa.modified_at ? new Date(tarefa.modified_at) : null,
      permalink: tarefa.permalink_url,
    });

    if (!confirmado) {
      this.logger.debug(
        `Card ${card.id} mudou durante a atualizacao; o proximo job reaplica o estado novo.`,
      );
    }
    return { tipo: 'concluido', recursoGid: card.gid };
  }

  private async concluirTarefa(job: JobReivindicado, cliente: AsanaClient): Promise<Desfecho> {
    const card = await this.carregarCard(job);
    if (!card) return { tipo: 'cancelado', motivo: 'Card nao existe mais.' };
    if (card.excluidoEm) return { tipo: 'cancelado', motivo: 'Card excluido.' };

    if (!card.gid) {
      if (await this.fila.criacaoPendente(card.id)) {
        return { tipo: 'reagendar', segundos: 15, motivo: 'Aguardando a criacao da tarefa.' };
      }
      return { tipo: 'erro', motivo: 'Card sem GID; nao da para concluir no Asana.' };
    }

    // O banco e a fonte da verdade do que o gestor pediu: concluir ou reabrir.
    const desejado = card.concluido || card.conclusaoSolicitada;
    const tarefa = await cliente.atualizarTarefa(card.gid, { concluida: desejado });

    await this.sinc.confirmarSincronizacao(card.id, card.revisao, {
      modificadoEm: tarefa.modified_at ? new Date(tarefa.modified_at) : null,
      permalink: tarefa.permalink_url,
    });

    return { tipo: 'concluido', recursoGid: card.gid };
  }

  private async excluirTarefa(job: JobReivindicado, cliente: AsanaClient): Promise<Desfecho> {
    const card = await this.carregarCard(job);

    // O card pode ja ter sido purgado por outro job; nesse caso o trabalho
    // remoto ja terminou.
    if (!card) return { tipo: 'concluido' };

    if (!card.gid) {
      // Criacao em voo: precisamos do GID para poder apagar. Se nao ha
      // criacao pendente, nunca existiu tarefa remota e podemos purgar.
      if (await this.fila.criacaoPendente(card.id)) {
        return {
          tipo: 'reagendar',
          segundos: 20,
          motivo: 'Aguardando o GID da criacao em andamento para poder excluir.',
        };
      }
      await this.purgar(card);
      return { tipo: 'concluido' };
    }

    try {
      await cliente.excluirTarefa(card.gid);
    } catch (erro) {
      // 404 significa que a tarefa ja nao existe: ausencia remota confirmada.
      if (erro instanceof ErroAsana && erro.statusAsana === 404) {
        this.logger.debug(`Tarefa ${card.gid} ja nao existia no Asana.`);
      } else {
        throw erro;
      }
    }

    await this.purgar(card);
    return { tipo: 'concluido', recursoGid: card.gid };
  }

  /** Le o estado atual no Asana e espelha no banco. */
  private async reconciliarTarefa(job: JobReivindicado, cliente: AsanaClient): Promise<Desfecho> {
    const card = await this.carregarCard(job);
    if (!card?.gid) return { tipo: 'cancelado', motivo: 'Card sem GID para reconciliar.' };

    let tarefa: AsanaTarefa;
    try {
      tarefa = await cliente.tarefa(card.gid);
    } catch (erro) {
      if (erro instanceof ErroAsana && erro.statusAsana === 404) {
        await this.sinc.registrarErroNoCard(
          card.id,
          'A tarefa foi apagada no Asana. O card continua aqui para o gestor decidir.',
          'CONFLITO',
        );
        return { tipo: 'concluido' };
      }
      throw erro;
    }

    await this.espelhar(card.id, tarefa);
    return { tipo: 'concluido', recursoGid: card.gid };
  }

  /**
   * Espelha uma tarefa do Asana no card local.
   * Usado pela reconciliacao e pelo processamento de webhooks.
   */
  async espelhar(idCard: number, tarefa: AsanaTarefa): Promise<void> {
    const notas = tarefa.notes ?? '';

    // Descobre em qual coluna do SPRINT a tarefa esta agora. Sair do SPRINT
    // precisa zerar a etapa, por isso o valor comeca nulo.
    let etapa: string | null = null;
    const membresias: { idProjeto: number; idSecao: number | null; gerenciada: boolean }[] = [];

    for (const membership of tarefa.memberships ?? []) {
      const gidProjeto = membership.project?.gid;
      if (!gidProjeto) continue;

      const locais = await this.sinc.idsLocaisDe(gidProjeto, membership.section?.gid ?? null);
      if (!locais) continue;

      membresias.push({
        idProjeto: locais.idProjeto,
        idSecao: locais.idSecao,
        gerenciada: false,
      });

      if (membership.section?.gid) {
        const codigo = await this.sinc.etapaPorGidSecao(membership.section.gid);
        if (codigo) etapa = codigo;
      }
    }

    await this.sinc.espelharDoAsana(idCard, {
      titulo: tarefa.name ?? '(sem titulo)',
      descricao: notas,
      // Guardamos tambem o texto sem o bloco de links, para que uma edicao
      // local futura recomponha o corpo sem duplicar as referencias.
      descricaoBase: removerBlocoReferencias(notas),
      dataLimite: tarefa.due_on ? new Date(`${tarefa.due_on}T00:00:00`) : null,
      concluido: tarefa.completed === true,
      etapaSprint: etapa,
      responsavelGid: tarefa.assignee?.gid ?? null,
      responsavelNome: tarefa.assignee?.name ?? null,
      permalink: tarefa.permalink_url ?? null,
      modificadoEm: tarefa.modified_at ? new Date(tarefa.modified_at) : null,
    });

    if (membresias.length) await this.sinc.substituirMembresias(idCard, membresias);
  }

  // -------------------------------------------------------------- apoio

  private async carregarCard(job: JobReivindicado): Promise<CardParaSincronizar | null> {
    if (!job.idEntidadeLocal) return null;
    return this.sinc.cardParaSincronizar(job.idEntidadeLocal);
  }

  /** Coloca a tarefa recem-criada na coluna certa do projeto de destino. */
  private async posicionarNaSecao(
    cliente: AsanaClient,
    card: CardParaSincronizar,
    gidTarefa: string,
  ): Promise<void> {
    if (!card.gidSecaoDestino) return;
    try {
      await cliente.moverParaSecao(gidTarefa, card.gidSecaoDestino);
    } catch (erro) {
      // A tarefa ja esta no projeto; ficar na coluna padrao e aceitavel.
      this.logger.warn(
        `Card ${card.id} criado, mas nao foi possivel move-lo para a secao ` +
          `${card.gidSecaoDestino}: ${(erro as Error).message}`,
      );
    }
  }

  /**
   * Move o card entre SPRINT e Backlog conforme o checkbox.
   *
   * Remove apenas a membresia gerenciada por nos (o outro dos dois projetos)
   * e preserva a participacao em qualquer outro projeto do Asana.
   */
  private async moverConformeCheckbox(
    cliente: AsanaClient,
    card: CardParaSincronizar,
  ): Promise<void> {
    if (!card.gid || !card.gidProjetoDestino) return;

    const gidAnterior = card.entrarNaSprint ? card.gidProjetoBacklog : card.gidProjetoSprint;

    try {
      await cliente.adicionarAoProjeto(
        card.gid,
        card.gidProjetoDestino,
        card.gidSecaoDestino ?? undefined,
      );
      if (gidAnterior && gidAnterior !== card.gidProjetoDestino) {
        await cliente.removerDoProjeto(card.gid, gidAnterior);
      }
    } catch (erro) {
      this.logger.warn(
        `Nao foi possivel reposicionar o card ${card.id} entre SPRINT e Backlog: ` +
          `${(erro as Error).message}`,
      );
    }
  }

  /**
   * Depois de um POST ambiguo, procura a tarefa pelo titulo dentro do projeto
   * de destino. So adota quando encontra exatamente uma, para nao "adotar" a
   * tarefa errada nem criar duplicata.
   */
  private async procurarTarefaCriada(
    cliente: AsanaClient,
    card: CardParaSincronizar,
  ): Promise<AsanaTarefa | null> {
    try {
      const candidatas = await cliente.procurarTarefaPorMarcador(card.gidWorkspace, card.titulo);
      if (!candidatas) return null;

      const mesmoNome = candidatas.name === card.titulo;
      const noProjeto = (candidatas.projects ?? []).some(
        (p) => p.gid === card.gidProjetoDestino,
      );
      return mesmoNome && noProjeto ? candidatas : null;
    } catch (erro) {
      this.logger.warn(
        `Falha ao reconciliar criacao ambigua do card ${card.id}: ${(erro as Error).message}`,
      );
      return null;
    }
  }

  private async purgar(card: CardParaSincronizar): Promise<void> {
    await this.sinc.purgarCard(card.id);
    const removido = await this.sinc.purgarRoadmapSeVazio(card.idRoadmap);
    if (removido) {
      this.logger.log(`Roadmap ${card.idRoadmap} removido fisicamente: nao restam cards.`);
    }
  }

  private traduzirFalha(job: JobReivindicado, erro: unknown): Desfecho {
    const mensagem = erro instanceof Error ? erro.message : String(erro);

    if (erro instanceof ErroAsana && erro.temporario) {
      const segundos =
        erro.retryAfterSegundos ??
        calcularBackoffSegundos(
          job.tentativas,
          this.config.workers.backoffBaseSegundos,
          this.config.workers.backoffMaxSegundos,
        );
      return { tipo: 'reagendar', segundos, motivo: mensagem };
    }

    if (job.tentativas >= this.config.workers.integracaoMaxTentativas) {
      return { tipo: 'erro', motivo: `Limite de tentativas atingido. Ultimo erro: ${mensagem}` };
    }

    const segundos = calcularBackoffSegundos(
      job.tentativas,
      this.config.workers.backoffBaseSegundos,
      this.config.workers.backoffMaxSegundos,
    );
    return { tipo: 'reagendar', segundos, motivo: mensagem };
  }

  private async aplicarDesfecho(job: JobReivindicado, desfecho: Desfecho): Promise<void> {
    let gravou = false;

    switch (desfecho.tipo) {
      case 'concluido':
        gravou = await this.fila.concluir(job.id, job.lockToken, desfecho.recursoGid);
        break;
      case 'reagendar':
        gravou = await this.fila.reagendar(
          job.id,
          job.lockToken,
          desfecho.segundos,
          desfecho.motivo,
        );
        break;
      case 'erro':
        gravou = await this.fila.falhar(job.id, job.lockToken, desfecho.motivo);
        if (gravou && job.idEntidadeLocal) {
          await this.sinc.registrarErroNoCard(job.idEntidadeLocal, desfecho.motivo);
        }
        await this.fila.registrarLog({
          idJob: job.id,
          nivel: 'ERRO',
          mensagem: desfecho.motivo,
        });
        break;
      case 'cancelado':
        gravou = await this.fila.cancelar(job.id, job.lockToken, desfecho.motivo);
        break;
    }

    // Lease perdida: outro worker assumiu o job enquanto este fazia o HTTP.
    // Nao sobrescrevemos o resultado dele.
    if (!gravou) {
      this.logger.warn(
        `Job ${job.id} teve a lease expirada durante o processamento; ` +
          'o desfecho foi descartado para nao sobrescrever outro worker.',
      );
    }
  }
}
