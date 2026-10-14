import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PerfisGuard } from '../../common/guards';
import { Perfis, UsuarioAtual } from '../../common/decorators';
import { MensagemDto } from '../../common/dto';
import {
  ConfiguracaoEmailDto,
  DefinirPreferenciasDto,
  NotificacaoFilaDto,
  PreferenciaDto,
  ResumoNotificacoesDto,
  SalvarConfiguracaoEmailDto,
} from './notificacoes.dto';
import { NotificacoesService } from './notificacoes.service';
import { NotificacoesWorker } from './notificacoes.worker';

@ApiTags('10. Notificacoes')
@ApiBearerAuth()
@UseGuards(PerfisGuard)
@Controller('notificacoes')
export class NotificacoesController {
  constructor(
    private readonly service: NotificacoesService,
    private readonly worker: NotificacoesWorker,
  ) {}

  @Get('preferencias')
  @ApiOperation({
    summary: 'Preferencias de aviso do gestor',
    description:
      'Devolve a grade completa de eventos x canais. O campo "pendencia" explica o que ' +
      'falta em cada canal (contato ausente, e-mail nao verificado, WhatsApp nao conectado).',
  })
  preferencias(@UsuarioAtual('id') id: number): Promise<PreferenciaDto[]> {
    return this.service.preferencias(id);
  }

  @Put('preferencias')
  @ApiOperation({
    summary: 'Define por evento se quer aviso por e-mail, WhatsApp, ambos ou nenhum',
    description:
      'Ativar um canal registra o consentimento. Desativar todos os avisos de um canal ' +
      'cancela imediatamente o que ainda estava na fila daquele canal.',
  })
  definir(
    @UsuarioAtual('id') id: number,
    @Body() dto: DefinirPreferenciasDto,
  ): Promise<PreferenciaDto[]> {
    return this.service.definirPreferencias(id, dto);
  }

  @Post('email/verificar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Envia um e-mail de teste e marca o endereco como verificado',
    description:
      'Sem verificacao, a trigger do banco nao enfileira nenhum aviso por e-mail. ' +
      'A entrega bem sucedida e a propria prova de que o endereco existe.',
  })
  verificarEmail(@UsuarioAtual('id') id: number): Promise<MensagemDto> {
    return this.service.enviarVerificacaoEmail(id);
  }

  @Get('minhas')
  @ApiOperation({ summary: 'Ultimos avisos enfileirados para o gestor' })
  minhas(@UsuarioAtual('id') id: number): Promise<NotificacaoFilaDto[]> {
    return this.service.listarDoUsuario(id);
  }

  // ------------------------------------------------------------- admin

  @Get('resumo')
  @Perfis('ADMIN')
  @ApiOperation({ summary: 'Panorama da fila de avisos (ADMIN)' })
  resumo(): Promise<ResumoNotificacoesDto> {
    return this.service.resumo();
  }

  @Get('email-config')
  @Perfis('ADMIN')
  @ApiOperation({
    summary: 'Configuracao SMTP do sistema (ADMIN)',
    description: 'A senha nunca e devolvida; o campo senhaDefinida apenas indica se existe uma.',
  })
  configuracao(): Promise<ConfiguracaoEmailDto | null> {
    return this.service.obterConfiguracaoEmail();
  }

  @Put('email-config')
  @Perfis('ADMIN')
  @ApiOperation({
    summary: 'Define o SMTP e o remetente padrao (ADMIN)',
    description: 'Deixe a senha em branco para manter a atual. A senha e gravada cifrada.',
  })
  salvarConfiguracao(@Body() dto: SalvarConfiguracaoEmailDto): Promise<ConfiguracaoEmailDto> {
    return this.service.salvarConfiguracaoEmail(dto);
  }

  @Post('email-config/testar')
  @Perfis('ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Testa a conexao com o servidor SMTP (ADMIN)' })
  async testarSmtp(): Promise<MensagemDto> {
    const ok = await this.service.verificarSmtp();
    return {
      mensagem: ok
        ? 'Conexao SMTP estabelecida com sucesso.'
        : 'Nao foi possivel conectar ao SMTP. Confira host, porta, seguranca e credenciais.',
    };
  }

  @Post('executar-agora')
  @Perfis('ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Dispara uma rodada de envio imediatamente (ADMIN)' })
  async executar(): Promise<MensagemDto> {
    await this.worker.rodar();
    return { mensagem: 'Rodada de avisos executada.' };
  }
}
