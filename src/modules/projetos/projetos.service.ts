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
import {
  AtualizarProjetoDto,
  CriarProjetoDto,
  FiltroProjetosLocaisDto,
  ProjetoDto,
} from './projetos.dto';
import { ProjetosRepository } from './projetos.repository';

/**
 * Projetos locais: organizam roadmaps sem depender do Asana.
 *
 * Todos os usuarios enxergam a lista (e so um agrupador, como o catalogo);
 * editar, arquivar e vincular fica com quem criou ou com um ADMIN.
 */
@Injectable()
export class ProjetosService {
  private readonly logger = new Logger(ProjetosService.name);

  constructor(
    private readonly repo: ProjetosRepository,
    private readonly catalogo: AsanaCatalogoRepository,
  ) {}

  listar(filtro: FiltroProjetosLocaisDto): Promise<ProjetoDto[]> {
    return this.repo.listar(filtro);
  }

  async obter(id: number): Promise<ProjetoDto> {
    const projeto = await this.repo.porId(id);
    if (!projeto) throw new NotFoundException(`Projeto ${id} nao encontrado.`);
    return projeto;
  }

  async criar(dto: CriarProjetoDto, usuario: UsuarioAutenticado): Promise<ProjetoDto> {
    const id = await this.repo.criar({
      nome: dto.nome.trim(),
      descricao: dto.descricao?.trim() || null,
      cor: dto.cor ?? null,
      idCriador: usuario.id,
    });
    this.logger.log(`Projeto local ${id} criado por ${usuario.email}.`);
    return this.obter(id);
  }

  async atualizar(
    id: number,
    dto: AtualizarProjetoDto,
    usuario: UsuarioAutenticado,
  ): Promise<ProjetoDto> {
    await this.assegurarEdicao(id, usuario);
    const campos: Record<string, unknown> = {};
    if (dto.nome !== undefined) campos.NOME = dto.nome.trim();
    if (dto.descricao !== undefined) campos.DESCRICAO = dto.descricao?.trim() || null;
    if (dto.cor !== undefined) campos.COR = dto.cor;
    if (dto.arquivado !== undefined) campos.ARQUIVADO = dto.arquivado;
    await this.repo.atualizar(id, campos);
    return this.obter(id);
  }

  /**
   * Liga (ou desliga) o projeto local a um projeto do catalogo do Asana.
   * Roadmaps ja vinculados usam esse projeto como contexto no Asana; por
   * isso, com algum deles vinculado, o vinculo do projeto nao muda mais.
   */
  async vincularAsana(
    id: number,
    idAsanaProjeto: number | null,
    usuario: UsuarioAutenticado,
  ): Promise<ProjetoDto> {
    const projeto = await this.assegurarEdicao(id, usuario);

    if (projeto.idAsanaProjeto === idAsanaProjeto) return projeto;

    if (projeto.roadmapsVinculados > 0) {
      throw new ConflictException(
        `O projeto "${projeto.nome}" tem ${projeto.roadmapsVinculados} roadmap(s) ja ` +
          'vinculado(s) ao Asana usando o projeto atual. O vinculo nao pode mais ser trocado.',
      );
    }

    if (idAsanaProjeto !== null) await this.validarProjetoAsanaLivre(idAsanaProjeto, id);

    await this.repo.definirVinculo(id, idAsanaProjeto);
    this.logger.log(
      `Projeto local ${id} ${idAsanaProjeto ? `vinculado ao projeto Asana ${idAsanaProjeto}` : 'desvinculado'}.`,
    );
    return this.obter(id);
  }

  /** O projeto do Asana existe e nao pertence a outro projeto local. */
  async validarProjetoAsanaLivre(idAsanaProjeto: number, idProjetoLocal: number) {
    const asana = await this.catalogo.projetoPorId(idAsanaProjeto);
    if (!asana) {
      throw new BadRequestException(
        `Projeto ${idAsanaProjeto} nao existe no catalogo do Asana. Sincronize o catalogo.`,
      );
    }
    const dono = await this.repo.porAsanaProjeto(idAsanaProjeto);
    if (dono && dono.id !== idProjetoLocal) {
      throw new ConflictException(
        `O projeto "${asana.nome}" do Asana ja esta vinculado ao projeto local "${dono.nome}".`,
      );
    }
    return asana;
  }

  async assegurarEdicao(id: number, usuario: UsuarioAutenticado): Promise<ProjetoDto> {
    const projeto = await this.obter(id);
    if (projeto.idUsuarioCriador !== usuario.id && usuario.perfil !== 'ADMIN') {
      throw new ForbiddenException('Somente quem criou o projeto (ou um ADMIN) pode altera-lo.');
    }
    return projeto;
  }
}
