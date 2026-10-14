import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UsuarioAtual } from '../../common/decorators';
import { UsuarioAutenticado } from '../../common/auth.types';
import {
  AtualizarProjetoDto,
  CriarProjetoDto,
  FiltroProjetosLocaisDto,
  ProjetoDto,
  VincularProjetoAsanaDto,
} from './projetos.dto';
import { ProjetosService } from './projetos.service';

@ApiTags('5. Projetos locais')
@ApiBearerAuth()
@Controller('projetos')
export class ProjetosController {
  constructor(private readonly service: ProjetosService) {}

  @Get()
  @ApiOperation({
    summary: 'Lista os projetos locais com o progresso dos roadmaps',
    description: 'Projetos existem sem o Asana; o vinculo com um projeto do Asana e opcional.',
  })
  listar(@Query() filtro: FiltroProjetosLocaisDto): Promise<ProjetoDto[]> {
    return this.service.listar(filtro);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha um projeto local' })
  obter(@Param('id', ParseIntPipe) id: number): Promise<ProjetoDto> {
    return this.service.obter(id);
  }

  @Post()
  @ApiOperation({ summary: 'Cria um projeto local' })
  criar(
    @Body() dto: CriarProjetoDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<ProjetoDto> {
    return this.service.criar(dto, usuario);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Altera nome, descricao, cor ou arquiva o projeto' })
  atualizar(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AtualizarProjetoDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<ProjetoDto> {
    return this.service.atualizar(id, dto, usuario);
  }

  @Put(':id/vinculo-asana')
  @ApiOperation({
    summary: 'Vincula (ou desvincula) o projeto a um projeto do catalogo do Asana',
    description:
      'O projeto do Asana passa a ser o contexto dos roadmaps deste projeto quando eles ' +
      'forem vinculados. Com algum roadmap ja vinculado, o vinculo nao pode mais mudar.',
  })
  vincular(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: VincularProjetoAsanaDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<ProjetoDto> {
    return this.service.vincularAsana(id, dto.idAsanaProjeto, usuario);
  }
}
