import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { UsuarioAutenticado } from '../../common/auth.types';
import { PaginacaoDto, RespostaPaginadaDto } from '../../common/dto';
import { AsanaConexoesRepository } from '../asana-conexoes/asana-conexoes.repository';
import { EquipesRepository } from '../equipes/equipes.repository';
import { EquipesService } from '../equipes/equipes.service';
import { ProjetosService } from '../projetos/projetos.service';
import {
  AtualizarRoadmapDto,
  CriarRoadmapDto,
  FiltroRoadmapsDto,
  ResultadoConclusaoDto,
  ResultadoVinculoDto,
  RoadmapDto,
  VincularRoadmapAsanaDto,
} from './roadmaps.dto';
import { RoadmapsRepository } from './roadmaps.repository';

type DadosBasicos = NonNullable<Awaited<ReturnType<RoadmapsRepository['dadosBasicos']>>>;

const DIA_MS = 86_400_000;

@Injectable()
export class RoadmapsService {
  private readonly logger = new Logger(RoadmapsService.name);

  constructor(
    private readonly repo: RoadmapsRepository,
    private readonly equipes: EquipesService,
    private readonly equipesRepo: EquipesRepository,
    private readonly conexoes: AsanaConexoesRepository,
    private readonly projetos: ProjetosService,
  ) {}

  // -------------------------------------------------------------- leitura

  async listar(
    filtro: FiltroRoadmapsDto,
    paginacao: PaginacaoDto,
    usuario: UsuarioAutenticado,
  ): Promise<RespostaPaginadaDto<RoadmapDto>> {
    const visiveis = await this.visibilidade(usuario);
    const { itens, total } = await this.repo.listar(
      filtro,
      visiveis,
      paginacao.offset,
      paginacao.tamanho,
    );
    return RespostaPaginadaDto.de(itens, total, paginacao);
  }

  async obter(id: number, usuario: UsuarioAutenticado): Promise<RoadmapDto> {
    await this.assegurarLeitura(id, usuario);
    return (await this.repo.porId(id))!;
  }

  /**
   * Roadmap vinculado e visivel a toda a equipe do Asana; roadmap local, so
   * ao gestor. ADMIN ve tudo (null).
   */
  async visibilidade(
    usuario: UsuarioAutenticado,
  ): Promise<{ equipes: number[]; idUsuario: number } | null> {
    if (usuario.perfil === 'ADMIN') return null;
    const equipes = await this.equipesRepo.listarDoUsuario(usuario.id);
    return { equipes: equipes.map((e) => e.id), idUsuario: usuario.id };
  }

  /** Leitura: equipe do Asana quando vinculado; gestor/ADMIN quando local. */
  private async assegurarAcessoBasico(
    basico: DadosBasicos,
    usuario: UsuarioAutenticado,
    precisaEditar: boolean,
  ): Promise<void> {
    if (basico.idEquipe !== null) {
      await this.equipes.assegurarAcesso(basico.idEquipe, usuario, precisaEditar);
      return;
    }
    if (basico.idGestor !== usuario.id && usuario.perfil !== 'ADMIN') {
      throw new ForbiddenException(
        'Este roadmap ainda e so local: apenas o gestor dono (ou um ADMIN) tem acesso.',
      );
    }
  }

  /**
   * Politica de escrita: o gestor dono edita/conclui/exclui o proprio
   * roadmap; ADMIN pode administrar qualquer um. Participar da equipe da
   * direito de ver, nao de alterar o roadmap alheio.
   */
  private async assegurarEdicao(
    id: number,
    usuario: UsuarioAutenticado,
  ): Promise<DadosBasicos> {
    const basico = await this.repo.dadosBasicos(id);
    if (!basico) throw new NotFoundException(`Roadmap ${id} nao encontrado.`);

    await this.assegurarAcessoBasico(basico, usuario, true);

    if (basico.idGestor !== usuario.id && usuario.perfil !== 'ADMIN') {
      throw new ForbiddenException(
        'Somente o gestor dono do roadmap (ou um ADMIN) pode altera-lo.',
      );
    }
    return basico;
  }

  // --------------------------------------------------------------- escrita

  /**
   * Cria sempre como roadmap local. Com idAsanaEquipe, valida o vinculo
   * ANTES de gravar (para nao sobrar um roadmap local se o vinculo falhar)
   * e vincula logo em seguida.
   */
  async criar(dto: CriarRoadmapDto, usuario: UsuarioAutenticado): Promise<RoadmapDto> {
    const { inicio, fim } = this.validarPeriodo(dto.dataInicio, dto.dataFim);

    const projeto = await this.projetos.obter(dto.idProjeto);
    if (projeto.arquivado) {
      throw new BadRequestException(`O projeto "${projeto.nome}" esta arquivado.`);
    }

    const vinculo = dto.idAsanaEquipe
      ? await this.prepararVinculo(
          { idProjeto: projeto.id, idGestor: usuario.id },
          {
            idAsanaEquipe: dto.idAsanaEquipe,
            idProjetoAsana: dto.idProjetoContexto,
            idAsanaConexao: dto.idAsanaConexao,
          },
          usuario,
        )
      : null;

    const id = await this.repo.criar({
      idGestor: usuario.id,
      idProjeto: projeto.id,
      titulo: dto.titulo,
      objetivo: dto.objetivo,
      dataInicio: inicio,
      dataFim: fim,
      situacao: dto.situacao ?? 'RASCUNHO',
    });

    if (vinculo) {
      await this.repo.vincularAsana({ idRoadmap: id, idUsuario: usuario.id, ...vinculo });
    }

    this.logger.log(
      `Roadmap ${id} criado por ${usuario.email} no projeto ${projeto.id} ` +
        `(${vinculo ? `vinculado a equipe ${vinculo.idEquipe}` : 'somente local'}).`,
    );
    return (await this.repo.porId(id))!;
  }

  /** Liga um roadmap local ao Asana; os cards existentes viram tarefas. */
  async vincularAsana(
    id: number,
    dto: VincularRoadmapAsanaDto,
    usuario: UsuarioAutenticado,
  ): Promise<ResultadoVinculoDto> {
    const basico = await this.assegurarEdicao(id, usuario);
    if (basico.idEquipe !== null) {
      throw new ConflictException('Este roadmap ja esta vinculado ao Asana.');
    }
    if (['CONCLUIDO', 'CANCELADO'].includes(basico.situacao)) {
      throw new BadRequestException('Roadmap concluido ou cancelado nao pode ser vinculado.');
    }

    const vinculo = await this.prepararVinculo(basico, dto, usuario);
    const cardsEnfileirados = await this.repo.vincularAsana({
      idRoadmap: id,
      idUsuario: usuario.id,
      ...vinculo,
    });

    this.logger.log(
      `Roadmap ${id} vinculado a equipe ${vinculo.idEquipe} por ${usuario.email}; ` +
        `${cardsEnfileirados} card(s) enfileirado(s).`,
    );
    return {
      mensagem: cardsEnfileirados
        ? `Roadmap vinculado. ${cardsEnfileirados} card(s) serao criados no Asana pela fila.`
        : 'Roadmap vinculado. Os proximos cards ja serao criados no Asana.',
      cardsEnfileirados,
      roadmap: (await this.repo.porId(id))!,
    };
  }

  /**
   * Valida tudo que o vinculo exige e resolve os ids. As triggers repetem
   * parte disto, mas com mensagens genericas.
   *  - o gestor do roadmap edita a equipe e a equipe tem destinos;
   *  - o projeto do Asana e da equipe e casa com o vinculo do projeto local;
   *  - a conexao e do gestor (a BIU_ROADMAPS exige).
   */
  private async prepararVinculo(
    roadmap: { idProjeto: number; idGestor: number },
    dto: { idAsanaEquipe: number; idProjetoAsana?: number; idAsanaConexao?: number },
    usuario: UsuarioAutenticado,
  ): Promise<{
    idProjeto: number;
    vincularProjeto: boolean;
    idConexao: number;
    idEquipe: number;
    idProjetoAsana: number;
  }> {
    await this.equipes.assegurarAcesso(dto.idAsanaEquipe, usuario, true);
    const gestorEdita = await this.equipesRepo.acessoDoUsuario(dto.idAsanaEquipe, roadmap.idGestor);
    if (!gestorEdita.participa || !gestorEdita.podeEditar) {
      throw new BadRequestException(
        'O gestor do roadmap precisa participar da equipe do Asana (como editor) para vincular.',
      );
    }

    const destinos = await this.equipesRepo.obterDestinos(dto.idAsanaEquipe);
    if (!destinos) {
      throw new BadRequestException(
        'Esta equipe ainda nao tem os destinos configurados. Defina SPRINT/"A fazer" e ' +
          'Backlog/"Refino" em Equipes e destinos antes de vincular.',
      );
    }

    const projetoLocal = await this.projetos.obter(roadmap.idProjeto);
    const idProjetoAsana = dto.idProjetoAsana ?? projetoLocal.idAsanaProjeto ?? null;
    if (!idProjetoAsana) {
      throw new BadRequestException(
        `O projeto "${projetoLocal.nome}" ainda nao esta vinculado a um projeto do Asana. ` +
          'Escolha o projeto do Asana que servira de contexto.',
      );
    }
    if (projetoLocal.idAsanaProjeto && projetoLocal.idAsanaProjeto !== idProjetoAsana) {
      throw new ConflictException(
        `O projeto "${projetoLocal.nome}" ja esta vinculado ao projeto ` +
          `"${projetoLocal.asanaProjetoNome}" do Asana; use esse mesmo projeto.`,
      );
    }

    const asana = await this.projetos.validarProjetoAsanaLivre(idProjetoAsana, projetoLocal.id);
    if (asana.idEquipe !== dto.idAsanaEquipe) {
      throw new BadRequestException(`O projeto "${asana.nome}" do Asana nao pertence a equipe escolhida.`);
    }

    const idConexao = await this.resolverConexao(roadmap.idGestor, dto.idAsanaConexao);

    return {
      idProjeto: projetoLocal.id,
      vincularProjeto: !projetoLocal.idAsanaProjeto,
      idConexao,
      idEquipe: dto.idAsanaEquipe,
      idProjetoAsana,
    };
  }

  async atualizar(
    id: number,
    dto: AtualizarRoadmapDto,
    usuario: UsuarioAutenticado,
  ): Promise<RoadmapDto> {
    await this.assegurarEdicao(id, usuario);
    const atual = (await this.repo.porId(id))!;

    const campos: Record<string, unknown> = {};
    if (dto.titulo !== undefined) campos.TITULO = dto.titulo;
    if (dto.objetivo !== undefined) campos.OBJETIVO = dto.objetivo;
    if (dto.situacao !== undefined) campos.SITUACAO = dto.situacao;

    if (dto.dataInicio !== undefined || dto.dataFim !== undefined) {
      const { inicio, fim } = this.validarPeriodo(
        dto.dataInicio ?? atual.dataInicio,
        dto.dataFim ?? atual.dataFim,
      );
      campos.DATA_INICIO = inicio;
      campos.DATA_FIM = fim;
    }

    await this.repo.atualizar(id, campos);

    // Trocar o titulo do roadmap muda o padrao de titulo dos cards novos,
    // mas nao reescreve os cards ja criados: eles sao espelho do Asana e
    // podem ter sido editados la. Renomear em massa e acao explicita.
    if (dto.titulo !== undefined && dto.titulo !== atual.titulo) {
      this.logger.log(
        `Roadmap ${id} renomeado. Cards existentes mantem o titulo atual no Asana; ` +
          'use a rota de regenerar titulo em cada card se quiser propagar.',
      );
    }

    return (await this.repo.porId(id))!;
  }

  async solicitarConclusao(
    id: number,
    usuario: UsuarioAutenticado,
  ): Promise<ResultadoConclusaoDto> {
    await this.assegurarEdicao(id, usuario);

    const pendentesAntes = await this.repo.contarCardsPendentes(id);
    // A procedure valida roadmap vazio/encerrado e enfileira tudo.
    await this.repo.solicitarConclusao(id, usuario.id);

    const depois = (await this.repo.porId(id))!;
    return {
      mensagem:
        pendentesAntes === 0
          ? 'Roadmap concluido: todos os cards ja estavam concluidos.'
          : `Conclusao solicitada. ${pendentesAntes} card(s) serao concluidos no Asana pelos ` +
            'workers; o roadmap fecha quando o Asana confirmar todos.',
      situacao: depois.situacao,
      cardsEnfileirados: pendentesAntes,
    };
  }

  async excluir(id: number, usuario: UsuarioAutenticado): Promise<void> {
    await this.assegurarEdicao(id, usuario);
    // Exclusao logica imediata + fila remota. A purga fisica so acontece
    // depois que o Asana confirmar a remocao de cada card (trigger BD_*).
    await this.repo.excluir(id, usuario.id);
    this.logger.log(`Roadmap ${id} excluido por ${usuario.email}; cards enfileirados.`);
  }

  /** Usada pelos cards para autorizar alteracoes sem duplicar regra. */
  async assegurarEdicaoDeCard(
    idRoadmap: number,
    usuario: UsuarioAutenticado,
  ): Promise<DadosBasicos> {
    return this.assegurarEdicao(idRoadmap, usuario);
  }

  async assegurarLeitura(idRoadmap: number, usuario: UsuarioAutenticado): Promise<void> {
    const basico = await this.repo.dadosBasicos(idRoadmap);
    if (!basico) throw new NotFoundException(`Roadmap ${idRoadmap} nao encontrado.`);
    await this.assegurarAcessoBasico(basico, usuario, false);
  }

  // ------------------------------------------------------------ validacao

  /** Minimo de uma semana, maximo de tres meses. O CHECK do banco repete isso. */
  private validarPeriodo(dataInicio: string, dataFim: string): { inicio: Date; fim: Date } {
    const inicio = paraData(dataInicio);
    const fim = paraData(dataFim);

    if (!inicio || !fim) {
      throw new BadRequestException('Datas invalidas. Use o formato AAAA-MM-DD.');
    }

    const minimo = new Date(inicio.getTime() + 7 * DIA_MS);
    const maximo = new Date(inicio);
    maximo.setMonth(maximo.getMonth() + 3);

    if (fim < minimo) {
      throw new BadRequestException(
        `O periodo minimo de um roadmap e de uma semana. Com inicio em ${dataInicio}, ` +
          `a data fim precisa ser ${formatar(minimo)} ou depois.`,
      );
    }
    if (fim > maximo) {
      throw new BadRequestException(
        `O periodo maximo de um roadmap e de tres meses. Com inicio em ${dataInicio}, ` +
          `a data fim precisa ser ${formatar(maximo)} ou antes.`,
      );
    }

    return { inicio, fim };
  }

  private async resolverConexao(idUsuario: number, idInformado?: number): Promise<number> {
    if (idInformado) {
      const conexao = await this.conexoes.porId(idInformado);
      if (!conexao || conexao.idUsuario !== idUsuario) {
        throw new BadRequestException(
          'A conexao Asana informada nao existe ou nao pertence ao gestor do roadmap.',
        );
      }
      if (!conexao.ativo) {
        throw new BadRequestException(`A conexao "${conexao.nome}" esta desativada.`);
      }
      return conexao.id;
    }

    const padrao = await this.conexoes.padraoDoUsuario(idUsuario);
    if (!padrao) {
      throw new BadRequestException(
        'O gestor do roadmap ainda nao conectou o Asana. Conecte uma conta em Conexoes ' +
          'Asana antes de vincular.',
      );
    }
    return padrao.id;
  }
}

function paraData(valor: string): Date | null {
  const partes = valor.slice(0, 10).split('-').map(Number);
  if (partes.length !== 3 || partes.some(Number.isNaN)) return null;
  const data = new Date(partes[0], partes[1] - 1, partes[2]);
  return Number.isNaN(data.getTime()) ? null : data;
}

function formatar(data: Date): string {
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const dia = String(data.getDate()).padStart(2, '0');
  return `${data.getFullYear()}-${mes}-${dia}`;
}
