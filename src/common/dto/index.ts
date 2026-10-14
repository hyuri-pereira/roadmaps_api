import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class PaginacaoDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, description: 'Pagina, comecando em 1' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  pagina = 1;

  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 200 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  @IsOptional()
  tamanho = 25;

  @ApiPropertyOptional({ description: 'Filtro textual livre' })
  @IsString()
  @MaxLength(200)
  @IsOptional()
  busca?: string;

  get offset(): number {
    return (this.pagina - 1) * this.tamanho;
  }
}

export class RespostaPaginadaDto<T> {
  @ApiProperty({ isArray: true })
  itens!: T[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  pagina!: number;

  @ApiProperty()
  tamanho!: number;

  @ApiProperty()
  paginas!: number;

  static de<T>(itens: T[], total: number, paginacao: PaginacaoDto): RespostaPaginadaDto<T> {
    return {
      itens,
      total,
      pagina: paginacao.pagina,
      tamanho: paginacao.tamanho,
      paginas: Math.max(1, Math.ceil(total / paginacao.tamanho)),
    };
  }
}

export class MensagemDto {
  @ApiProperty({ example: 'Operacao realizada com sucesso.' })
  mensagem!: string;
}
