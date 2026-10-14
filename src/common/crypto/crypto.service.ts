import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'crypto';
import { AppConfig, CONFIG_APP } from '../config/configuration';

/**
 * Envelope AEAD (AES-256-GCM) usado para tudo que precisa voltar em claro:
 * access/refresh token do Asana, API key do WAHA, senha SMTP e o segredo do
 * webhook do Asana.
 *
 * Formato gravado no BLOB: [ iv(12) | tag(16) | ciphertext ]
 * O envelope e autossuficiente; a coluna *_NONCE_BASE64 do schema recebe o
 * mesmo iv em base64 para inspecao/auditoria, e VERSAO_CHAVE aponta para a
 * chave que esta fora do banco (no .env). Nunca grave segredo em claro.
 *
 * A chave nunca fica no banco: rotacionar significa gerar ENCRYPTION_KEY nova,
 * mover a antiga para ENCRYPTION_KEYS_LEGACY e regravar os registros.
 */

export interface EnvelopeCifrado {
  conteudo: Buffer;
  nonceBase64: string;
  versaoChave: string;
}

const TAMANHO_IV = 12;
const TAMANHO_TAG = 16;

@Injectable()
export class CryptoService {
  constructor(@Inject(CONFIG_APP) private readonly config: AppConfig) {}

  /**
   * @param proposito rotulo ligado ao envelope (AAD). Impede que um envelope
   *        gravado para um fim seja aceito em outro contexto.
   */
  cifrar(textoPlano: string, proposito: string): EnvelopeCifrado {
    const iv = randomBytes(TAMANHO_IV);
    const cifra = createCipheriv('aes-256-gcm', this.config.seguranca.chaveAtual, iv);
    cifra.setAAD(Buffer.from(proposito, 'utf8'));
    const cifrado = Buffer.concat([cifra.update(textoPlano, 'utf8'), cifra.final()]);
    const tag = cifra.getAuthTag();

    return {
      conteudo: Buffer.concat([iv, tag, cifrado]),
      nonceBase64: iv.toString('base64'),
      versaoChave: this.config.seguranca.versaoChave,
    };
  }

  decifrar(envelope: Buffer | null | undefined, proposito: string, versaoChave?: string): string {
    if (!envelope || envelope.length <= TAMANHO_IV + TAMANHO_TAG) {
      throw new InternalServerErrorException('Envelope cifrado ausente ou invalido');
    }

    const chave = this.resolverChave(versaoChave);
    const iv = envelope.subarray(0, TAMANHO_IV);
    const tag = envelope.subarray(TAMANHO_IV, TAMANHO_IV + TAMANHO_TAG);
    const cifrado = envelope.subarray(TAMANHO_IV + TAMANHO_TAG);

    try {
      const decifra = createDecipheriv('aes-256-gcm', chave, iv);
      decifra.setAAD(Buffer.from(proposito, 'utf8'));
      decifra.setAuthTag(tag);
      return Buffer.concat([decifra.update(cifrado), decifra.final()]).toString('utf8');
    } catch {
      throw new InternalServerErrorException(
        `Falha ao decifrar "${proposito}". A ENCRYPTION_KEY provavelmente mudou sem ` +
          'a chave anterior estar em ENCRYPTION_KEYS_LEGACY.',
      );
    }
  }

  private resolverChave(versao?: string): Buffer {
    if (!versao || versao === this.config.seguranca.versaoChave) {
      return this.config.seguranca.chaveAtual;
    }
    const legada = this.config.seguranca.chavesLegadas.get(versao);
    if (!legada) {
      throw new InternalServerErrorException(
        `A chave de criptografia "${versao}" nao esta disponivel. ` +
          'Adicione-a em ENCRYPTION_KEYS_LEGACY para ler os registros antigos.',
      );
    }
    return legada;
  }

  /** Hash usado para guardar refresh tokens sem poder reconstrui-los. */
  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Comparacao sem vazar tempo, para segredos de webhook. */
  compararSegredo(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }

  gerarTokenAleatorio(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }
}
