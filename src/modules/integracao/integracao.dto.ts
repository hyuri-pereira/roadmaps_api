import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional } from 'class-validator';
import { PaginacaoDto } from '../../common/dto';

export const TIPOS_OPERACAO = [
  'CRIAR_TAREFA',
  'ATUALIZAR_TAREFA',
  'CONCLUIR_TAREFA',
  'EXCLUIR_TAREFA',
  'SINCRONIZAR_PROJETOS',
  'SINCRONIZAR_SECOES',
  'RECONCILIAR_TAREFA',
] as const;

export const SITUACOES_FILA = [
  'PENDENTE',
  'PROCESSANDO',
  'CONCLUIDO',
  'ERRO',
  'CANCELADO',
] as const;

export type TipoOperacao = (typeof TIPOS_OPERACAO)[number];
export type SituacaoFila = (typeof SITUACOES_FILA)[number];

export class JobFilaDto {
  @ApiProperty() id!: number;
  @ApiPropertyOptional() idAsanaConexao?: number | null;
  @ApiProperty({ enum: TIPOS_OPERACAO }) tipoOperacao!: TipoOperacao;
  @ApiProperty() tipoEntidadeLocal!: string;
  @ApiPropertyOptional() idEntidadeLocal?: number | null;
  @ApiPropertyOptional() recursoGid?: string | null;
  @ApiProperty() chaveIdempotencia!: string;
  @ApiProperty({ enum: SITUACOES_FILA }) situacao!: SituacaoFila;
  @ApiProperty() prioridadeFila!: number;
  @ApiProperty() tentativas!: number;
  @ApiProperty() proximaTentativaEm!: Date;
  @ApiPropertyOptional() bloqueadoAte?: Date | null;
  @ApiPropertyOptional() bloqueadoPor?: string | null;
  @ApiPropertyOptional() ultimoErro?: string | null;
  @ApiProperty() criadoEm!: Date;
  @ApiPropertyOptional() processadoEm?: Date | null;
}

export class LogIntegracaoDto {
  @ApiProperty() id!: number;
  @ApiPropertyOptional() idIntegracaoFila?: number | null;
  @ApiProperty({ enum: ['DEBUG', 'INFO', 'ALERTA', 'ERRO'] }) nivel!: string;
  @ApiPropertyOptional() codigoHttp?: number | null;
  @ApiProperty() mensagem!: string;
  @ApiPropertyOptional() requisicao?: string | null;
  @ApiPropertyOptional() resposta?: string | null;
  @ApiProperty() criadoEm!: Date;
}

/** Filtros + paginacao num DTO so: o ValidationPipe roda por parametro, e com
 * forbidNonWhitelisted dois @Query() separados rejeitam os campos um do outro. */
export class FiltroFilaDto extends PaginacaoDto {
  @ApiPropertyOptional({ enum: SITUACOES_FILA })
  @IsIn(SITUACOES_FILA as unknown as string[])
  @IsOptional()
  situacao?: SituacaoFila;

  @ApiPropertyOptional({ enum: TIPOS_OPERACAO })
  @IsIn(TIPOS_OPERACAO as unknown as string[])
  @IsOptional()
  tipoOperacao?: TipoOperacao;

  @ApiPropertyOptional({ description: 'Filtra pelos jobs de um card especifico' })
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  idEntidadeLocal?: number;
}

export class ResumoFilaDto {
  @ApiProperty() pendentes!: number;
  @ApiProperty() processando!: number;
  @ApiProperty() comErro!: number;
  @ApiProperty() concluidosUltimaHora!: number;
  @ApiProperty() cancelados!: number;
  @ApiPropertyOptional({ description: 'Job pendente ha mais tempo' })
  maisAntigoPendenteEm?: Date | null;
}
