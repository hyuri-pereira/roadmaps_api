import { BadRequestException, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createReadStream, existsSync } from 'fs';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { extname, join, resolve } from 'path';
import { randomUUID } from 'crypto';
import { AppConfig, CONFIG_APP } from '../../common/config/configuration';

export interface ArquivoSalvo {
  objeto: string;
  nomeOriginal: string;
  mimeType: string;
  tamanhoBytes: number;
}

/**
 * Arquivos de referencia ficam FORA do Firebird.
 *
 * A URL gravada em ITEM_REFERENCIAS aponta para a rota autenticada e duravel
 * da aplicacao (/cards/referencias/:id/download), nunca para uma URL assinada
 * temporaria: o link vai para o corpo da tarefa no Asana e precisa continuar
 * valido meses depois, com o acesso sendo checado a cada download.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly raiz: string;

  constructor(@Inject(CONFIG_APP) private readonly config: AppConfig) {
    this.raiz = resolve(process.cwd(), config.storage.caminhoLocal);
  }

  async onModuleInit(): Promise<void> {
    await mkdir(this.raiz, { recursive: true });
    this.logger.log(`Arquivos de referencia em ${this.raiz}`);
  }

  validar(arquivo: { mimetype: string; size: number; originalname: string }): void {
    if (arquivo.size > this.config.storage.tamanhoMaximoBytes) {
      const limiteMb = Math.round(this.config.storage.tamanhoMaximoBytes / 1024 / 1024);
      throw new BadRequestException(`Arquivo maior que o limite de ${limiteMb} MB.`);
    }
    const permitidos = this.config.storage.mimesPermitidos;
    if (permitidos.length && !permitidos.includes(arquivo.mimetype)) {
      throw new BadRequestException(
        `Tipo de arquivo "${arquivo.mimetype}" nao permitido. ` +
          'Ajuste STORAGE_MIME_PERMITIDOS no .env se precisar liberar.',
      );
    }
  }

  async salvar(arquivo: {
    buffer: Buffer;
    originalname: string;
    mimetype: string;
    size: number;
  }): Promise<ArquivoSalvo> {
    this.validar(arquivo);

    // Nome no disco e sempre gerado por nos: o nome original vai apenas para
    // o banco e para o Content-Disposition do download.
    const extensao = extname(arquivo.originalname).slice(0, 12);
    const objeto = `${randomUUID()}${extensao}`;
    await mkdir(this.raiz, { recursive: true });
    await writeFile(join(this.raiz, objeto), arquivo.buffer);

    return {
      objeto,
      nomeOriginal: arquivo.originalname,
      mimeType: arquivo.mimetype,
      tamanhoBytes: arquivo.size,
    };
  }

  caminhoDe(objeto: string): string {
    // Impede que um valor manipulado escape da pasta de armazenamento.
    const caminho = resolve(this.raiz, objeto);
    if (!caminho.startsWith(this.raiz)) {
      throw new BadRequestException('Caminho de arquivo invalido.');
    }
    return caminho;
  }

  existe(objeto: string): boolean {
    try {
      return existsSync(this.caminhoDe(objeto));
    } catch {
      return false;
    }
  }

  abrir(objeto: string) {
    return createReadStream(this.caminhoDe(objeto));
  }

  async remover(objeto: string | null | undefined): Promise<void> {
    if (!objeto) return;
    try {
      await unlink(this.caminhoDe(objeto));
    } catch (erro) {
      // Arquivo ausente nao e problema: o registro no banco e a fonte da verdade.
      this.logger.warn(`Nao foi possivel apagar o arquivo ${objeto}: ${(erro as Error).message}`);
    }
  }

  /** URL duravel e autenticada que vai para o corpo da tarefa no Asana. */
  urlPublica(idReferencia: number): string {
    return `${this.config.app.urlPublica}/${this.config.app.prefixo}/cards/referencias/${idReferencia}/download`;
  }
}
