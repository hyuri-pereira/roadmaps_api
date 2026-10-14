import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { UsuarioAtual } from '../../common/decorators';
import { UsuarioAutenticado } from '../../common/auth.types';
import {
  CardAcompanhamentoDto,
  ColunaQuadroDto,
  VisaoGeralDto,
  VisaoProjetoDto,
} from './dashboard.dto';
import { DashboardService } from './dashboard.service';

@ApiTags('11. Visao gerencial')
@ApiBearerAuth()
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get('geral')
  @ApiOperation({
    summary: 'Visao geral de todos os projetos',
    description:
      'Total de roadmaps, quantos estao ativos/concluidos e o percentual consolidado. ' +
      'Um gestor ve apenas as equipes das quais participa; ADMIN ve tudo.',
  })
  geral(@UsuarioAtual() usuario: UsuarioAutenticado): Promise<VisaoGeralDto> {
    return this.service.geral(usuario);
  }

  @Get('por-projeto')
  @ApiOperation({
    summary: 'Roadmaps agrupados por projeto do Asana',
    description: 'Um bloco por projeto, com total de roadmaps, cards e percentual.',
  })
  porProjeto(@UsuarioAtual() usuario: UsuarioAutenticado): Promise<VisaoProjetoDto[]> {
    return this.service.porProjeto(usuario);
  }

  @Get('quadro')
  @ApiQuery({ name: 'idRoadmap', required: false, type: Number })
  @ApiOperation({
    summary: 'Cards agrupados pela coluna do quadro SPRINT',
    description:
      'Mostra em que etapa cada card esta (A fazer, Em desenvolvimento, Parado, ' +
      'Pendencia externa, Emergencias/Demandas, Validacao, Concluido, Arquivado). ' +
      'Cards que ainda estao no Backlog aparecem em "Fora do quadro SPRINT".',
  })
  quadro(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query('idRoadmap') idRoadmap?: string,
  ): Promise<ColunaQuadroDto[]> {
    return this.service.quadro(usuario, idRoadmap ? Number(idRoadmap) : undefined);
  }

  @Get('atencao')
  @ApiOperation({
    summary: 'Cards parados, com pendencia externa ou com erro de sincronizacao',
    description: 'A lista curta do que trava o roadmap agora.',
  })
  atencao(@UsuarioAtual() usuario: UsuarioAutenticado): Promise<CardAcompanhamentoDto[]> {
    return this.service.atencao(usuario);
  }
}
