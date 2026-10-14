import { Controller, Delete, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UsuarioAtual } from '../../common/decorators';
import { MensagemDto } from '../../common/dto';
import { StatusSessaoDto, WahaService } from './waha.service';

@ApiTags('9. WhatsApp (WAHA)')
@ApiBearerAuth()
@Controller('waha')
export class WahaController {
  constructor(private readonly service: WahaService) {}

  @Post('conectar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cria/inicia a sessao de WhatsApp do gestor',
    description:
      'Cada gestor tem a propria sessao e recebe os avisos no proprio numero. ' +
      'Cadastre o celular antes em PATCH /usuarios/eu/contato: e contra ele que ' +
      'a identidade da sessao e conferida depois do QR.',
  })
  conectar(@UsuarioAtual('id') id: number): Promise<StatusSessaoDto> {
    return this.service.iniciarConexao(id);
  }

  @Get('qrcode')
  @ApiOperation({
    summary: 'QR code para parear o WhatsApp',
    description:
      'Devolve a imagem em base64. O QR e buscado no WAHA em tempo real e nunca e ' +
      'gravado em banco, arquivo ou log. Ler o QR apenas conecta a conta; nenhuma ' +
      'mensagem e enviada nesse momento.',
  })
  qrcode(@UsuarioAtual('id') id: number): Promise<{ mimeType: string; base64: string }> {
    return this.service.obterQrCode(id);
  }

  @Get('status')
  @ApiOperation({
    summary: 'Situacao da sessao e se o numero esta verificado',
    description:
      'Verificado significa sessao WORKING e numero conectado igual ao cadastrado. ' +
      'Sem isso, nenhum aviso por WhatsApp e enfileirado.',
  })
  status(@UsuarioAtual('id') id: number): Promise<StatusSessaoDto | null> {
    return this.service.status(id);
  }

  @Post('desconectar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Desconecta o WhatsApp',
    description: 'Derruba a verificacao do numero: os avisos por WhatsApp param imediatamente.',
  })
  async desconectar(@UsuarioAtual('id') id: number): Promise<MensagemDto> {
    await this.service.desconectar(id);
    return { mensagem: 'WhatsApp desconectado. A verificacao do numero foi removida.' };
  }

  @Delete('sessao')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a sessao de WhatsApp do gestor' })
  async remover(@UsuarioAtual('id') id: number): Promise<MensagemDto> {
    await this.service.remover(id);
    return { mensagem: 'Sessao removida e avisos pendentes por WhatsApp cancelados.' };
  }
}
