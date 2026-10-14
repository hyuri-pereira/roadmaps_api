import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { PaginacaoDto } from '../../common/dto';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export const SITUACOES_ROADMAP = [
  'RASCUNHO',
  'PLANEJADO',
  'EM_ANDAMENTO',
  'CONCLUSAO_PENDENTE',
  'CONCLUIDO',
  'CANCELADO',
  'ERRO',
] as const;

export type SituacaoRoadmap = (typeof SITUACOES_ROADMAP)[number];

export class RoadmapDto {
  @ApiProperty() id!: number;
  @ApiProperty() titulo!: string;
  @ApiProperty({ description: 'Objetivo do roadmap, em texto livre' }) objetivo!: string;

  @ApiProperty() idUsuarioGestor!: number;
  @ApiProperty() gestorNome!: string;

  @ApiProperty({ description: 'Projeto local: da o nome que abre o titulo de cada card' })
  idProjeto!: number;
  @ApiProperty({ description: 'Nome do projeto local' })
  projetoContextoNome!: string;

  @ApiProperty({ description: 'false = roadmap so local; nada vai para o Asana' })
  vinculadoAsana!: boolean;
  @ApiPropertyOptional({ nullable: true }) idAsanaConexao?: number | null;
  @ApiPropertyOptional({ nullable: true }) idAsanaEquipe?: number | null;
  @ApiPropertyOptional({ nullable: true }) equipeNome?: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'Projeto do Asana usado como contexto quando o roadmap esta vinculado',
  })
  idProjetoContexto?: number | null;
  @ApiPropertyOptional({ nullable: true }) asanaProjetoNome?: string | null;

  @ApiProperty() dataInicio!: string;
  @ApiProperty() dataFim!: string;
  @ApiProperty({ enum: SITUACOES_ROADMAP }) situacao!: SituacaoRoadmap;

  @ApiProperty({ description: 'Calculado por VW_ROADMAP_PROGRESSO; nao e armazenado' })
  percentualConclusao!: number;
  @ApiProperty() totalCards!: number;
  @ApiProperty() cardsConcluidos!: number;
  @ApiProperty() cardsPendentes!: number;

  @ApiPropertyOptional() conclusaoSolicitadaEm?: Date | null;
  @ApiPropertyOptional() concluidoEm?: Date | null;
  @ApiProperty() criadoEm!: Date;
  @ApiProperty() atualizadoEm!: Date;
  @ApiProperty({ description: 'Incrementa a cada alteracao; usada para deteccao de conflito' })
  revisao!: number;
}

export class CriarRoadmapDto {
  @ApiProperty({ maxLength: 200, example: 'Modernizacao de serventias' })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  titulo!: string;

  @ApiProperty({ description: 'Objetivo do roadmap, em texto livre' })
  @IsString()
  @MinLength(3)
  objetivo!: string;

  @ApiProperty({
    description: 'Projeto local. E o nome dele que abre o titulo de cada card.',
  })
  @Type(() => Number)
  @IsInt()
  idProjeto!: number;

  @ApiPropertyOptional({
    description:
      'Opcional: vincula ja na criacao. Equipe do Asana com destinos configurados. ' +
      'Omitido, o roadmap nasce so local e pode ser vinculado depois.',
  })
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  idAsanaEquipe?: number;

  @ApiPropertyOptional({
    description:
      'Com idAsanaEquipe: projeto do Asana de contexto. Omitido, usa o projeto do Asana ' +
      'ja vinculado ao projeto local.',
  })
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  idProjetoContexto?: number;

  @ApiPropertyOptional({
    description: 'Com idAsanaEquipe: conexao a usar. Omitido, usa a conexao padrao do gestor.',
  })
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  idAsanaConexao?: number;

  @ApiProperty({ example: '2026-10-01', description: 'AAAA-MM-DD' })
  @IsDateString()
  dataInicio!: string;

  @ApiProperty({
    example: '2026-12-15',
    description: 'AAAA-MM-DD. Precisa ficar entre 7 dias e 3 meses depois do inicio.',
  })
  @IsDateString()
  dataFim!: string;

  @ApiPropertyOptional({ enum: ['RASCUNHO', 'PLANEJADO'], default: 'RASCUNHO' })
  @IsIn(['RASCUNHO', 'PLANEJADO'])
  @IsOptional()
  situacao?: 'RASCUNHO' | 'PLANEJADO';
}

export class AtualizarRoadmapDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  @IsOptional()
  titulo?: string;

  @ApiPropertyOptional()
  @IsString()
  @MinLength(3)
  @IsOptional()
  objetivo?: string;

  @ApiPropertyOptional({ example: '2026-10-01' })
  @IsDateString()
  @IsOptional()
  dataInicio?: string;

  @ApiPropertyOptional({ example: '2026-12-15' })
  @IsDateString()
  @IsOptional()
  dataFim?: string;

  @ApiPropertyOptional({ enum: ['RASCUNHO', 'PLANEJADO', 'EM_ANDAMENTO', 'CANCELADO'] })
  @IsIn(['RASCUNHO', 'PLANEJADO', 'EM_ANDAMENTO', 'CANCELADO'])
  @IsOptional()
  situacao?: 'RASCUNHO' | 'PLANEJADO' | 'EM_ANDAMENTO' | 'CANCELADO';
}

/** Filtros + paginacao num DTO so (ver FiltroFilaDto). */
export class VincularRoadmapAsanaDto {
  @ApiProperty({ description: 'Equipe do Asana com destinos SPRINT/Backlog configurados' })
  @Type(() => Number)
  @IsInt()
  idAsanaEquipe!: number;

  @ApiPropertyOptional({
    description:
      'Projeto do Asana (catalogo) que da contexto ao roadmap. Omitido, usa o projeto do ' +
      'Asana ja vinculado ao projeto local; se o projeto local ainda nao tem vinculo, ' +
      'este campo e obrigatorio e o projeto local passa a ser vinculado a ele.',
  })
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  idProjetoAsana?: number;

  @ApiPropertyOptional({ description: 'Conexao do gestor a usar. Omitido, usa a padrao.' })
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  idAsanaConexao?: number;
}

export class ResultadoVinculoDto {
  @ApiProperty() mensagem!: string;
  @ApiProperty({ description: 'Cards enfileirados para criacao no Asana' })
  cardsEnfileirados!: number;
  @ApiProperty({ type: () => RoadmapDto }) roadmap!: RoadmapDto;
}

export class FiltroRoadmapsDto extends PaginacaoDto {
  @ApiPropertyOptional({ description: 'Filtra pelo projeto local' })
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  idProjeto?: number;

  @ApiPropertyOptional()
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  idAsanaEquipe?: number;

  @ApiPropertyOptional({ description: 'Filtra pelo projeto de contexto do Asana' })
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  idProjetoContexto?: number;

  @ApiPropertyOptional()
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  idUsuarioGestor?: number;

  @ApiPropertyOptional({ enum: SITUACOES_ROADMAP })
  @IsIn(SITUACOES_ROADMAP as unknown as string[])
  @IsOptional()
  situacao?: SituacaoRoadmap;

  // `busca` (parte do titulo) vem de PaginacaoDto.
}

export class ResultadoConclusaoDto {
  @ApiProperty() mensagem!: string;
  @ApiProperty({ enum: SITUACOES_ROADMAP }) situacao!: SituacaoRoadmap;
  @ApiProperty({ description: 'Cards que entraram na fila para concluir no Asana' })
  cardsEnfileirados!: number;
}
