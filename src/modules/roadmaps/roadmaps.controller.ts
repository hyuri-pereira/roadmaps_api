import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UsuarioAtual } from '../../common/decorators';
import { UsuarioAutenticado } from '../../common/auth.types';
import { MensagemDto } from '../../common/dto';
import {
  AtualizarRoadmapDto,
  CriarRoadmapDto,
  FiltroRoadmapsDto,
  ResultadoConclusaoDto,
  ResultadoVinculoDto,
  RoadmapDto,
  VincularRoadmapAsanaDto,
} from './roadmaps.dto';
import { RoadmapsService } from './roadmaps.service';

@ApiTags('5. Roadmaps')
@ApiBearerAuth()
@Controller('roadmaps')
export class RoadmapsController {
  constructor(private readonly service: RoadmapsService) {}

  @Get()
  @ApiOperation({
    summary: 'Lista roadmaps com o percentual de conclusao',
    description:
      'Traz os roadmaps das equipes das quais voce participa. ADMIN enxerga todos. ' +
      'O percentual vem da view VW_ROADMAP_PROGRESSO e reflete apenas cards nao excluidos.',
  })
  listar(
    @Query() filtro: FiltroRoadmapsDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ) {
    return this.service.listar(filtro, filtro, usuario);
  }

  @Post()
  @ApiOperation({
    summary: 'Cria um roadmap',
    description:
      'Vincula um projeto do Asana, um periodo (minimo 1 semana, maximo 3 meses) e o ' +
      'objetivo em texto. A equipe precisa ter os destinos ja configurados.',
  })
  criar(
    @Body() dto: CriarRoadmapDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<RoadmapDto> {
    return this.service.criar(dto, usuario);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha um roadmap' })
  obter(
    @Param('id', ParseIntPipe) id: number,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<RoadmapDto> {
    return this.service.obter(id, usuario);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Altera titulo, objetivo, periodo ou situacao',
    description:
      'Renomear o roadmap afeta o padrao dos cards criados depois. Cards ja existentes ' +
      'mantem o titulo que esta no Asana, porque podem ter sido editados la.',
  })
  atualizar(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AtualizarRoadmapDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<RoadmapDto> {
    return this.service.atualizar(id, dto, usuario);
  }

  @Post(':id/vincular-asana')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Vincula um roadmap local ao Asana',
    description:
      'Escolha a equipe (com destinos configurados) e, se o projeto local ainda nao tiver ' +
      'vinculo, o projeto do Asana de contexto. Cada card existente entra na fila e vira uma ' +
      'tarefa nova (Sprint ou Backlog conforme o checkbox). O vinculo nao pode ser desfeito.',
  })
  vincularAsana(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: VincularRoadmapAsanaDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<ResultadoVinculoDto> {
    return this.service.vincularAsana(id, dto, usuario);
  }

  @Post(':id/concluir')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Botao "Concluir roadmap"',
    description:
      'Marca todos os cards ativos para conclusao no Asana. O roadmap fica em ' +
      'CONCLUSAO_PENDENTE e so vira CONCLUIDO quando o Asana confirmar cada card. ' +
      'Roadmap sem nenhum card nao pode ser concluido.',
  })
  concluir(
    @Param('id', ParseIntPipe) id: number,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<ResultadoConclusaoDto> {
    return this.service.solicitarConclusao(id, usuario);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exclui o roadmap e todos os seus cards',
    description:
      'Exclusao logica imediata: o roadmap some das listas na hora. Os cards entram na ' +
      'fila para serem apagados no Asana, e so sao removidos fisicamente do banco depois ' +
      'que o Asana confirmar cada exclusao.',
  })
  async excluir(
    @Param('id', ParseIntPipe) id: number,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<MensagemDto> {
    await this.service.excluir(id, usuario);
    return {
      mensagem: 'Roadmap excluido. Os cards serao removidos do Asana pelos workers.',
    };
  }
}
