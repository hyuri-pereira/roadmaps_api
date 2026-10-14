import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString } from 'class-validator';

export class WorkspaceDto {
  @ApiProperty() id!: number;
  @ApiProperty() asanaGid!: string;
  @ApiProperty() nome!: string;
  @ApiPropertyOptional() sincronizadoEm?: Date | null;
}

export class EquipeAsanaDto {
  @ApiProperty() id!: number;
  @ApiProperty() idWorkspace!: number;
  @ApiProperty() asanaGid!: string;
  @ApiProperty() nome!: string;
  @ApiProperty({ description: 'Se a equipe ja tem destinos SPRINT/Backlog configurados' })
  configurada!: boolean;
}

export class ProjetoAsanaDto {
  @ApiProperty() id!: number;
  @ApiProperty() asanaGid!: string;
  @ApiProperty() nome!: string;
  @ApiPropertyOptional() idEquipe?: number | null;
  @ApiPropertyOptional() equipeNome?: string | null;
  @ApiPropertyOptional() cor?: string | null;
  @ApiPropertyOptional() layout?: string | null;
  @ApiPropertyOptional() urlRecurso?: string | null;
  @ApiProperty() arquivado!: boolean;
  @ApiProperty() concluido!: boolean;
  @ApiPropertyOptional() asanaModificadoEm?: Date | null;
  @ApiPropertyOptional() sincronizadoEm?: Date | null;
}

export class SecaoAsanaDto {
  @ApiProperty() id!: number;
  @ApiProperty() idProjeto!: number;
  @ApiProperty() asanaGid!: string;
  @ApiProperty() nome!: string;
  @ApiProperty() ordem!: number;
  @ApiProperty() ativo!: boolean;
}

export class FiltroProjetosDto {
  @ApiPropertyOptional({ description: 'Filtra por equipe do catalogo local' })
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  idEquipe?: number;

  @ApiPropertyOptional({ description: 'Filtra por workspace do catalogo local' })
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  idWorkspace?: number;

  @ApiPropertyOptional({ default: false, description: 'Inclui projetos arquivados' })
  @Type(() => Boolean)
  @IsBoolean()
  @IsOptional()
  incluirArquivados?: boolean;

  @ApiPropertyOptional({ description: 'Busca por parte do nome' })
  @IsString()
  @IsOptional()
  busca?: string;
}

export class ResultadoSincronizacaoDto {
  @ApiProperty() workspaces!: number;
  @ApiProperty() equipes!: number;
  @ApiProperty() projetos!: number;
  @ApiProperty() secoes!: number;
  @ApiProperty() duracaoMs!: number;
  @ApiPropertyOptional({ isArray: true, type: String })
  avisos?: string[];
}
