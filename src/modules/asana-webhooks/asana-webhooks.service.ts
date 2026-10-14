import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { AppConfig, CONFIG_APP } from '../../common/config/configuration';
import { CryptoService } from '../../common/crypto/crypto.service';
import { AsanaCatalogoRepository } from '../asana-catalogo/asana-catalogo.repository';
import { AsanaConexoesService } from '../asana-conexoes/asana-conexoes.service';
import { CardsRepository } from '../cards/cards.repository';
import { IntegracaoService } from '../integracao/integracao.service';
import { SincronizacaoRepository } from '../integracao/sincronizacao.repository';
import { AsanaWebhooksRepository, WebhookRegistrado } from './asana-webhooks.repository';

const PROPOSITO_SEGREDO = 'asana:webhook_secret';

export interface ResultadoRecepcao {
  /** Preenchido apenas no handshake: deve voltar no header X-Hook-Secret. */
  segredoHandshake?: string;
  eventosAceitos: number;
}

@Injectable()
export class AsanaWebhooksService {
  private readonly logger = new Logger(AsanaWebhooksService.name);

  constructor(
    private readonly repo: AsanaWebhooksRepository,
    private readonly crypto: CryptoService,
    private readonly conexoes: AsanaConexoesService,
    private readonly catalogo: AsanaCatalogoRepository,
    private readonly cards: CardsRepository,
    private readonly sinc: SincronizacaoRepository,
    private readonly integracao: IntegracaoService,
    @Inject(CONFIG_APP) private readonly config: AppConfig,
  ) {}

  // ------------------------------------------------------------- registro

  /**
   * Registra um webhook no Asana para um projeto.
   *
   * O Asana responde ao POST fazendo uma chamada de handshake para a URL de
   * destino, com o header X-Hook-Secret. Por isso gravamos a linha local
   * ANTES de chamar o Asana: o handshake pode chegar antes da resposta.
   */
  async registrarParaProjeto(idUsuario: number, idProjeto: number): Promise<{ gid: string }> {
    if (!this.config.asana.webhookUrl) {
      throw new BadRequestException(
        'ASANA_WEBHOOK_URL nao configurada. O Asana exige uma URL HTTPS publica.',
      );
    }

    const projeto = await this.catalogo.projetoPorId(idProjeto);
    if (!projeto) throw new BadRequestException(`Projeto ${idProjeto} nao existe no catalogo.`);

    const { cliente, conexao } = await this.conexoes.criarClienteDoUsuario(idUsuario);

    const idLocal = await this.repo.criar({
      idConexao: conexao.id,
      idProjeto,
      recursoGid: projeto.asanaGid,
      tipoRecurso: 'project',
      urlDestino: this.config.asana.webhookUrl,
    });

    try {
      const webhook = await cliente.criarWebhook(projeto.asanaGid, this.config.asana.webhookUrl, [
        { resource_type: 'task', action: 'changed' },
        { resource_type: 'task', action: 'added' },
        { resource_type: 'task', action: 'removed' },
        { resource_type: 'task', action: 'deleted' },
        { resource_type: 'task', action: 'undeleted' },
        { resource_type: 'story', action: 'added' },
      ]);
      await this.repo.vincularGid(idLocal, webhook.gid);
      this.logger.log(`Webhook ${webhook.gid} registrado para o projeto ${projeto.nome}.`);
      return { gid: webhook.gid };
    } catch (erro) {
      await this.repo.remover(idLocal);
      throw erro;
    }
  }

  async remover(idUsuario: number, idLocal: number): Promise<void> {
    const webhook = await this.repo.porId(idLocal);
    if (!webhook) return;

    if (webhook.asanaWebhookGid) {
      const { cliente } = await this.conexoes.criarClienteDoUsuario(idUsuario);
      await cliente.excluirWebhook(webhook.asanaWebhookGid).catch((erro) => {
        this.logger.warn(`Webhook ja removido no Asana: ${(erro as Error).message}`);
      });
    }
    await this.repo.remover(idLocal);
  }

  listar(): Promise<WebhookRegistrado[]> {
    return this.repo.listar();
  }

  // ------------------------------------------------------------- recepcao

  /**
   * Recebe a chamada do Asana.
   *
   * Dois casos:
   *  1. handshake (X-Hook-Secret): guardamos o segredo cifrado e devolvemos
   *     o mesmo valor no header, sem corpo;
   *  2. entrega normal (X-Hook-Signature): validamos o HMAC sobre o corpo
   *     BRUTO e so entao aceitamos os eventos.
   */
  async receber(
    cabecalhos: Record<string, string | string[] | undefined>,
    corpoBruto: Buffer,
    corpo: { events?: unknown[] },
  ): Promise<ResultadoRecepcao> {
    const segredoHandshake = primeiro(cabecalhos['x-hook-secret']);

    if (segredoHandshake) {
      await this.concluirHandshake(segredoHandshake, corpo);
      return { segredoHandshake, eventosAceitos: 0 };
    }

    const assinatura = primeiro(cabecalhos['x-hook-signature']);
    if (!assinatura) {
      throw new BadRequestException('Requisicao sem X-Hook-Secret nem X-Hook-Signature.');
    }

    const eventos = Array.isArray(corpo.events) ? corpo.events : [];
    if (!eventos.length) return { eventosAceitos: 0 };

    const webhook = await this.localizarWebhookAssinante(corpoBruto, assinatura, eventos);
    if (!webhook) {
      // Nao dizemos qual parte falhou: a assinatura e a unica prova de origem.
      throw new BadRequestException('Assinatura do webhook invalida.');
    }

    await this.repo.registrarHeartbeat(webhook.id);

    let aceitos = 0;
    for (const evento of eventos as Record<string, any>[]) {
      const chave = montarChaveDeduplicacao(webhook.id, evento);
      const id = await this.repo.registrarEvento({
        idWebhook: webhook.id,
        chaveDeduplicacao: chave,
        recursoGid: evento?.resource?.gid ?? null,
        tipoRecurso: evento?.resource?.resource_type ?? null,
        acao: evento?.action ?? null,
        campoAlterado: evento?.change?.field ?? null,
        payload: evento,
      });
      if (id !== null) aceitos += 1;
    }

    return { eventosAceitos: aceitos };
  }

  private async concluirHandshake(segredo: string, corpo: unknown): Promise<void> {
    // O corpo do handshake traz o recurso; em algumas versoes vem vazio.
    const recursoGid =
      (corpo as any)?.data?.resource?.gid ?? (corpo as any)?.resource?.gid ?? null;

    const pendente = recursoGid
      ? await this.repo.pendenteDeHandshake(String(recursoGid))
      : await this.repo.pendenteDeHandshake('');

    if (!pendente) {
      // Guardamos o segredo no webhook mais recente sem segredo, porque o
      // handshake costuma chegar antes de o POST devolver o GID.
      const todos = await this.repo.listar();
      const alvo = todos.find((w) => !w.segredoCifrado);
      if (!alvo) {
        this.logger.warn('Handshake recebido sem webhook pendente correspondente.');
        return;
      }
      await this.guardarSegredo(alvo.id, segredo);
      return;
    }

    await this.guardarSegredo(pendente.id, segredo);
  }

  private async guardarSegredo(idWebhook: number, segredo: string): Promise<void> {
    const envelope = this.crypto.cifrar(segredo, PROPOSITO_SEGREDO);
    await this.repo.gravarSegredo(idWebhook, envelope);
    this.logger.log(`Segredo do webhook ${idWebhook} gravado (cifrado).`);
  }

  /**
   * Descobre qual webhook assinou a entrega. O Asana nao manda o GID do
   * webhook no corpo, entao testamos os candidatos pelo recurso do evento e,
   * em ultimo caso, todos os ativos.
   */
  private async localizarWebhookAssinante(
    corpoBruto: Buffer,
    assinatura: string,
    eventos: unknown[],
  ): Promise<WebhookRegistrado | null> {
    const candidatos = await this.repo.listar();

    for (const webhook of candidatos) {
      if (!webhook.ativo || !webhook.segredoCifrado) continue;
      let segredo: string;
      try {
        segredo = this.crypto.decifrar(
          webhook.segredoCifrado,
          PROPOSITO_SEGREDO,
          webhook.versaoChave ?? undefined,
        );
      } catch {
        continue;
      }
      if (assinaturaConfere(corpoBruto, segredo, assinatura)) return webhook;
    }

    this.logger.warn(
      `Entrega de webhook rejeitada: nenhuma assinatura conferiu (${eventos.length} evento(s)).`,
    );
    return null;
  }

  // ---------------------------------------------------------- processamento

  /**
   * Processa os eventos pendentes.
   *
   * Nunca confiamos na ordem nem no conteudo do evento: usamos o evento
   * apenas como aviso e buscamos o estado atual da tarefa no Asana.
   */
  async processarPendentes(limite = 50): Promise<number> {
    const eventos = await this.repo.eventosPendentes(limite);
    let processados = 0;

    for (const evento of eventos) {
      try {
        if (evento.tipoRecurso !== 'task' || !evento.recursoGid) {
          await this.repo.marcarEvento(evento.id, 'IGNORADO');
          continue;
        }

        const card = await this.cards.porGid(evento.recursoGid);
        if (!card) {
          // Tarefa que nao nasceu aqui: nao e do nosso interesse.
          await this.repo.marcarEvento(evento.id, 'IGNORADO');
          continue;
        }

        const webhook = evento.idWebhook ? await this.repo.porId(evento.idWebhook) : null;
        const idConexao = webhook?.idConexao;
        if (!idConexao) {
          await this.repo.marcarEvento(evento.id, 'ERRO', 'Webhook sem conexao associada.');
          continue;
        }

        if (evento.acao === 'deleted') {
          await this.sinc.registrarErroNoCard(
            card.id,
            'A tarefa foi apagada no Asana. O card continua aqui para o gestor decidir.',
            'CONFLITO',
          );
          await this.repo.marcarEvento(evento.id, 'PROCESSADO');
          processados += 1;
          continue;
        }

        const cliente = this.conexoes.criarCliente(idConexao);
        const tarefa = await cliente.tarefa(evento.recursoGid);
        await this.integracao.espelhar(card.id, tarefa);

        await this.repo.marcarEvento(evento.id, 'PROCESSADO');
        processados += 1;
      } catch (erro) {
        await this.repo.marcarEvento(evento.id, 'ERRO', (erro as Error).message);
        this.logger.warn(`Falha ao processar evento ${evento.id}: ${(erro as Error).message}`);
      }
    }

    return processados;
  }
}

function primeiro(valor: string | string[] | undefined): string | undefined {
  if (Array.isArray(valor)) return valor[0];
  return valor;
}

function assinaturaConfere(corpo: Buffer, segredo: string, assinatura: string): boolean {
  const esperada = createHmac('sha256', segredo).update(corpo).digest('hex');
  const a = Buffer.from(esperada, 'utf8');
  const b = Buffer.from(assinatura, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Chave de deduplicacao estavel.
 *
 * O Asana reenvia entregas quando nao recebe 200 rapido o bastante; sem esta
 * chave o mesmo evento seria processado varias vezes.
 */
function montarChaveDeduplicacao(idWebhook: number, evento: Record<string, any>): string {
  const partes = [
    idWebhook,
    evento?.resource?.gid ?? 'sem-recurso',
    evento?.action ?? 'sem-acao',
    evento?.change?.field ?? '',
    evento?.created_at ?? '',
  ];
  return partes.join(':').slice(0, 128);
}
