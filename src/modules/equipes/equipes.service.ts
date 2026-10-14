import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { UsuarioAutenticado } from '../../common/auth.types';
import { AsanaCatalogoRepository } from '../asana-catalogo/asana-catalogo.repository';
import { UsuariosService } from '../usuarios/usuarios.service';
import {
  AdicionarGestorDto,
  DefinirDestinosDto,
  DestinosEquipeDto,
  EquipeConfiguradaDto,
  EtapaConfiguradaDto,
  GestorDaEquipeDto,
  MapearEtapasDto,
} from './equipes.dto';
import { EquipesRepository } from './equipes.repository';

/**
 * Configuracao compartilhada da equipe: quem participa, para onde vao os
 * cards (SPRINT/A fazer e Backlog/Refino) e como as oito colunas do quadro
 * SPRINT se chamam neste Asana.
 */
@Injectable()
export class EquipesService {
  private readonly logger = new Logger(EquipesService.name);

  constructor(
    private readonly repo: EquipesRepository,
    private readonly catalogo: AsanaCatalogoRepository,
    private readonly usuarios: UsuariosService,
  ) {}

  listarMinhas(idUsuario: number): Promise<EquipeConfiguradaDto[]> {
    return this.repo.listarDoUsuario(idUsuario);
  }

  /**
   * Porta de entrada da autorizacao por equipe. O perfil no banco nao
   * substitui esta checagem: e ela que impede um gestor de mexer na
   * configuracao de uma equipe da qual nao participa.
   */
  async assegurarAcesso(
    idEquipe: number,
    usuario: UsuarioAutenticado,
    precisaEditar = false,
  ): Promise<void> {
    const equipe = await this.catalogo.equipePorId(idEquipe);
    if (!equipe) throw new NotFoundException(`Equipe ${idEquipe} nao encontrada.`);

    const acesso = await this.repo.acessoDoUsuario(idEquipe, usuario.id);

    // ADMIN administra qualquer equipe; os demais precisam ser membros.
    if (usuario.perfil === 'ADMIN') return;

    if (!acesso.participa) {
      throw new ForbiddenException(`Voce nao participa da equipe "${equipe.nome}".`);
    }
    if (precisaEditar && !acesso.podeEditar) {
      throw new ForbiddenException(
        `Voce tem acesso somente de leitura na equipe "${equipe.nome}".`,
      );
    }
  }

  // ------------------------------------------------------------- gestores

  async listarGestores(
    idEquipe: number,
    usuario: UsuarioAutenticado,
  ): Promise<GestorDaEquipeDto[]> {
    await this.assegurarAcesso(idEquipe, usuario);
    return this.repo.listarGestores(idEquipe);
  }

  async adicionarGestor(
    idEquipe: number,
    usuario: UsuarioAutenticado,
    dto: AdicionarGestorDto,
  ): Promise<GestorDaEquipeDto[]> {
    await this.assegurarAcesso(idEquipe, usuario, true);
    await this.usuarios.obterOuFalhar(dto.idUsuario);
    await this.repo.adicionarGestor(idEquipe, dto.idUsuario, dto.podeEditar ?? true);
    return this.repo.listarGestores(idEquipe);
  }

  async removerGestor(
    idEquipe: number,
    usuario: UsuarioAutenticado,
    idAlvo: number,
  ): Promise<void> {
    await this.assegurarAcesso(idEquipe, usuario, true);

    const acessoAlvo = await this.repo.acessoDoUsuario(idEquipe, idAlvo);
    if (acessoAlvo.podeEditar && (await this.repo.contarEditores(idEquipe)) <= 1) {
      throw new ConflictException(
        'Esta e a ultima pessoa com permissao de edicao na equipe. ' +
          'Promova outro gestor antes de remove-la.',
      );
    }
    await this.repo.removerGestor(idEquipe, idAlvo);
  }

  /**
   * Primeira entrada de um gestor numa equipe. Se a equipe ainda nao tem
   * ninguem, quem chega vira editor; se ja tem, o pedido precisa passar por
   * alguem que ja edita (ou por um ADMIN).
   */
  async entrarNaEquipe(idEquipe: number, usuario: UsuarioAutenticado): Promise<void> {
    const equipe = await this.catalogo.equipePorId(idEquipe);
    if (!equipe) throw new NotFoundException(`Equipe ${idEquipe} nao encontrada.`);

    const editores = await this.repo.contarEditores(idEquipe);
    if (editores > 0 && usuario.perfil !== 'ADMIN') {
      const acesso = await this.repo.acessoDoUsuario(idEquipe, usuario.id);
      if (!acesso.participa) {
        throw new ForbiddenException(
          `A equipe "${equipe.nome}" ja tem responsaveis. Peca a um deles (ou a um ADMIN) ` +
            'para adicionar voce.',
        );
      }
      return;
    }

    await this.repo.adicionarGestor(idEquipe, usuario.id, true);
    this.logger.log(`Usuario ${usuario.id} entrou na equipe ${idEquipe} como editor.`);
  }

  // ------------------------------------------------------------- destinos

  async obterDestinos(idEquipe: number, usuario: UsuarioAutenticado): Promise<DestinosEquipeDto> {
    await this.assegurarAcesso(idEquipe, usuario);
    const destinos = await this.repo.obterDestinos(idEquipe);
    if (!destinos) {
      throw new NotFoundException(
        'Esta equipe ainda nao tem destinos configurados. Defina o projeto SPRINT com a ' +
          'secao "A fazer" e o projeto Backlog com a secao "Refino".',
      );
    }
    return destinos;
  }

  async definirDestinos(
    idEquipe: number,
    usuario: UsuarioAutenticado,
    dto: DefinirDestinosDto,
  ): Promise<DestinosEquipeDto> {
    await this.assegurarAcesso(idEquipe, usuario, true);
    await this.validarProjetoDaEquipe(idEquipe, dto.idProjetoSprint, 'SPRINT');
    await this.validarProjetoDaEquipe(idEquipe, dto.idProjetoBacklog, 'Backlog');

    if (dto.idProjetoSprint === dto.idProjetoBacklog) {
      throw new BadRequestException('O projeto SPRINT e o Backlog precisam ser diferentes.');
    }

    await this.repo.gravarDestinos(idEquipe, dto);
    this.logger.log(`Destinos da equipe ${idEquipe} atualizados pelo usuario ${usuario.id}.`);
    return (await this.repo.obterDestinos(idEquipe))!;
  }

  private async validarProjetoDaEquipe(
    idEquipe: number,
    idProjeto: number,
    rotulo: string,
  ): Promise<void> {
    const projeto = await this.catalogo.projetoPorId(idProjeto);
    if (!projeto) {
      throw new BadRequestException(`Projeto ${rotulo} (${idProjeto}) nao existe no catalogo.`);
    }
    if (projeto.idEquipe !== idEquipe) {
      throw new BadRequestException(
        `O projeto "${projeto.nome}" nao pertence a esta equipe. Sincronize o catalogo e ` +
          'confira se escolheu o projeto certo.',
      );
    }
  }

  // --------------------------------------------------------------- etapas

  async listarEtapas(idEquipe: number, usuario: UsuarioAutenticado): Promise<EtapaConfiguradaDto[]> {
    await this.assegurarAcesso(idEquipe, usuario);
    return this.repo.listarEtapas(idEquipe);
  }

  async mapearEtapas(
    idEquipe: number,
    usuario: UsuarioAutenticado,
    dto: MapearEtapasDto,
  ): Promise<EtapaConfiguradaDto[]> {
    await this.assegurarAcesso(idEquipe, usuario, true);

    const destinos = await this.repo.obterDestinos(idEquipe);
    if (!destinos) {
      throw new BadRequestException(
        'Configure primeiro os destinos da equipe: o mapa de etapas depende do projeto SPRINT.',
      );
    }

    const secoesSprint = await this.catalogo.listarSecoes(destinos.idProjetoSprint, true);
    const validas = new Set(secoesSprint.map((s) => s.id));
    const vistas = new Set<number>();

    for (const etapa of dto.etapas) {
      if (!validas.has(etapa.idSecao)) {
        throw new BadRequestException(
          `A secao ${etapa.idSecao} informada para "${etapa.codigo}" nao pertence ao projeto SPRINT.`,
        );
      }
      // A UNIQUE de EQUIPE_ETAPAS.ID_ASANA_SECAO ja impede isso no banco;
      // aqui a mensagem sai muito mais clara.
      if (vistas.has(etapa.idSecao)) {
        throw new BadRequestException(
          `A secao ${etapa.idSecao} foi mapeada para mais de uma etapa. Cada coluna do quadro ` +
            'corresponde a exatamente uma etapa.',
        );
      }
      vistas.add(etapa.idSecao);
    }

    await this.repo.gravarEtapas(idEquipe, dto.etapas);
    return this.repo.listarEtapas(idEquipe);
  }

  etapaPorSecao(idSecao: number): Promise<string | null> {
    return this.repo.etapaPorSecao(idSecao);
  }
}
