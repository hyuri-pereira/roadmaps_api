import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PerfisGuard } from '../../common/guards';
import { Perfis } from '../../common/decorators';
import { MensagemDto, RespostaPaginadaDto } from '../../common/dto';
import {
  FiltroFilaDto,
  JobFilaDto,
  LogIntegracaoDto,
  ResumoFilaDto,
} from './integracao.dto';
import { IntegracaoRepository } from './integracao.repository';
import { IntegracaoWorker } from './integracao.worker';

@ApiTags('7. Fila de integracao')
@ApiBearerAuth()
@UseGuards(PerfisGuard)
@Perfis('ADMIN')
@Controller('integracao')
export class IntegracaoController {
  constructor(
    private readonly repo: IntegracaoRepository,
    private readonly worker: IntegracaoWorker,
  ) {}

  @Get('resumo')
  @ApiOperation({
    summary: 'Panorama da fila',
    description: 'Use para monitorar: fila pendente crescendo indica Asana fora ou credencial invalida.',
  })
  resumo(): Promise<ResumoFilaDto> {
    return this.repo.resumo();
  }

  @Get('fila')
  @ApiOperation({ summary: 'Lista os jobs de integracao' })
  async listar(
    @Query() filtro: FiltroFilaDto,
  ): Promise<RespostaPaginadaDto<JobFilaDto>> {
    const { itens, total } = await this.repo.listar(filtro, filtro.offset, filtro.tamanho);
    return RespostaPaginadaDto.de(itens, total, filtro);
  }

  @Get('fila/:id')
  @ApiOperation({ summary: 'Detalha um job' })
  async obter(@Param('id', ParseIntPipe) id: number): Promise<JobFilaDto> {
    const job = await this.repo.porId(id);
    if (!job) throw new NotFoundException(`Job ${id} nao encontrado.`);
    return job;
  }

  @Get('fila/:id/logs')
  @ApiOperation({
    summary: 'Logs HTTP do job',
    description: 'Tokens, QR e senhas nunca aparecem aqui: sao mascarados antes da gravacao.',
  })
  logs(@Param('id', ParseIntPipe) id: number): Promise<LogIntegracaoDto[]> {
    return this.repo.listarLogs(id);
  }

  @Post('fila/:id/reenfileirar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reenvia um job que terminou em ERRO ou CANCELADO' })
  async reenfileirar(@Param('id', ParseIntPipe) id: number): Promise<MensagemDto> {
    const ok = await this.repo.reenfileirar(id);
    if (!ok) {
      throw new NotFoundException(
        'Job nao encontrado ou nao esta em ERRO/CANCELADO. Jobs pendentes ja serao processados.',
      );
    }
    return { mensagem: 'Job reenfileirado.' };
  }

  @Post('executar-agora')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Dispara uma rodada da fila imediatamente',
    description: 'Util para testar a integracao sem esperar o cron.',
  })
  async executar(): Promise<MensagemDto> {
    await this.worker.rodar();
    return { mensagem: 'Rodada executada.' };
  }

  @Post('reconciliar-agora')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Agenda a releitura dos cards mais desatualizados' })
  async reconciliar(): Promise<MensagemDto> {
    await this.worker.reconciliar();
    return { mensagem: 'Reconciliacao agendada.' };
  }
}
