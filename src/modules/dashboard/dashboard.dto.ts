import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class VisaoGeralDto {
  @ApiProperty() totalRoadmaps!: number;
  @ApiProperty() roadmapsConcluidos!: number;
  @ApiProperty() roadmapsAtivos!: number;
  @ApiProperty() totalCards!: number;
  @ApiProperty() cardsConcluidos!: number;
  @ApiProperty({ description: 'Percentual geral, considerando todos os cards' })
  percentualGeral!: number;
}

export class VisaoProjetoDto {
  @ApiProperty({ description: 'Projeto local' }) idProjeto!: number;
  @ApiPropertyOptional({ nullable: true, description: 'GID do projeto do Asana vinculado' })
  asanaGid?: string | null;
  @ApiProperty() projeto!: string;
  @ApiPropertyOptional() idEquipe?: number | null;
  @ApiProperty() totalRoadmaps!: number;
  @ApiProperty() roadmapsConcluidos!: number;
  @ApiProperty() roadmapsAtivos!: number;
  @ApiProperty() totalCards!: number;
  @ApiProperty() cardsConcluidos!: number;
  @ApiProperty() percentualGeral!: number;
}

export class CardAcompanhamentoDto {
  @ApiProperty() id!: number;
  @ApiProperty() idRoadmap!: number;
  @ApiProperty() roadmap!: string;
  @ApiProperty() titulo!: string;
  @ApiPropertyOptional() dataLimite?: string | null;
  @ApiProperty() prioridade!: number;
  @ApiProperty() entrarNaSprint!: boolean;
  @ApiProperty() concluido!: boolean;
  @ApiPropertyOptional({ description: 'Coluna atual no quadro SPRINT' })
  etapa?: string | null;
  @ApiPropertyOptional() etapaNome?: string | null;
  @ApiPropertyOptional() etapaOrdem?: number | null;
  @ApiPropertyOptional() responsavel?: string | null;
  @ApiPropertyOptional() permalink?: string | null;
  @ApiProperty() situacaoSincronizacao!: string;
  @ApiPropertyOptional() sincronizadoEm?: Date | null;
}

export class ColunaQuadroDto {
  @ApiProperty() codigo!: string;
  @ApiProperty() nome!: string;
  @ApiProperty() ordem!: number;
  @ApiProperty() total!: number;
  @ApiProperty({ type: [CardAcompanhamentoDto] })
  cards!: CardAcompanhamentoDto[];
}
