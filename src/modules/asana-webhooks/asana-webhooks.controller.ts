import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { Publico, UsuarioAtual } from '../../common/decorators';
import { MensagemDto } from '../../common/dto';
import { AsanaWebhooksService } from './asana-webhooks.service';

@ApiTags('8. Webhooks Asana')
@Controller('asana-webhooks')
export class AsanaWebhooksController {
  constructor(private readonly service: AsanaWebhooksService) {}

  /**
   * Endpoint publico chamado pelo Asana. Nao tem JWT: a autenticidade vem da
   * assinatura HMAC calculada sobre o corpo bruto.
   */
  @Publico()
  @Post('receber')
  @ApiExcludeEndpoint()
  async receber(
    @Headers() cabecalhos: Record<string, string | string[] | undefined>,
    @Body() corpo: { events?: unknown[] },
    @Req() req: Request & { rawBody?: Buffer },
    @Res() res: Response,
  ): Promise<void> {
    const bruto = req.rawBody ?? Buffer.from(JSON.stringify(corpo ?? {}), 'utf8');
    const resultado = await this.service.receber(cabecalhos, bruto, corpo ?? {});

    // No handshake, o Asana exige o mesmo segredo de volta no header.
    if (resultado.segredoHandshake) {
      res.setHeader('X-Hook-Secret', resultado.segredoHandshake);
      res.status(HttpStatus.OK).send();
      return;
    }

    // Responder rapido e essencial: o Asana desativa webhooks lentos.
    // O processamento real acontece no worker, lendo ASANA_WEBHOOK_EVENTOS.
    res.status(HttpStatus.OK).json({ recebidos: resultado.eventosAceitos });
  }

  @ApiBearerAuth()
  @Get()
  @ApiOperation({ summary: 'Lista os webhooks registrados' })
  async listar() {
    const webhooks = await this.service.listar();
    // O segredo cifrado nunca sai pela API.
    return webhooks.map(({ segredoCifrado: _s, versaoChave: _v, ...resto }) => resto);
  }

  @ApiBearerAuth()
  @Post('projetos/:idProjeto')
  @ApiOperation({
    summary: 'Registra um webhook do Asana para um projeto',
    description:
      'Exige ASANA_WEBHOOK_URL publica em HTTPS. O Asana faz um handshake nessa URL e o ' +
      'segredo devolvido e gravado cifrado, para validar as entregas seguintes.',
  })
  registrar(
    @UsuarioAtual('id') idUsuario: number,
    @Param('idProjeto', ParseIntPipe) idProjeto: number,
  ) {
    return this.service.registrarParaProjeto(idUsuario, idProjeto);
  }

  @ApiBearerAuth()
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove o webhook aqui e no Asana' })
  async remover(
    @UsuarioAtual('id') idUsuario: number,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<MensagemDto> {
    await this.service.remover(idUsuario, id);
    return { mensagem: 'Webhook removido.' };
  }

  @ApiBearerAuth()
  @Post('processar-pendentes')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Processa agora os eventos recebidos e ainda nao aplicados',
    description:
      'O worker faz isso sozinho. Esta rota existe para testar a integracao sem esperar o cron.',
  })
  async processar(): Promise<MensagemDto> {
    const total = await this.service.processarPendentes();
    return { mensagem: `${total} evento(s) processado(s).` };
  }
}
