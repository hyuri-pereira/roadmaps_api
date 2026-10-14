import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PerfisGuard } from '../../common/guards';
import { Perfis, UsuarioAtual } from '../../common/decorators';
import { UsuarioAutenticado } from '../../common/auth.types';
import { PaginacaoDto } from '../../common/dto';
import {
  AtualizarContatoDto,
  AtualizarUsuarioDto,
  CriarUsuarioDto,
  DefinirSenhaDto,
  UsuarioDto,
} from './usuarios.dto';
import { UsuariosService } from './usuarios.service';

@ApiTags('1. Usuarios')
@ApiBearerAuth()
@UseGuards(PerfisGuard)
@Controller('usuarios')
export class UsuariosController {
  constructor(private readonly service: UsuariosService) {}

  @Get('eu')
  @ApiOperation({ summary: 'Dados do usuario autenticado' })
  eu(@UsuarioAtual('id') id: number): Promise<UsuarioDto> {
    return this.service.obter(id);
  }

  @Patch('eu/contato')
  @ApiOperation({
    summary: 'Define e-mail e/ou WhatsApp que recebem avisos',
    description:
      'Trocar o e-mail zera a verificacao do e-mail; trocar o celular zera a verificacao ' +
      'do WhatsApp. Sem verificacao nenhum aviso e enfileirado naquele canal.',
  })
  atualizarContato(
    @UsuarioAtual('id') id: number,
    @Body() dto: AtualizarContatoDto,
  ): Promise<UsuarioDto> {
    return this.service.atualizarContato(id, dto);
  }

  @Post('eu/senha')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Define ou troca a senha de login local' })
  definirSenha(@UsuarioAtual('id') id: number, @Body() dto: DefinirSenhaDto): Promise<void> {
    return this.service.definirSenha(id, dto);
  }

  @Get()
  @Perfis('ADMIN')
  @ApiOperation({ summary: 'Lista os usuarios do sistema (ADMIN)' })
  listar(@Query() paginacao: PaginacaoDto) {
    return this.service.listar(paginacao);
  }

  @Post()
  @Perfis('ADMIN')
  @ApiOperation({ summary: 'Cria um usuario (ADMIN)' })
  criar(@Body() dto: CriarUsuarioDto): Promise<UsuarioDto> {
    return this.service.criar(dto);
  }

  @Get(':id')
  @Perfis('ADMIN')
  @ApiOperation({ summary: 'Detalha um usuario (ADMIN)' })
  obter(@Param('id', ParseIntPipe) id: number): Promise<UsuarioDto> {
    return this.service.obter(id);
  }

  @Patch(':id')
  @Perfis('ADMIN')
  @ApiOperation({ summary: 'Altera nome, perfil ou situacao de um usuario (ADMIN)' })
  atualizar(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AtualizarUsuarioDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<UsuarioDto> {
    // Evita que um ADMIN se rebaixe ou se desative por engano e tranque o sistema.
    if (id === usuario.id && (dto.perfil === 'LEITOR' || dto.ativo === false)) {
      throw new BadRequestException(
        'Um administrador nao pode remover o proprio acesso. Peca a outro ADMIN.',
      );
    }
    return this.service.atualizar(id, dto);
  }
}
