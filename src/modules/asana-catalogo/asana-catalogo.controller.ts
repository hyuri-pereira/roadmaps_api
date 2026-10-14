import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { UsuarioAtual } from '../../common/decorators';
import {
  EquipeAsanaDto,
  FiltroProjetosDto,
  ProjetoAsanaDto,
  ResultadoSincronizacaoDto,
  SecaoAsanaDto,
  WorkspaceDto,
} from './asana-catalogo.dto';
import { AsanaCatalogoService } from './asana-catalogo.service';

@ApiTags('3. Catalogo Asana')
@ApiBearerAuth()
@Controller('asana-catalogo')
export class AsanaCatalogoController {
  constructor(private readonly service: AsanaCatalogoService) {}

  @Post('sincronizar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Le o Asana e atualiza o catalogo local',
    description:
      'Usa a conexao padrao do gestor autenticado. O catalogo e compartilhado por toda a ' +
      'equipe: uma linha por GID, nunca duplicada por credencial. Projetos que a credencial ' +
      'nao enxerga permanecem como estavam.',
  })
  sincronizar(@UsuarioAtual('id') id: number): Promise<ResultadoSincronizacaoDto> {
    return this.service.sincronizarTudo(id);
  }

  @Get('workspaces')
  @ApiOperation({ summary: 'Workspaces conhecidos' })
  workspaces(): Promise<WorkspaceDto[]> {
    return this.service.listarWorkspaces();
  }

  @Get('equipes')
  @ApiQuery({ name: 'idWorkspace', required: false, type: Number })
  @ApiOperation({ summary: 'Equipes conhecidas, com indicacao de quais ja estao configuradas' })
  equipes(@Query('idWorkspace') idWorkspace?: string): Promise<EquipeAsanaDto[]> {
    return this.service.listarEquipes(idWorkspace ? Number(idWorkspace) : undefined);
  }

  @Get('projetos')
  @ApiOperation({
    summary: 'Lista todos os projetos do Asana',
    description: 'Esta e a lista que o gestor usa para escolher o projeto de contexto do roadmap.',
  })
  projetos(@Query() filtro: FiltroProjetosDto): Promise<ProjetoAsanaDto[]> {
    return this.service.listarProjetos(filtro);
  }

  @Get('projetos/:id')
  @ApiOperation({ summary: 'Detalha um projeto do catalogo' })
  projeto(@Param('id', ParseIntPipe) id: number): Promise<ProjetoAsanaDto> {
    return this.service.obterProjeto(id);
  }

  @Get('projetos/:id/secoes')
  @ApiQuery({ name: 'incluirInativas', required: false, type: Boolean })
  @ApiOperation({ summary: 'Colunas (secoes) de um projeto' })
  secoes(
    @Param('id', ParseIntPipe) id: number,
    @Query('incluirInativas') incluirInativas?: string,
  ): Promise<SecaoAsanaDto[]> {
    return this.service.listarSecoes(id, incluirInativas === 'true');
  }

  @Post('projetos/:id/sincronizar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Recarrega um projeto e suas secoes a partir do Asana' })
  sincronizarProjeto(
    @UsuarioAtual('id') idUsuario: number,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<SecaoAsanaDto[]> {
    return this.service.sincronizarProjeto(idUsuario, id);
  }

  @Get('equipes/:id/sugestao-destinos')
  @ApiOperation({
    summary: 'Sugere SPRINT/A fazer, Backlog/Refino e o mapa das 8 colunas',
    description:
      'Procura pelos nomes configurados no .env, ignorando acento e caixa. O resultado e ' +
      'apenas uma sugestao para a tela de configuracao: nada e gravado aqui.',
  })
  sugestao(@Param('id', ParseIntPipe) id: number) {
    return this.service.sugerirDestinos(id);
  }
}
