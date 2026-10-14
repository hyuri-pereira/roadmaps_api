import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class ProjetoDto {
  @ApiProperty() id!: number;
  @ApiProperty() nome!: string;
  @ApiPropertyOptional() descricao?: string | null;
  @ApiPropertyOptional() cor?: string | null;
  @ApiProperty() arquivado!: boolean;
  @ApiProperty() idUsuarioCriador!: number;
  @ApiProperty() criadorNome!: string;

  @ApiPropertyOptional({ description: 'Projeto do catalogo do Asana vinculado, se houver' })
  idAsanaProjeto?: number | null;
  @ApiPropertyOptional() asanaProjetoNome?: string | null;
  @ApiPropertyOptional() asanaProjetoUrl?: string | null;
  @ApiPropertyOptional({ description: 'Equipe do Asana dona do projeto vinculado' })
  idAsanaEquipe?: number | null;
  @ApiPropertyOptional() asanaEquipeNome?: string | null;

  @ApiProperty() totalRoadmaps!: number;
  @ApiProperty() roadmapsAtivos!: number;
  @ApiProperty() roadmapsConcluidos!: number;
  @ApiProperty({ description: 'Roadmaps ja vinculados ao Asana' })
  roadmapsVinculados!: number;
  @ApiProperty() totalCards!: number;
  @ApiProperty() cardsConcluidos!: number;
  @ApiProperty() percentualConclusao!: number;

  @ApiProperty() criadoEm!: Date;
  @ApiProperty() atualizadoEm!: Date;
}

export class CriarProjetoDto {
  @ApiProperty({ maxLength: 200, example: 'Portal do cliente' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  nome!: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  descricao?: string;

  @ApiPropertyOptional({ maxLength: 30, example: '#4186e0' })
  @IsString()
  @MaxLength(30)
  @IsOptional()
  cor?: string;
}

export class AtualizarProjetoDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  @IsOptional()
  nome?: string;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @IsOptional()
  descricao?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 30 })
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(30)
  @IsOptional()
  cor?: string | null;

  @ApiPropertyOptional({ description: 'Arquivado some da lista padrao e do formulario de roadmap' })
  @IsBoolean()
  @IsOptional()
  arquivado?: boolean;
}

export class VincularProjetoAsanaDto {
  @ApiProperty({
    nullable: true,
    description:
      'Id local (catalogo) do projeto do Asana. null desfaz o vinculo, o que so e ' +
      'permitido enquanto nenhum roadmap do projeto estiver vinculado ao Asana.',
  })
  @ValidateIf((_, v) => v !== null)
  @Type(() => Number)
  @IsInt()
  idAsanaProjeto!: number | null;
}

export class FiltroProjetosLocaisDto {
  @ApiPropertyOptional({ default: false })
  // Query string chega como texto: "false" precisa virar false, nao true.
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  @IsOptional()
  incluirArquivados?: boolean;

  @ApiPropertyOptional({ description: 'Parte do nome' })
  @IsString()
  @MaxLength(200)
  @IsOptional()
  busca?: string;
}
