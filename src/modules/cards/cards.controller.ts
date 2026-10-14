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
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { UsuarioAtual } from '../../common/decorators';
import { UsuarioAutenticado } from '../../common/auth.types';
import { MensagemDto } from '../../common/dto';
import {
  AtualizarCardDto,
  CardDto,
  ConcluirCardDto,
  CriarCardDto,
  FiltroCardsDto,
  LinkReferenciaDto,
  ReferenciaDto,
  ReordenarCardsDto,
} from './cards.dto';
import { CardsService } from './cards.service';

@ApiTags('6. Cards')
@ApiBearerAuth()
@Controller()
export class CardsController {
  constructor(private readonly service: CardsService) {}

  // ------------------------------------------------ cards de um roadmap

  @Get('roadmaps/:idRoadmap/cards')
  @ApiOperation({ summary: 'Lista os cards de um roadmap com suas referencias' })
  listar(
    @Param('idRoadmap', ParseIntPipe) idRoadmap: number,
    @Query() filtro: FiltroCardsDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<CardDto[]> {
    return this.service.listar(idRoadmap, filtro, usuario);
  }

  @Post('roadmaps/:idRoadmap/cards')
  @ApiOperation({
    summary: 'Cria um card no roadmap',
    description:
      'Marcado para sprint, o card nasce em SPRINT/"A fazer"; senao, em Backlog/"Refino". ' +
      'O titulo segue PROJETO - PRIORIDADE - PRAZO - ROADMAP (a secao do prazo some quando ' +
      'nao ha data). Os links informados viram o bloco "Links de referencia:" no corpo da tarefa.',
  })
  criar(
    @Param('idRoadmap', ParseIntPipe) idRoadmap: number,
    @Body() dto: CriarCardDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<CardDto> {
    return this.service.criar(idRoadmap, dto, usuario);
  }

  @Put('roadmaps/:idRoadmap/cards/ordem')
  @ApiOperation({ summary: 'Reordena os cards do roadmap' })
  reordenar(
    @Param('idRoadmap', ParseIntPipe) idRoadmap: number,
    @Body() dto: ReordenarCardsDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<CardDto[]> {
    return this.service.reordenar(idRoadmap, dto, usuario);
  }

  // ------------------------------------------------------- card isolado

  @Get('cards/:id')
  @ApiOperation({ summary: 'Detalha um card, incluindo a etapa atual no quadro SPRINT' })
  obter(
    @Param('id', ParseIntPipe) id: number,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<CardDto> {
    return this.service.obter(id, usuario);
  }

  @Patch('cards/:id')
  @ApiOperation({
    summary: 'Altera titulo, descricao, prazo, prioridade ou o checkbox de sprint',
    description:
      'A alteracao e gravada e enfileirada para o Asana na mesma transacao. Informe ' +
      'revisaoEsperada para receber 409 caso o card tenha mudado no Asana enquanto voce editava.',
  })
  atualizar(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AtualizarCardDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<CardDto> {
    return this.service.atualizar(id, dto, usuario);
  }

  @Post('cards/:id/conclusao')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Conclui ou reabre um card',
    description:
      'Concluir o ultimo card pendente fecha o roadmap automaticamente. Reabrir um card ' +
      'de um roadmap ja concluido volta o roadmap para EM_ANDAMENTO.',
  })
  concluir(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ConcluirCardDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<CardDto> {
    return this.service.definirConclusao(id, dto.concluido, usuario);
  }

  @Delete('cards/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exclui um card',
    description:
      'Exclusao logica imediata (o percentual do roadmap se ajusta na hora) e exclusao ' +
      'no Asana pela fila.',
  })
  async excluir(
    @Param('id', ParseIntPipe) id: number,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<MensagemDto> {
    await this.service.excluir(id, usuario);
    return { mensagem: 'Card excluido. A remocao no Asana foi enfileirada.' };
  }

  // -------------------------------------------------------- referencias

  @Get('cards/:id/referencias')
  @ApiOperation({ summary: 'Links e arquivos do card' })
  referencias(
    @Param('id', ParseIntPipe) id: number,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<ReferenciaDto[]> {
    return this.service.listarReferencias(id, usuario);
  }

  @Post('cards/:id/referencias/links')
  @ApiOperation({
    summary: 'Adiciona um link de referencia',
    description: 'O link entra no bloco "Links de referencia:" no corpo da tarefa do Asana.',
  })
  adicionarLink(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: LinkReferenciaDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<ReferenciaDto[]> {
    return this.service.adicionarLink(id, dto, usuario);
  }

  @Post('cards/:id/referencias/arquivos')
  @UseInterceptors(FileInterceptor('arquivo'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        arquivo: { type: 'string', format: 'binary' },
        rotulo: { type: 'string', description: 'Texto exibido antes do link no card' },
      },
      required: ['arquivo'],
    },
  })
  @ApiOperation({
    summary: 'Anexa um arquivo ao card',
    description:
      'O arquivo e gravado fora do Firebird. O corpo da tarefa recebe uma URL duravel e ' +
      'autenticada desta API, cujo acesso e verificado a cada download.',
  })
  anexar(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() arquivo: Express.Multer.File,
    @Body('rotulo') rotulo: string | undefined,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<ReferenciaDto[]> {
    return this.service.anexarArquivo(id, arquivo, rotulo, usuario);
  }

  @Get('cards/referencias/:idReferencia/download')
  @ApiOperation({
    summary: 'Baixa um arquivo de referencia',
    description: 'Esta e a URL duravel publicada no corpo da tarefa do Asana.',
  })
  async baixar(
    @Param('idReferencia', ParseIntPipe) idReferencia: number,
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Res() res: Response,
  ): Promise<void> {
    const arquivo = await this.service.prepararDownload(idReferencia, usuario);
    res.setHeader('Content-Type', arquivo.mimeType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(arquivo.nome)}"`,
    );
    if (arquivo.tamanho) res.setHeader('Content-Length', String(arquivo.tamanho));
    arquivo.stream.pipe(res);
  }

  @Delete('cards/referencias/:idReferencia')
  @ApiOperation({ summary: 'Remove um link ou arquivo do card' })
  removerReferencia(
    @Param('idReferencia', ParseIntPipe) idReferencia: number,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<ReferenciaDto[]> {
    return this.service.removerReferencia(idReferencia, usuario);
  }
}
