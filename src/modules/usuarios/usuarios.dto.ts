import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Perfil } from '../../common/auth.types';

export const PERFIS: Perfil[] = ['ADMIN', 'GESTOR', 'LEITOR'];

export class UsuarioDto {
  @ApiProperty() id!: number;
  @ApiProperty() nome!: string;
  @ApiProperty({ description: 'E-mail de login' }) email!: string;
  @ApiProperty({ enum: PERFIS }) perfil!: Perfil;
  @ApiProperty() ativo!: boolean;

  @ApiPropertyOptional({ description: 'Provedor de login externo, ex.: GOOGLE' })
  authProvedor?: string | null;

  @ApiPropertyOptional() avatarUrl?: string | null;

  @ApiPropertyOptional({ description: 'E-mail que recebe os avisos (pode diferir do login)' })
  emailNotificacao?: string | null;

  @ApiPropertyOptional({ description: 'WhatsApp em E.164, ex.: +5511912345678' })
  whatsappE164?: string | null;

  @ApiPropertyOptional({ description: 'Quando o e-mail de aviso foi confirmado' })
  emailVerificadoEm?: Date | null;

  @ApiPropertyOptional({ description: 'Quando o WhatsApp foi confirmado pelo QR code' })
  whatsappVerificadoEm?: Date | null;

  @ApiPropertyOptional() ultimoLoginEm?: Date | null;
  @ApiProperty() criadoEm!: Date;
}

export class CriarUsuarioDto {
  @ApiProperty({ maxLength: 150 })
  @IsString()
  @MaxLength(150)
  nome!: string;

  @ApiProperty({ maxLength: 254 })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiPropertyOptional({
    description: 'Senha para login local. Omita para permitir apenas login Google.',
    minLength: 10,
  })
  @IsString()
  @MinLength(10)
  @IsOptional()
  senha?: string;

  @ApiPropertyOptional({ enum: PERFIS, default: 'GESTOR' })
  @IsIn(PERFIS)
  @IsOptional()
  perfil?: Perfil;
}

export class AtualizarUsuarioDto {
  @ApiPropertyOptional({ maxLength: 150 })
  @IsString()
  @MaxLength(150)
  @IsOptional()
  nome?: string;

  @ApiPropertyOptional({ enum: PERFIS })
  @IsIn(PERFIS)
  @IsOptional()
  perfil?: Perfil;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  ativo?: boolean;
}

export class AtualizarContatoDto {
  @ApiPropertyOptional({
    description:
      'E-mail que vai receber os avisos. Trocar este valor zera a verificacao ' +
      'e um novo e-mail de confirmacao e enviado.',
  })
  @IsEmail()
  @MaxLength(254)
  @IsOptional()
  emailNotificacao?: string | null;

  @ApiPropertyOptional({
    description:
      'Celular do gestor. Aceita "(11) 91234-5678" ou "+5511912345678". ' +
      'Trocar o numero derruba a verificacao do WhatsApp: e preciso ler o QR de novo.',
  })
  @IsString()
  @MaxLength(25)
  @IsOptional()
  whatsapp?: string | null;
}

export class DefinirSenhaDto {
  @ApiPropertyOptional({ description: 'Senha atual. Obrigatoria quando ja existe uma.' })
  @IsString()
  @IsOptional()
  senhaAtual?: string;

  @ApiProperty({ minLength: 10 })
  @IsString()
  @MinLength(10)
  novaSenha!: string;
}
