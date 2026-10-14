import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUrl, MaxLength, MinLength } from 'class-validator';

export type TipoAutenticacaoAsana = 'PAT' | 'OAUTH2';

export class ConexaoAsanaDto {
  @ApiProperty() id!: number;
  @ApiProperty() idUsuario!: number;
  @ApiProperty({ description: 'Apelido dado pelo gestor' }) nome!: string;
  @ApiProperty({ enum: ['PAT', 'OAUTH2'] }) tipoAutenticacao!: TipoAutenticacaoAsana;

  @ApiPropertyOptional() asanaUsuarioGid?: string | null;
  @ApiPropertyOptional() asanaUsuarioNome?: string | null;
  @ApiPropertyOptional() asanaUsuarioEmail?: string | null;

  @ApiProperty({ description: 'Conexao usada por padrao ao criar roadmaps' })
  padrao!: boolean;

  @ApiProperty() ativo!: boolean;

  @ApiPropertyOptional({ description: 'Quando o access token OAuth expira' })
  tokenExpiraEm?: Date | null;

  @ApiPropertyOptional() ultimaSincronizacaoEm?: Date | null;
  @ApiPropertyOptional({ description: 'Ultimo erro registrado ao usar esta conexao' })
  ultimoErro?: string | null;

  @ApiProperty() criadoEm!: Date;
}

export class CriarConexaoPatDto {
  @ApiProperty({
    maxLength: 100,
    description: 'Apelido para identificar a conexao, ex.: "Minha conta Asana"',
  })
  @IsString()
  @MaxLength(100)
  nome!: string;

  @ApiProperty({
    description:
      'Personal Access Token gerado em https://app.asana.com/0/my-apps. ' +
      'O token e cifrado com AES-256-GCM antes de ir para o banco e nunca volta pela API.',
  })
  @IsString()
  @MinLength(20)
  token!: string;
}

export class AtualizarConexaoDto {
  @ApiPropertyOptional({ maxLength: 100 })
  @IsString()
  @MaxLength(100)
  @IsOptional()
  nome?: string;

  @ApiPropertyOptional({ description: 'Novo PAT. So vale para conexoes do tipo PAT.' })
  @IsString()
  @MinLength(20)
  @IsOptional()
  token?: string;
}

export class IniciarOAuthAsanaDto {
  @ApiPropertyOptional({ maxLength: 100, default: 'Asana (OAuth)' })
  @IsString()
  @MaxLength(100)
  @IsOptional()
  nome?: string;

  @ApiPropertyOptional({ description: 'Para onde voltar depois de autorizar' })
  @IsUrl({ require_tld: false })
  @IsOptional()
  redirecionarPara?: string;
}

export class TestarConexaoDto {
  @ApiProperty() ok!: boolean;
  @ApiProperty() usuario!: string;
  @ApiPropertyOptional() email?: string | null;
  @ApiProperty({ description: 'Workspaces visiveis por esta credencial', isArray: true })
  workspaces!: { gid: string; nome: string }[];
}

export class FiltroConexaoDto {
  @ApiPropertyOptional({ enum: ['PAT', 'OAUTH2'] })
  @IsIn(['PAT', 'OAUTH2'])
  @IsOptional()
  tipoAutenticacao?: TipoAutenticacaoAsana;
}
