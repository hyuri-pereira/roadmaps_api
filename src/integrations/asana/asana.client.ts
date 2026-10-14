import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { mascararSegredos } from '../../common/utils';
import {
  AsanaEquipe,
  AsanaEvento,
  AsanaProjeto,
  AsanaSecao,
  AsanaTarefa,
  AsanaUsuario,
  AsanaWebhook,
  AsanaWorkspace,
  CAMPOS_PROJETO,
  CAMPOS_SECAO,
  CAMPOS_TAREFA,
} from './asana.types';

export class ErroAsana extends HttpException {
  constructor(
    mensagem: string,
    readonly statusAsana: number,
    readonly retryAfterSegundos?: number,
    readonly corpo?: unknown,
  ) {
    super(mensagem, mapearStatus(statusAsana));
  }

  /** Erros que fazem sentido tentar de novo mais tarde. */
  get temporario(): boolean {
    return this.statusAsana === 429 || this.statusAsana >= 500 || this.statusAsana === 0;
  }
}

function mapearStatus(status: number): number {
  if (status === 401) return HttpStatus.UNAUTHORIZED;
  if (status === 403) return HttpStatus.FORBIDDEN;
  if (status === 404) return HttpStatus.NOT_FOUND;
  if (status === 429) return HttpStatus.TOO_MANY_REQUESTS;
  if (status >= 500) return HttpStatus.BAD_GATEWAY;
  return HttpStatus.BAD_REQUEST;
}

export interface OpcoesClienteAsana {
  baseUrl: string;
  timeoutMs: number;
  rateLimitPorMinuto: number;
  /** Resolve o token valido no momento da chamada (pode disparar refresh). */
  obterToken: () => Promise<string>;
  /** Recebe cada requisicao concluida, para gravar em INTEGRACAO_LOGS. */
  aoRegistrar?: (registro: RegistroChamadaAsana) => void;
}

export interface RegistroChamadaAsana {
  metodo: string;
  caminho: string;
  status: number;
  duracaoMs: number;
  requisicao?: unknown;
  resposta?: unknown;
  erro?: string;
}

/**
 * Cliente da API do Asana para UMA conexao (um gestor).
 *
 * Cada instancia tem seu proprio limitador, porque o limite do Asana e por
 * token. O cliente nunca e compartilhado entre gestores.
 */
export class AsanaClient {
  private readonly logger = new Logger(AsanaClient.name);
  private readonly http: AxiosInstance;
  private readonly janela: number[] = [];

  constructor(private readonly opcoes: OpcoesClienteAsana) {
    this.http = axios.create({
      baseURL: opcoes.baseUrl,
      timeout: opcoes.timeoutMs,
      headers: { Accept: 'application/json' },
      // Tratamos o status manualmente para montar ErroAsana com Retry-After.
      validateStatus: () => true,
    });
  }

  // ------------------------------------------------------------------
  // Usuario / catalogo
  // ------------------------------------------------------------------

  async eu(): Promise<AsanaUsuario> {
    return this.obter<AsanaUsuario>('/users/me', {
      opt_fields: 'gid,name,email,photo.image_60x60,workspaces,workspaces.name',
    });
  }

  async workspaces(): Promise<AsanaWorkspace[]> {
    return this.listarTudo<AsanaWorkspace>('/workspaces', {
      opt_fields: 'gid,name,is_organization,resource_type',
    });
  }

  async equipes(gidWorkspace: string): Promise<AsanaEquipe[]> {
    // /users/me/teams devolve so as equipes que o token realmente enxerga,
    // o que evita 403 mais adiante ao operar em equipe sem acesso.
    return this.listarTudo<AsanaEquipe>('/users/me/teams', {
      workspace: gidWorkspace,
      opt_fields: 'gid,name,organization,organization.name',
    });
  }

  async projetosDaEquipe(gidEquipe: string): Promise<AsanaProjeto[]> {
    return this.listarTudo<AsanaProjeto>(`/teams/${gidEquipe}/projects`, {
      opt_fields: CAMPOS_PROJETO,
      archived: false,
    });
  }

  async projetosDoWorkspace(gidWorkspace: string): Promise<AsanaProjeto[]> {
    return this.listarTudo<AsanaProjeto>('/projects', {
      workspace: gidWorkspace,
      opt_fields: CAMPOS_PROJETO,
      archived: false,
    });
  }

  async projeto(gid: string): Promise<AsanaProjeto> {
    return this.obter<AsanaProjeto>(`/projects/${gid}`, { opt_fields: CAMPOS_PROJETO });
  }

  async secoes(gidProjeto: string): Promise<AsanaSecao[]> {
    return this.listarTudo<AsanaSecao>(`/projects/${gidProjeto}/sections`, {
      opt_fields: CAMPOS_SECAO,
    });
  }

  // ------------------------------------------------------------------
  // Tarefas
  // ------------------------------------------------------------------

  async tarefa(gid: string): Promise<AsanaTarefa> {
    return this.obter<AsanaTarefa>(`/tasks/${gid}`, { opt_fields: CAMPOS_TAREFA });
  }

  async criarTarefa(dados: {
    workspace: string;
    projeto: string;
    nome: string;
    notas: string;
    prazo?: string | null;
  }): Promise<AsanaTarefa> {
    const corpo: Record<string, unknown> = {
      workspace: dados.workspace,
      projects: [dados.projeto],
      name: dados.nome,
      notes: dados.notas,
    };
    if (dados.prazo) corpo.due_on = dados.prazo;

    return this.enviar<AsanaTarefa>('POST', '/tasks', corpo, { opt_fields: CAMPOS_TAREFA });
  }

  async atualizarTarefa(
    gid: string,
    dados: { nome?: string; notas?: string; prazo?: string | null; concluida?: boolean },
  ): Promise<AsanaTarefa> {
    const corpo: Record<string, unknown> = {};
    if (dados.nome !== undefined) corpo.name = dados.nome;
    if (dados.notas !== undefined) corpo.notes = dados.notas;
    if (dados.prazo !== undefined) corpo.due_on = dados.prazo;
    if (dados.concluida !== undefined) corpo.completed = dados.concluida;

    return this.enviar<AsanaTarefa>('PUT', `/tasks/${gid}`, corpo, { opt_fields: CAMPOS_TAREFA });
  }

  async excluirTarefa(gid: string): Promise<void> {
    await this.enviar('DELETE', `/tasks/${gid}`);
  }

  /** Move a tarefa para uma secao (tambem serve para entrar no projeto). */
  async moverParaSecao(gidTarefa: string, gidSecao: string): Promise<void> {
    await this.enviar('POST', `/sections/${gidSecao}/addTask`, { task: gidTarefa });
  }

  async adicionarAoProjeto(
    gidTarefa: string,
    gidProjeto: string,
    gidSecao?: string | null,
  ): Promise<void> {
    const corpo: Record<string, unknown> = { project: gidProjeto };
    if (gidSecao) corpo.section = gidSecao;
    await this.enviar('POST', `/tasks/${gidTarefa}/addProject`, corpo);
  }

  async removerDoProjeto(gidTarefa: string, gidProjeto: string): Promise<void> {
    await this.enviar('POST', `/tasks/${gidTarefa}/removeProject`, { project: gidProjeto });
  }

  /**
   * Procura uma tarefa criada por nos que talvez tenha sido criada apesar de
   * um timeout. Sem isso, repetir um POST que "falhou" duplicaria o card.
   */
  async procurarTarefaPorMarcador(
    gidWorkspace: string,
    marcador: string,
  ): Promise<AsanaTarefa | null> {
    const resultados = await this.obter<AsanaTarefa[]>(
      `/workspaces/${gidWorkspace}/tasks/search`,
      { text: marcador, limit: 20, opt_fields: CAMPOS_TAREFA },
    );
    if (!Array.isArray(resultados)) return null;
    return resultados.find((t) => (t.notes ?? '').includes(marcador)) ?? null;
  }

  // ------------------------------------------------------------------
  // Webhooks e eventos
  // ------------------------------------------------------------------

  async webhooks(gidWorkspace: string): Promise<AsanaWebhook[]> {
    return this.listarTudo<AsanaWebhook>('/webhooks', {
      workspace: gidWorkspace,
      opt_fields: 'gid,active,resource,resource.name,target,last_success_at',
    });
  }

  async criarWebhook(
    gidRecurso: string,
    urlDestino: string,
    filtros?: Record<string, unknown>[],
  ): Promise<AsanaWebhook> {
    const corpo: Record<string, unknown> = { resource: gidRecurso, target: urlDestino };
    if (filtros?.length) corpo.filters = filtros;
    return this.enviar<AsanaWebhook>('POST', '/webhooks', corpo);
  }

  async excluirWebhook(gid: string): Promise<void> {
    await this.enviar('DELETE', `/webhooks/${gid}`);
  }

  /**
   * API de eventos. Serve como rede de seguranca quando o webhook nao chega.
   * O primeiro chamado sem sync devolve 412 com um token novo.
   */
  async eventos(
    gidRecurso: string,
    syncToken?: string | null,
  ): Promise<{ eventos: AsanaEvento[]; sync: string | null; expirado: boolean }> {
    const parametros: Record<string, unknown> = { resource: gidRecurso };
    if (syncToken) parametros.sync = syncToken;

    const resposta = await this.requisitar('GET', '/events', undefined, parametros, true);

    if (resposta.status === 412) {
      return { eventos: [], sync: resposta.data?.sync ?? null, expirado: true };
    }
    this.validarResposta(resposta, 'GET', '/events');
    return {
      eventos: resposta.data?.data ?? [],
      sync: resposta.data?.sync ?? null,
      expirado: false,
    };
  }

  // ------------------------------------------------------------------
  // Infra HTTP
  // ------------------------------------------------------------------

  private async obter<T>(caminho: string, parametros?: Record<string, unknown>): Promise<T> {
    const resposta = await this.requisitar('GET', caminho, undefined, parametros);
    this.validarResposta(resposta, 'GET', caminho);
    return resposta.data?.data as T;
  }

  private async enviar<T = unknown>(
    metodo: 'POST' | 'PUT' | 'DELETE',
    caminho: string,
    corpo?: Record<string, unknown>,
    parametros?: Record<string, unknown>,
  ): Promise<T> {
    const resposta = await this.requisitar(
      metodo,
      caminho,
      corpo ? { data: corpo } : undefined,
      parametros,
    );
    this.validarResposta(resposta, metodo, caminho);
    return resposta.data?.data as T;
  }

  /** Segue next_page ate o fim. O Asana pagina quase tudo. */
  private async listarTudo<T>(
    caminho: string,
    parametros: Record<string, unknown> = {},
  ): Promise<T[]> {
    const itens: T[] = [];
    let offset: string | undefined;

    do {
      const resposta = await this.requisitar('GET', caminho, undefined, {
        ...parametros,
        limit: 100,
        ...(offset ? { offset } : {}),
      });
      this.validarResposta(resposta, 'GET', caminho);
      itens.push(...((resposta.data?.data ?? []) as T[]));
      offset = resposta.data?.next_page?.offset ?? undefined;
    } while (offset);

    return itens;
  }

  private async requisitar(
    metodo: string,
    caminho: string,
    corpo?: unknown,
    parametros?: Record<string, unknown>,
    permitir412 = false,
  ) {
    await this.respeitarRateLimit();

    const token = await this.opcoes.obterToken();
    const inicio = Date.now();

    const config: AxiosRequestConfig = {
      method: metodo,
      url: caminho,
      params: parametros,
      data: corpo,
      headers: { Authorization: `Bearer ${token}` },
    };

    let resposta;
    try {
      resposta = await this.http.request(config);
    } catch (erro: any) {
      const registro: RegistroChamadaAsana = {
        metodo,
        caminho,
        status: 0,
        duracaoMs: Date.now() - inicio,
        requisicao: mascararSegredos(corpo),
        erro: erro?.message,
      };
      this.opcoes.aoRegistrar?.(registro);
      throw new ErroAsana(`Falha de rede ao chamar o Asana: ${erro?.message}`, 0);
    }

    this.opcoes.aoRegistrar?.({
      metodo,
      caminho,
      status: resposta.status,
      duracaoMs: Date.now() - inicio,
      requisicao: mascararSegredos(corpo),
      resposta:
        resposta.status >= 400 || permitir412 ? mascararSegredos(resposta.data) : undefined,
    });

    return resposta;
  }

  private validarResposta(resposta: any, metodo: string, caminho: string): void {
    if (resposta.status >= 200 && resposta.status < 300) return;

    const mensagem =
      resposta.data?.errors?.map((e: any) => e.message).join('; ') ??
      `HTTP ${resposta.status} em ${metodo} ${caminho}`;

    const retryAfter = Number(resposta.headers?.['retry-after']);
    throw new ErroAsana(
      mensagem,
      resposta.status,
      Number.isFinite(retryAfter) ? retryAfter : undefined,
      resposta.data,
    );
  }

  /** Janela deslizante de 60s, um pouco abaixo do limite real do Asana. */
  private async respeitarRateLimit(): Promise<void> {
    const limite = this.opcoes.rateLimitPorMinuto;
    for (;;) {
      const agora = Date.now();
      while (this.janela.length && agora - this.janela[0] > 60_000) this.janela.shift();
      if (this.janela.length < limite) {
        this.janela.push(agora);
        return;
      }
      const espera = 60_000 - (agora - this.janela[0]) + 50;
      this.logger.debug(`Limite de requisicoes do Asana atingido; aguardando ${espera}ms`);
      await new Promise((r) => setTimeout(r, espera));
    }
  }
}
