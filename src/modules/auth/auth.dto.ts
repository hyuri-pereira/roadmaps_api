import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, IsUrl, MinLength } from 'class-validator';
import { UsuarioDto } from '../usuarios/usuarios.dto';

export class LoginLocalDto {
  @ApiProperty({ example: 'gestor@empresa.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  senha!: string;
}

export class RefreshDto {
  @ApiProperty({ description: 'Refresh token recebido no login' })
  @IsString()
  refreshToken!: string;
}

export class TokensDto {
  @ApiProperty({ description: 'JWT de acesso, enviado em Authorization: Bearer' })
  accessToken!: string;

  @ApiProperty({ description: 'Token opaco usado para renovar o acesso' })
  refreshToken!: string;

  @ApiProperty({ description: 'Segundos ate o access token expirar' })
  expiraEm!: number;

  @ApiProperty({ type: UsuarioDto })
  usuario!: UsuarioDto;
}

export class IniciarGoogleDto {
  @ApiPropertyOptional({
    description:
      'Para onde mandar o navegador depois do login. Precisa comecar com FRONTEND_URL.',
  })
  @IsUrl({ require_tld: false })
  @IsOptional()
  redirecionarPara?: string;
}

export class UrlAutorizacaoDto {
  @ApiProperty({ description: 'URL para onde o navegador deve ser enviado' })
  url!: string;

  @ApiProperty({ description: 'state gerado; util para depuracao' })
  estado!: string;
}
