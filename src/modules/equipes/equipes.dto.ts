import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, ValidateNested } from 'class-validator';

export class GestorDaEquipeDto {
  @ApiProperty() idUsuario!: number;
  @ApiProperty() nome!: string;
  @ApiProperty() email!: string;
  @ApiProperty() podeEditar!: boolean;
  @ApiProperty() ativo!: boolean;
}

export class DestinosEquipeDto {
  @ApiProperty() idEquipe!: number;
  @ApiProperty() equipeNome!: string;

  @ApiProperty({ description: 'Projeto SPRINT: destino dos cards marcados' })
  idProjetoSprint!: number;
  @ApiProperty() projetoSprintNome!: string;

  @ApiProperty({ description: 'Secao "A fazer" do SPRINT' })
  idSecaoAFazer!: number;
  @ApiProperty() secaoAFazerNome!: string;

  @ApiProperty({ description: 'Projeto Backlog: destino dos cards desmarcados' })
  idProjetoBacklog!: number;
  @ApiProperty() projetoBacklogNome!: string;

  @ApiProperty({ description: 'Secao "Refino" do Backlog' })
  idSecaoRefino!: number;
  @ApiProperty() secaoRefinoNome!: string;

  @ApiProperty() atualizadoEm!: Date;
}

export class DefinirDestinosDto {
  @ApiProperty({ description: 'Id local do projeto SPRINT' })
  @Type(() => Number)
  @IsInt()
  idProjetoSprint!: number;

  @ApiProperty({ description: 'Id local da secao "A fazer"' })
  @Type(() => Number)
  @IsInt()
  idSecaoAFazer!: number;

  @ApiProperty({ description: 'Id local do projeto Backlog' })
  @Type(() => Number)
  @IsInt()
  idProjetoBacklog!: number;

  @ApiProperty({ description: 'Id local da secao "Refino"' })
  @Type(() => Number)
  @IsInt()
  idSecaoRefino!: number;
}

export class EtapaMapeadaDto {
  @ApiProperty({ example: 'PARADO' })
  @IsString()
  codigo!: string;

  @ApiProperty({ description: 'Id local da secao do projeto SPRINT' })
  @Type(() => Number)
  @IsInt()
  idSecao!: number;
}

export class MapearEtapasDto {
  @ApiProperty({
    type: [EtapaMapeadaDto],
    description:
      'Mapa das colunas do quadro SPRINT. Sem este mapa o sistema nao sabe quando um card ' +
      'entrou em "Parado" ou "Pendencia externa", e os avisos correspondentes nunca disparam.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => EtapaMapeadaDto)
  etapas!: EtapaMapeadaDto[];
}

export class EtapaConfiguradaDto {
  @ApiProperty() codigo!: string;
  @ApiProperty() nome!: string;
  @ApiProperty() ordem!: number;
  @ApiPropertyOptional() idSecao?: number | null;
  @ApiPropertyOptional() secaoNome?: string | null;
}

export class AdicionarGestorDto {
  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  idUsuario!: number;

  @ApiPropertyOptional({ default: true, description: 'false deixa o gestor como leitor da equipe' })
  @IsBoolean()
  @IsOptional()
  podeEditar?: boolean;
}

export class EquipeConfiguradaDto {
  @ApiProperty() id!: number;
  @ApiProperty() nome!: string;
  @ApiProperty() asanaGid!: string;
  @ApiProperty() podeEditar!: boolean;
  @ApiProperty({ description: 'Se ja existe EQUIPE_DESTINOS gravado' })
  destinosConfigurados!: boolean;
  @ApiProperty({ description: 'Quantas das 8 colunas do SPRINT ja estao mapeadas' })
  etapasMapeadas!: number;
}
