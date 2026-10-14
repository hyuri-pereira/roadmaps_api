import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AppConfig, CONFIG_APP } from '../../common/config/configuration';
import { Publico, UsuarioAtual } from '../../common/decorators';
import { MensagemDto } from '../../common/dto';
import { AuthService } from './auth.service';
import {
  IniciarGoogleDto,
  LoginLocalDto,
  RefreshDto,
  TokensDto,
  UrlAutorizacaoDto,
} from './auth.dto';

@ApiTags('0. Autenticacao')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly service: AuthService,
    @Inject(CONFIG_APP) private readonly config: AppConfig,
  ) {}

  @Publico()
  @Post('login')
  @ApiOperation({
    summary: 'Login com e-mail e senha',
    description: 'Alternativa ao Google, util para o administrador inicial e para integracoes.',
  })
  login(@Body() dto: LoginLocalDto, @Req() req: Request): Promise<TokensDto> {
    return this.service.loginLocal(dto.email, dto.senha, contexto(req));
  }

  @Publico()
  @Get('google')
  @ApiOperation({
    summary: 'Passo 1 do login Google: devolve a URL de consentimento',
    description:
      'O frontend redireciona o navegador para a URL retornada. O state e o code_verifier ' +
      'ficam no banco, entao o callback pode cair em qualquer instancia da API.',
  })
  iniciarGoogle(@Query() dto: IniciarGoogleDto): Promise<UrlAutorizacaoDto> {
    return this.service.iniciarGoogle(dto.redirecionarPara);
  }

  @Publico()
  @Get('google/redirect')
  @ApiOperation({ summary: 'Atalho: redireciona direto para o consentimento do Google' })
  async redirecionarGoogle(@Query() dto: IniciarGoogleDto, @Res() res: Response): Promise<void> {
    const { url } = await this.service.iniciarGoogle(dto.redirecionarPara);
    res.redirect(url);
  }

  @Publico()
  @Get('google/callback')
  @ApiExcludeEndpoint()
  async callbackGoogle(
    @Query('code') codigo: string,
    @Query('state') estado: string,
    @Query('error') erro: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (erro) {
      res.redirect(`${this.config.app.urlFrontend}/login?erro=${encodeURIComponent(erro)}`);
      return;
    }
    if (!codigo || !estado) {
      throw new BadRequestException('O Google nao devolveu "code" e "state".');
    }

    const { tokens, redirecionarPara } = await this.service.concluirGoogle(
      codigo,
      estado,
      contexto(req),
    );

    // Os tokens vao no fragmento (#): fragmento nao viaja em Referer nem em
    // log de servidor, ao contrario da query string.
    const destino = new URL(redirecionarPara);
    destino.hash = new URLSearchParams({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expires_in: String(tokens.expiraEm),
    }).toString();

    res.redirect(destino.toString());
  }

  @Publico()
  @Post('refresh')
  @ApiOperation({
    summary: 'Troca o refresh token por um novo par de tokens',
    description: 'O refresh usado e revogado na hora (rotacao).',
  })
  renovar(@Body() dto: RefreshDto, @Req() req: Request): Promise<TokensDto> {
    return this.service.renovar(dto.refreshToken, contexto(req));
  }

  @Publico()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Encerra a sessao correspondente ao refresh token' })
  async sair(@Body() dto: RefreshDto): Promise<MensagemDto> {
    await this.service.sair(dto.refreshToken);
    return { mensagem: 'Sessao encerrada.' };
  }

  @ApiBearerAuth()
  @Post('logout-tudo')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Encerra todas as sessoes do usuario autenticado' })
  async sairDeTudo(@UsuarioAtual('id') id: number): Promise<MensagemDto> {
    await this.service.sairDeTudo(id);
    return { mensagem: 'Todas as sessoes foram encerradas.' };
  }
}

function contexto(req: Request) {
  return {
    userAgent: req.headers['user-agent'] ?? null,
    ip: req.ip ?? req.socket?.remoteAddress ?? null,
  };
}
