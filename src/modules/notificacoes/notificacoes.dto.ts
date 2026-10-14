import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export const EVENTOS_NOTIFICACAO = [
  'ROADMAP_CONCLUIDO',
  'CARD_PARADO',
  'CARD_PENDENCIA_EXTERNA',
  'CARD_CONCLUIDO',
] as const;

export const CANAIS = ['EMAIL', 'WHATSAPP'] as const;

export type EventoNotificacao = (typeof EVENTOS_NOTIFICACAO)[number];
export type CanalNotificacao = (typeof CANAIS)[number];

export class PreferenciaDto {
  @ApiProperty({ enum: EVENTOS_NOTIFICACAO }) evento!: EventoNotificacao;
  @ApiProperty({ enum: CANAIS }) canal!: CanalNotificacao;
  @ApiProperty() ativo!: boolean;
  @ApiPropertyOptional({ description: 'Quando o gestor autorizou este canal' })
  consentimentoEm?: Date | null;
  @ApiProperty({
    description: 'Se o canal esta pronto para receber (contato informado e verificado)',
  })
  pronto!: boolean;
  @ApiPropertyOptional({ description: 'O que falta para o canal funcionar' })
  pendencia?: string | null;
}

export class DefinirPreferenciaDto {
  @ApiProperty({ enum: EVENTOS_NOTIFICACAO })
  @IsIn(EVENTOS_NOTIFICACAO as unknown as string[])
  evento!: EventoNotificacao;

  @ApiProperty({ enum: CANAIS })
  @IsIn(CANAIS as unknown as string[])
  canal!: CanalNotificacao;

  @ApiProperty({ description: 'true liga o aviso e registra o consentimento' })
  @IsBoolean()
  ativo!: boolean;
}

export class DefinirPreferenciasDto {
  @ApiProperty({ type: [DefinirPreferenciaDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => DefinirPreferenciaDto)
  preferencias!: DefinirPreferenciaDto[];
}

export class NotificacaoFilaDto {
  @ApiProperty() id!: number;
  @ApiProperty() idEvento!: number;
  @ApiProperty({ enum: EVENTOS_NOTIFICACAO }) evento!: EventoNotificacao;
  @ApiProperty() resumo!: string;
  @ApiProperty({ enum: CANAIS }) canal!: CanalNotificacao;
  @ApiProperty() destinatario!: string;
  @ApiProperty() situacao!: string;
  @ApiProperty() tentativas!: number;
  @ApiProperty() proximaTentativaEm!: Date;
  @ApiPropertyOptional() enviadoEm?: Date | null;
  @ApiPropertyOptional() ultimoErro?: string | null;
}

export class ConfiguracaoEmailDto {
  @ApiProperty() remetenteEmail!: string;
  @ApiProperty() remetenteNome!: string;
  @ApiProperty() host!: string;
  @ApiProperty() porta!: number;
  @ApiProperty({ enum: ['TLS', 'STARTTLS'] }) seguranca!: 'TLS' | 'STARTTLS';
  @ApiPropertyOptional() usuario?: string | null;
  @ApiProperty() ativo!: boolean;
  @ApiProperty({ description: 'A senha nunca e devolvida; apenas indica se existe' })
  senhaDefinida!: boolean;
}

export class SalvarConfiguracaoEmailDto {
  @ApiProperty()
  @IsEmail()
  remetenteEmail!: string;

  @ApiProperty()
  @IsString()
  remetenteNome!: string;

  @ApiProperty()
  @IsString()
  host!: string;

  @ApiProperty({ minimum: 1, maximum: 65535 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  porta!: number;

  @ApiProperty({ enum: ['TLS', 'STARTTLS'] })
  @IsIn(['TLS', 'STARTTLS'])
  seguranca!: 'TLS' | 'STARTTLS';

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  usuario?: string;

  @ApiPropertyOptional({ description: 'Deixe em branco para manter a senha atual' })
  @IsString()
  @IsOptional()
  senha?: string;

  @ApiProperty()
  @IsBoolean()
  ativo!: boolean;
}

export class ResumoNotificacoesDto {
  @ApiProperty() pendentes!: number;
  @ApiProperty() enviadasUltimas24h!: number;
  @ApiProperty() comErro!: number;
  @ApiProperty() canceladas!: number;
}
