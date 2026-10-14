import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AppConfig, CONFIG_APP } from '../../common/config/configuration';
import { FirebirdService } from '../../database/firebird.service';

import { AsanaClient, ErroAsana } from '../../integrations/asana/asana.client';
import { AsanaConexoesService } from '../asana-conexoes/asana-conexoes.service';
import { ConexaoAsanaInterna } from '../asana-conexoes/asana-conexoes.repository';
import {
  EquipeAsanaDto,
  FiltroProjetosDto,
  ProjetoAsanaDto,
  ResultadoSincronizacaoDto,
  SecaoAsanaDto,
  WorkspaceDto,
} from './asana-catalogo.dto';
import { AsanaCatalogoRepository } from './asana-catalogo.repository';

/**
 * Traz o catalogo do Asana para o banco local.
 *
 * Regras que valem aqui:
 *  - o catalogo e compartilhado: uma linha por GID, nao por credencial;
 *  - nomes servem so para a escolha inicial; depois tudo opera por GID;
 *  - projetos privados podem nao aparecer para uma credencial e aparecer
 *    para outra, entao a sincronizacao acumula em vez de apagar.
 */
@Injectable()
export class AsanaCatalogoService {
  private readonly logger = new Logger(AsanaCatalogoService.name);
  private filaSincronizacao: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly repo: AsanaCatalogoRepository,
    private readonly conexoes: AsanaConexoesService,
    private readonly db: FirebirdService,
    @Inject(CONFIG_APP) private readonly config: AppConfig,
  ) {}

  // --------------------------------------------------------------- leitura

  listarWorkspaces(): Promise<WorkspaceDto[]> {
    return this.repo.listarWorkspaces();
  }

  listarEquipes(idWorkspace?: number): Promise<EquipeAsanaDto[]> {
    return this.repo.listarEquipes(idWorkspace);
  }

  listarProjetos(filtro: FiltroProjetosDto): Promise<ProjetoAsanaDto[]> {
    return this.repo.listarProjetos(filtro);
  }

  async obterProjeto(id: number): Promise<ProjetoAsanaDto> {
    const projeto = await this.repo.projetoPorId(id);
    if (!projeto) throw new NotFoundException(`Projeto ${id} nao encontrado no catalogo local.`);
    return projeto;
  }

  async listarSecoes(idProjeto: number, incluirInativas = false): Promise<SecaoAsanaDto[]> {
    await this.obterProjeto(idProjeto);
    return this.repo.listarSecoes(idProjeto, incluirInativas);
  }

  // --------------------------------------------------------- sincronizacao

  /** Sincroniza tudo que a credencial do gestor enxerga. */
  async sincronizarTudo(idUsuario: number): Promise<ResultadoSincronizacaoDto> {
    const { cliente, conexao } = await this.conexoes.criarClienteDoUsuario(idUsuario);
    return this.emSerie(() => this.sincronizar(cliente, conexao, `pelo usuario ${idUsuario}`));
  }

  /** Usada pelo agendamento: sincroniza com uma conexao especifica. */
  sincronizarComConexao(conexao: ConexaoAsanaInterna): Promise<ResultadoSincronizacaoDto> {
    const cliente = this.conexoes.criarCliente(conexao.id);
    return this.emSerie(() =>
      this.sincronizar(cliente, conexao, `pelo agendamento (conexao ${conexao.id})`),
    );
  }

  /**
   * Uma sincronizacao completa por vez neste processo. Duas leituras
   * simultaneas (botao + cron) disputariam os mesmos upserts por GID e
   * dobrariam o consumo do rate limit sem trazer nada novo.
   */
  private emSerie<T>(tarefa: () => Promise<T>): Promise<T> {
    const resultado = this.filaSincronizacao.then(tarefa);
    this.filaSincronizacao = resultado.catch(() => undefined);
    return resultado;
  }

  private async sincronizar(
    cliente: AsanaClient,
    conexao: ConexaoAsanaInterna,
    origem: string,
  ): Promise<ResultadoSincronizacaoDto> {
    const inicio = Date.now();
    const avisos: string[] = [];
    let equipes = 0;
    let projetos = 0;
    let secoes = 0;

    const workspaces = await cliente.workspaces();

    for (const workspace of workspaces) {
      const idWorkspace = await this.db.transacao((tx) =>
        this.repo.upsertWorkspace(tx, {
          gid: workspace.gid,
          nome: workspace.name ?? workspace.gid,
          tipo: workspace.resource_type ?? null,
        }),
      );

      const equipesAsana = await cliente.equipes(workspace.gid).catch((erro) => {
        avisos.push(`Equipes do workspace "${workspace.name}": ${mensagem(erro)}`);
        return [];
      });

      // Projetos sem equipe tambem precisam entrar, entao guardamos o mapa
      // GID da equipe -> id local e varremos o workspace inteiro depois.
      const mapaEquipes = new Map<string, number>();

      for (const equipe of equipesAsana) {
        const idEquipe = await this.db.transacao((tx) =>
          this.repo.upsertEquipe(tx, {
            idWorkspace,
            gid: equipe.gid,
            nome: equipe.name ?? equipe.gid,
          }),
        );
        mapaEquipes.set(equipe.gid, idEquipe);
        equipes += 1;
      }

      const projetosAsana = await cliente.projetosDoWorkspace(workspace.gid).catch((erro) => {
        avisos.push(`Projetos do workspace "${workspace.name}": ${mensagem(erro)}`);
        return [];
      });

      for (const projeto of projetosAsana) {
        const idProjeto = await this.db.transacao((tx) =>
          this.repo.upsertProjeto(tx, {
            idWorkspace,
            idEquipe: projeto.team?.gid ? (mapaEquipes.get(projeto.team.gid) ?? null) : null,
            gid: projeto.gid,
            nome: projeto.name ?? projeto.gid,
            descricao: projeto.notes ?? null,
            cor: projeto.color ?? null,
            layout: projeto.default_view ?? null,
            url: projeto.permalink_url ?? null,
            arquivado: projeto.archived === true,
            concluido: projeto.completed === true,
            modificadoEm: projeto.modified_at ? new Date(projeto.modified_at) : null,
          }),
        );
        projetos += 1;
        secoes += await this.sincronizarSecoesDoProjeto(cliente, idProjeto, projeto.gid, avisos);
      }
    }

    await this.conexoes.marcarSincronizada(conexao.id);

    const resultado: ResultadoSincronizacaoDto = {
      workspaces: workspaces.length,
      equipes,
      projetos,
      secoes,
      duracaoMs: Date.now() - inicio,
      avisos: avisos.length ? avisos : undefined,
    };
    this.logger.log(
      `Catalogo sincronizado ${origem}: ${projetos} projetos, ${secoes} secoes ` +
        `em ${resultado.duracaoMs}ms.`,
    );
    return resultado;
  }

  /** Sincroniza apenas um projeto e suas secoes (usado pelo webhook). */
  async sincronizarProjeto(idUsuario: number, idProjeto: number): Promise<SecaoAsanaDto[]> {
    const { cliente } = await this.conexoes.criarClienteDoUsuario(idUsuario);
    const local = await this.obterProjeto(idProjeto);
    const remoto = await cliente.projeto(local.asanaGid);

    const info = await this.repo.projetoPorGid(local.asanaGid);
    await this.db.transacao((tx) =>
      this.repo.upsertProjeto(tx, {
        idWorkspace: info!.idWorkspace,
        idEquipe: info!.idEquipe,
        gid: remoto.gid,
        nome: remoto.name ?? remoto.gid,
        descricao: remoto.notes ?? null,
        cor: remoto.color ?? null,
        layout: remoto.default_view ?? null,
        url: remoto.permalink_url ?? null,
        arquivado: remoto.archived === true,
        concluido: remoto.completed === true,
        modificadoEm: remoto.modified_at ? new Date(remoto.modified_at) : null,
      }),
    );

    await this.sincronizarSecoesDoProjeto(cliente, idProjeto, local.asanaGid, []);
    return this.repo.listarSecoes(idProjeto);
  }

  private async sincronizarSecoesDoProjeto(
    cliente: AsanaClient,
    idProjeto: number,
    gidProjeto: string,
    avisos: string[],
  ): Promise<number> {
    let secoes;
    try {
      secoes = await cliente.secoes(gidProjeto);
    } catch (erro) {
      avisos.push(`Secoes do projeto ${gidProjeto}: ${mensagem(erro)}`);
      return 0;
    }

    await this.db.transacao(async (tx) => {
      let ordem = 0;
      for (const secao of secoes) {
        await this.repo.upsertSecao(tx, {
          idProjeto,
          gid: secao.gid,
          nome: secao.name ?? secao.gid,
          ordem: ordem++,
        });
      }
      await this.repo.desativarSecoesAusentes(
        tx,
        idProjeto,
        secoes.map((s) => s.gid),
      );
    });

    return secoes.length;
  }

  /**
   * Procura por nome os projetos SPRINT e Backlog e as respectivas secoes.
   * Usado apenas no assistente de primeira configuracao da equipe.
   */
  async sugerirDestinos(idEquipe: number): Promise<{
    sprint?: { projeto: ProjetoAsanaDto; secao?: SecaoAsanaDto };
    backlog?: { projeto: ProjetoAsanaDto; secao?: SecaoAsanaDto };
    etapas: { codigo: string; nome: string; idSecao?: number; secaoNome?: string }[];
  }> {
    const projetos = await this.repo.listarProjetos({ idEquipe });
    const acharProjeto = (alvo: string) =>
      projetos.find((p) => normalizar(p.nome) === normalizar(alvo)) ??
      projetos.find((p) => normalizar(p.nome).includes(normalizar(alvo)));

    const projetoSprint = acharProjeto(this.config.asana.nomeProjetoSprint);
    const projetoBacklog = acharProjeto(this.config.asana.nomeProjetoBacklog);

    const secoesSprint = projetoSprint ? await this.repo.listarSecoes(projetoSprint.id) : [];
    const secoesBacklog = projetoBacklog ? await this.repo.listarSecoes(projetoBacklog.id) : [];

    const acharSecao = (lista: SecaoAsanaDto[], alvo: string) =>
      lista.find((s) => normalizar(s.nome) === normalizar(alvo)) ??
      lista.find((s) => normalizar(s.nome).includes(normalizar(alvo)));

    // Mapeia as oito colunas do quadro SPRINT pelo nome, ignorando acento.
    const etapasPadrao = await this.db.query<{ CODIGO: string; NOME: string }>(
      'SELECT CODIGO, NOME FROM ETAPAS_SPRINT ORDER BY ORDEM',
    );
    const etapas = etapasPadrao.map((e) => {
      const secao = acharSecao(secoesSprint, String(e.NOME));
      return {
        codigo: String(e.CODIGO),
        nome: String(e.NOME),
        idSecao: secao?.id,
        secaoNome: secao?.nome,
      };
    });

    return {
      sprint: projetoSprint
        ? {
            projeto: projetoSprint,
            secao: acharSecao(secoesSprint, this.config.asana.nomeSecaoSprint),
          }
        : undefined,
      backlog: projetoBacklog
        ? {
            projeto: projetoBacklog,
            secao: acharSecao(secoesBacklog, this.config.asana.nomeSecaoBacklog),
          }
        : undefined,
      etapas,
    };
  }
}

function normalizar(valor: string): string {
  return valor
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

function mensagem(erro: unknown): string {
  return erro instanceof ErroAsana ? erro.message : (erro as Error)?.message ?? String(erro);
}
