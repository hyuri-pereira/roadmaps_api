import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UsuarioAtual } from '../../common/decorators';
import { UsuarioAutenticado } from '../../common/auth.types';
import { MensagemDto } from '../../common/dto';
import {
  AdicionarGestorDto,
  DefinirDestinosDto,
  DestinosEquipeDto,
  EquipeConfiguradaDto,
  EtapaConfiguradaDto,
  GestorDaEquipeDto,
  MapearEtapasDto,
} from './equipes.dto';
import { EquipesService } from './equipes.service';

@ApiTags('4. Equipes e destinos')
@ApiBearerAuth()
@Controller('equipes')
export class EquipesController {
  constructor(private readonly service: EquipesService) {}

  @Get()
  @ApiOperation({ summary: 'Equipes das quais o gestor participa' })
  minhas(@UsuarioAtual('id') id: number): Promise<EquipeConfiguradaDto[]> {
    return this.service.listarMinhas(id);
  }

  @Post(':id/entrar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Entra em uma equipe',
    description:
      'A primeira pessoa a entrar numa equipe vira editora. Depois disso, novos membros ' +
      'precisam ser adicionados por quem ja edita ou por um ADMIN.',
  })
  async entrar(
    @Param('id', ParseIntPipe) id: number,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<MensagemDto> {
    await this.service.entrarNaEquipe(id, usuario);
    return { mensagem: 'Acesso a equipe confirmado.' };
  }

  @Get(':id/gestores')
  @ApiOperation({ summary: 'Lista quem participa da equipe' })
  gestores(
    @Param('id', ParseIntPipe) id: number,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<GestorDaEquipeDto[]> {
    return this.service.listarGestores(id, usuario);
  }

  @Post(':id/gestores')
  @ApiOperation({ summary: 'Adiciona um gestor a equipe' })
  adicionarGestor(
    @Param('id', ParseIntPipe) id: number,
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: AdicionarGestorDto,
  ): Promise<GestorDaEquipeDto[]> {
    return this.service.adicionarGestor(id, usuario, dto);
  }

  @Delete(':id/gestores/:idUsuario')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove um gestor da equipe',
    description: 'O vinculo e desativado, nao apagado, porque roadmaps antigos apontam para ele.',
  })
  async removerGestor(
    @Param('id', ParseIntPipe) id: number,
    @Param('idUsuario', ParseIntPipe) idUsuario: number,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<MensagemDto> {
    await this.service.removerGestor(id, usuario, idUsuario);
    return { mensagem: 'Gestor removido da equipe.' };
  }

  @Get(':id/destinos')
  @ApiOperation({ summary: 'Destinos configurados (SPRINT/A fazer e Backlog/Refino)' })
  destinos(
    @Param('id', ParseIntPipe) id: number,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<DestinosEquipeDto> {
    return this.service.obterDestinos(id, usuario);
  }

  @Put(':id/destinos')
  @ApiOperation({
    summary: 'Define para onde os cards vao',
    description:
      'Card com o checkbox marcado nasce em SPRINT / "A fazer"; desmarcado nasce em ' +
      'Backlog / "Refino". Sem esta configuracao nenhum roadmap pode ser criado.',
  })
  definirDestinos(
    @Param('id', ParseIntPipe) id: number,
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: DefinirDestinosDto,
  ): Promise<DestinosEquipeDto> {
    return this.service.definirDestinos(id, usuario, dto);
  }

  @Get(':id/etapas')
  @ApiOperation({ summary: 'Mapa das 8 colunas do quadro SPRINT' })
  etapas(
    @Param('id', ParseIntPipe) id: number,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<EtapaConfiguradaDto[]> {
    return this.service.listarEtapas(id, usuario);
  }

  @Put(':id/etapas')
  @ApiOperation({
    summary: 'Associa cada coluna do SPRINT a uma etapa do sistema',
    description:
      'E este mapa que permite saber quando um card entrou em "Parado" ou "Pendencia ' +
      'externa" e disparar os avisos. Cada secao pode pertencer a uma unica etapa.',
  })
  mapearEtapas(
    @Param('id', ParseIntPipe) id: number,
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: MapearEtapasDto,
  ): Promise<EtapaConfiguradaDto[]> {
    return this.service.mapearEtapas(id, usuario, dto);
  }
}
