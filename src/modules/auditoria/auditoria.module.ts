import { Controller, Get, Injectable, Module, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString } from 'class-validator';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ApiProperty } from '@nestjs/swagger';
import { FirebirdService } from '../../database/firebird.service';
import { PerfisGuard } from '../../common/guards';
import { Perfis } from '../../common/decorators';
import { PaginacaoDto, RespostaPaginadaDto } from '../../common/dto';
import { paraDataOuNulo } from '../../common/utils';

export class EventoAuditoriaDto {
  @ApiProperty() id!: number;
  @ApiPropertyOptional() idUsuario?: number | null;
  @ApiPropertyOptional() usuarioNome?: string | null;
  @ApiProperty() tipoEntidade!: string;
  @ApiProperty() idEntidade!: number;
  @ApiProperty() acao!: string;
  @ApiProperty({ enum: ['SISTEMA', 'ASANA', 'USUARIO', 'JOB'] }) origem!: string;
  @ApiPropertyOptional() resumo?: string | null;
  @ApiProperty() criadoEm!: Date;
}

/**
 * Auditoria independente: as linhas permanecem mesmo depois que o roadmap ou
 * o card sao apagados fisicamente, por isso a tabela nao tem FK para eles.
 */
@Injectable()
export class AuditoriaService {
  constructor(private readonly db: FirebirdService) {}

  async listar(
    paginacao: PaginacaoDto,
    filtros: { tipoEntidade?: string; idEntidade?: number; idUsuario?: number },
  ): Promise<RespostaPaginadaDto<EventoAuditoriaDto>> {
    const condicoes: string[] = [];
    const parametros: unknown[] = [];

    if (filtros.tipoEntidade) {
      condicoes.push('A.TIPO_ENTIDADE = ?');
      parametros.push(filtros.tipoEntidade);
    }
    if (filtros.idEntidade) {
      condicoes.push('A.ID_ENTIDADE = ?');
      parametros.push(filtros.idEntidade);
    }
    if (filtros.idUsuario) {
      condicoes.push('A.ID_USUARIO = ?');
      parametros.push(filtros.idUsuario);
    }

    const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

    const [linhas, total] = await Promise.all([
      this.db.query(
        `SELECT A.ID_AUDITORIA_EVENTO, A.ID_USUARIO, U.NOME AS USUARIO_NOME, A.TIPO_ENTIDADE,
                A.ID_ENTIDADE, A.ACAO, A.ORIGEM, A.RESUMO, A.CRIADO_EM
           FROM AUDITORIA_EVENTOS A
           LEFT JOIN USUARIOS U ON U.ID_USUARIO = A.ID_USUARIO
           ${where}
          ORDER BY A.ID_AUDITORIA_EVENTO DESC
          OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`,
        [...parametros, paginacao.offset, paginacao.tamanho] as never[],
      ),
      this.db.queryUm<{ TOTAL: number }>(
        `SELECT COUNT(*) AS TOTAL FROM AUDITORIA_EVENTOS A ${where}`,
        parametros as never[],
      ),
    ]);

    const itens = linhas.map((l) => ({
      id: Number(l.ID_AUDITORIA_EVENTO),
      idUsuario: l.ID_USUARIO ? Number(l.ID_USUARIO) : null,
      usuarioNome: (l.USUARIO_NOME as string) ?? null,
      tipoEntidade: String(l.TIPO_ENTIDADE),
      idEntidade: Number(l.ID_ENTIDADE),
      acao: String(l.ACAO),
      origem: String(l.ORIGEM),
      resumo: (l.RESUMO as string) ?? null,
      criadoEm: paraDataOuNulo(l.CRIADO_EM) as Date,
    }));

    return RespostaPaginadaDto.de(itens, Number(total?.TOTAL ?? 0), paginacao);
  }
}

/** Filtros + paginacao num DTO so (ver FiltroFilaDto). */
export class FiltroAuditoriaDto extends PaginacaoDto {
  @ApiPropertyOptional({ example: 'ROADMAP' })
  @IsString()
  @IsOptional()
  tipoEntidade?: string;

  @ApiPropertyOptional()
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  idEntidade?: number;

  @ApiPropertyOptional()
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  idUsuario?: number;
}

@ApiTags('12. Auditoria')
@ApiBearerAuth()
@UseGuards(PerfisGuard)
@Perfis('ADMIN')
@Controller('auditoria')
export class AuditoriaController {
  constructor(private readonly service: AuditoriaService) {}

  @Get()
  @ApiOperation({
    summary: 'Historico de acoes (ADMIN)',
    description:
      'Registros de conclusao e exclusao de roadmaps e cards. Sobrevive a exclusao fisica ' +
      'das entidades, por isso nao ha chave estrangeira para elas.',
  })
  listar(@Query() filtro: FiltroAuditoriaDto) {
    return this.service.listar(filtro, filtro);
  }
}

@Module({
  controllers: [AuditoriaController],
  providers: [AuditoriaService],
  exports: [AuditoriaService],
})
export class AuditoriaModule {}
