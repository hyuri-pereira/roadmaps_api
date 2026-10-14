import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export const ETAPAS = [
  'A_FAZER',
  'EM_DESENVOLVIMENTO',
  'PARADO',
  'PENDENCIA_EXTERNA',
  'EMERGENCIAS_DEMANDAS',
  'VALIDACAO',
  'CONCLUIDO',
  'ARQUIVADO',
] as const;

export const SITUACOES_SINC = [
  'LOCAL',
  'PENDENTE_CRIACAO',
  'PENDENTE_ATUALIZACAO',
  'SINCRONIZADO',
  'PENDENTE_EXCLUSAO',
  'CONFLITO',
  'ERRO',
] as const;

export class ReferenciaDto {
  @ApiProperty() id!: number;
  @ApiProperty({ enum: ['LINK', 'ARQUIVO'] }) tipo!: 'LINK' | 'ARQUIVO';
  @ApiPropertyOptional() rotulo?: string | null;
  @ApiProperty({ description: 'URL publicada no corpo da tarefa do Asana' })
  url!: string;
  @ApiPropertyOptional() nomeArquivo?: string | null;
  @ApiPropertyOptional() mimeType?: string | null;
  @ApiPropertyOptional() tamanhoBytes?: number | null;
  @ApiProperty() ordem!: number;
  @ApiProperty() criadoEm!: Date;
}

export class CardDto {
  @ApiProperty() id!: number;
  @ApiProperty() idRoadmap!: number;
  @ApiProperty({ description: 'Titulo atual. Espelha o Asana quando editado la.' })
  titulo!: string;
  @ApiPropertyOptional({ description: 'Titulo que o sistema gerou ao criar o card' })
  tituloGerado?: string | null;

  @ApiPropertyOptional({ description: 'Texto do card sem o bloco de links' })
  descricaoBase?: string | null;
  @ApiPropertyOptional({ description: 'Corpo completo como esta no Asana' })
  descricao?: string | null;

  @ApiPropertyOptional({ description: 'AAAA-MM-DD' }) dataLimite?: string | null;
  @ApiProperty({ description: '1=URGENTE, 2=ALTA, 3=MEDIA, 4=BAIXA', minimum: 1, maximum: 4 })
  prioridade!: number;
  @ApiProperty({ description: 'true = SPRINT/"A fazer"; false = Backlog/"Refino"' })
  entrarNaSprint!: boolean;

  @ApiProperty() concluido!: boolean;
  @ApiProperty() conclusaoSolicitada!: boolean;
  @ApiPropertyOptional() concluidoEm?: Date | null;

  @ApiPropertyOptional({ enum: ETAPAS, description: 'Coluna atual no quadro SPRINT' })
  etapaSprint?: string | null;
  @ApiPropertyOptional() etapaNome?: string | null;

  @ApiPropertyOptional() asanaTarefaGid?: string | null;
  @ApiPropertyOptional() asanaPermalink?: string | null;
  @ApiPropertyOptional() asanaResponsavelNome?: string | null;

  @ApiProperty({ enum: SITUACOES_SINC }) situacaoSincronizacao!: string;
  @ApiPropertyOptional() ultimoErro?: string | null;
  @ApiPropertyOptional() asanaModificadoEm?: Date | null;
  @ApiPropertyOptional() sincronizadoEm?: Date | null;

  @ApiProperty() ordem!: number;
  @ApiProperty() revisao!: number;
  @ApiProperty() criadoEm!: Date;
  @ApiProperty() atualizadoEm!: Date;

  @ApiPropertyOptional({ type: [ReferenciaDto] })
  referencias?: ReferenciaDto[];
}

export class LinkReferenciaDto {
  @ApiPropertyOptional({ maxLength: 255, description: 'Texto exibido antes da URL' })
  @IsString()
  @MaxLength(255)
  @IsOptional()
  rotulo?: string;

  @ApiProperty({ maxLength: 2048 })
  @IsUrl({ require_tld: false })
  @MaxLength(2048)
  url!: string;
}

export class CriarCardDto {
  @ApiPropertyOptional({
    description:
      'Texto do card. O bloco "Links de referencia:" e acrescentado automaticamente ' +
      'no fim, a partir dos links e arquivos cadastrados.',
  })
  @IsString()
  @IsOptional()
  descricao?: string;

  @ApiPropertyOptional({
    description: 'AAAA-MM-DD. Sem prazo, a secao da data some do titulo do card.',
  })
  @IsDateString()
  @IsOptional()
  dataLimite?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 4, default: 3 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(4)
  @IsOptional()
  prioridade?: number;

  @ApiPropertyOptional({
    default: false,
    description:
      'Marcado: o card nasce no projeto SPRINT, coluna "A fazer". ' +
      'Desmarcado: nasce no Backlog, coluna "Refino".',
  })
  @IsBoolean()
  @IsOptional()
  entrarNaSprint?: boolean;

  @ApiPropertyOptional({
    type: [LinkReferenciaDto],
    description: 'Links de referencia que vao para o corpo da tarefa.',
  })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => LinkReferenciaDto)
  @IsOptional()
  links?: LinkReferenciaDto[];

  @ApiPropertyOptional({
    description:
      'Titulo customizado. Em branco, o sistema gera ' +
      'PROJETO - PRIORIDADE - PRAZO - ROADMAP.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  @IsOptional()
  titulo?: string;
}

export class AtualizarCardDto {
  @ApiPropertyOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  @IsOptional()
  titulo?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  descricao?: string;

  @ApiPropertyOptional({ description: 'AAAA-MM-DD. Envie null para remover o prazo.' })
  @IsDateString()
  @IsOptional()
  dataLimite?: string | null;

  @ApiPropertyOptional({ minimum: 1, maximum: 4 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(4)
  @IsOptional()
  prioridade?: number;

  @ApiPropertyOptional({
    description:
      'Mudar este campo move o card entre SPRINT e Backlog. Editar so descricao ou ' +
      'prioridade nao move um card que ja esta em andamento.',
  })
  @IsBoolean()
  @IsOptional()
  entrarNaSprint?: boolean;

  @ApiPropertyOptional()
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  ordem?: number;

  @ApiPropertyOptional({
    description:
      'Regenera o titulo a partir do padrao PROJETO - PRIORIDADE - PRAZO - ROADMAP, ' +
      'descartando um titulo editado no Asana.',
  })
  @IsBoolean()
  @IsOptional()
  regenerarTitulo?: boolean;

  @ApiPropertyOptional({
    description:
      'Revisao que o cliente tinha ao abrir o card. Se o card mudou desde entao ' +
      '(webhook do Asana, por exemplo), a API responde 409 em vez de sobrescrever.',
  })
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  revisaoEsperada?: number;
}

export class ConcluirCardDto {
  @ApiProperty({ description: 'true conclui, false reabre o card' })
  @IsBoolean()
  concluido!: boolean;
}

export class FiltroCardsDto {
  @ApiPropertyOptional({ enum: ETAPAS })
  @IsIn(ETAPAS as unknown as string[])
  @IsOptional()
  etapaSprint?: string;

  @ApiPropertyOptional()
  @Type(() => Boolean)
  @IsBoolean()
  @IsOptional()
  concluido?: boolean;

  @ApiPropertyOptional()
  @Type(() => Boolean)
  @IsBoolean()
  @IsOptional()
  entrarNaSprint?: boolean;

  @ApiPropertyOptional({ enum: SITUACOES_SINC })
  @IsIn(SITUACOES_SINC as unknown as string[])
  @IsOptional()
  situacaoSincronizacao?: string;
}

export class ReordenarCardsDto {
  @ApiProperty({ type: [Number], description: 'Ids dos cards na ordem desejada' })
  @IsArray()
  @Type(() => Number)
  ids!: number[];
}
