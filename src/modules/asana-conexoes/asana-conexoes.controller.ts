import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { AppConfig, CONFIG_APP } from '../../common/config/configuration';
import { Publico, UsuarioAtual } from '../../common/decorators';
import { UsuarioAutenticado } from '../../common/auth.types';
import { MensagemDto } from '../../common/dto';
import {
  AtualizarConexaoDto,
  ConexaoAsanaDto,
  CriarConexaoPatDto,
  IniciarOAuthAsanaDto,
  TestarConexaoDto,
} from './asana-conexoes.dto';
import { AsanaConexoesService } from './asana-conexoes.service';
import { semCredenciais } from './asana-conexoes.repository';

@ApiTags('2. Conexoes Asana')
@ApiBearerAuth()
@Controller('asana-conexoes')
export class AsanaConexoesController {
  constructor(
    private readonly service: AsanaConexoesService,
    @Inject(CONFIG_APP) private readonly config: AppConfig,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Lista as conexoes Asana do gestor autenticado',
    description: 'Tokens nunca sao devolvidos, nem parcialmente.',
  })
  listar(@UsuarioAtual('id') id: number): Promise<ConexaoAsanaDto[]> {
    return this.service.listar(id);
  }

  @Post('pat')
  @ApiOperation({
    summary: 'Cadastra a propria chave do Asana (Personal Access Token)',
    description:
      'O token e validado contra /users/me antes de ser gravado e e cifrado com ' +
      'AES-256-GCM usando a ENCRYPTION_KEY do .env.',
  })
  criarPat(
    @UsuarioAtual('id') id: number,
    @Body() dto: CriarConexaoPatDto,
  ): Promise<ConexaoAsanaDto> {
    return this.service.criarComPat(id, dto);
  }

  @Get('oauth/iniciar')
  @ApiOperation({
    summary: 'Passo 1 do OAuth do Asana: devolve a URL de autorizacao',
    description: 'Alternativa ao PAT, a escolha do gestor.',
  })
  iniciarOAuth(@UsuarioAtual('id') id: number, @Query() dto: IniciarOAuthAsanaDto) {
    return this.service.iniciarOAuth(id, dto.nome, dto.redirecionarPara);
  }

  @Publico()
  @Get('oauth/callback')
  @ApiExcludeEndpoint()
  async callbackOAuth(
    @Query('code') codigo: string,
    @Query('state') estado: string,
    @Query('error') erro: string,
    @Res() res: Response,
  ): Promise<void> {
    const base = this.config.app.urlFrontend;
    if (erro) {
      res.redirect(`${base}/conexoes?erro=${encodeURIComponent(erro)}`);
      return;
    }
    if (!codigo || !estado) throw new BadRequestException('O Asana nao devolveu "code" e "state".');

    const { conexao, redirecionarPara } = await this.service.concluirOAuth(codigo, estado);
    const destino = redirecionarPara ?? `${base}/conexoes`;
    res.redirect(`${destino}${destino.includes('?') ? '&' : '?'}conexao=${conexao.id}`);
  }

  @Post(':id/testar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Testa a conexao e lista os workspaces visiveis',
    description: 'Tambem atualiza o nome/e-mail do usuario Asana vinculado a credencial.',
  })
  testar(
    @Param('id', ParseIntPipe) id: number,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<TestarConexaoDto> {
    return this.service.testar(id, usuario);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Renomeia a conexao ou substitui o PAT' })
  atualizar(
    @Param('id', ParseIntPipe) id: number,
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: AtualizarConexaoDto,
  ): Promise<ConexaoAsanaDto> {
    return this.service.atualizar(id, usuario, dto);
  }

  @Post(':id/padrao')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Marca esta conexao como a padrao do gestor' })
  async definirPadrao(
    @Param('id', ParseIntPipe) id: number,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<MensagemDto> {
    await this.service.definirPadrao(id, usuario);
    return { mensagem: 'Conexao definida como padrao.' };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha uma conexao do proprio gestor' })
  async obter(
    @Param('id', ParseIntPipe) id: number,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<ConexaoAsanaDto> {
    return semCredenciais(await this.service.obterDoUsuario(id, usuario));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Desativa a conexao',
    description:
      'A linha nao e apagada porque a fila de integracao e a auditoria apontam para ela. ' +
      'Conexoes com roadmap ativo nao podem ser removidas.',
  })
  async remover(
    @Param('id', ParseIntPipe) id: number,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<MensagemDto> {
    await this.service.remover(id, usuario);
    return { mensagem: 'Conexao desativada.' };
  }
}
