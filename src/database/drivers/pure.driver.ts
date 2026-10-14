/* eslint-disable @typescript-eslint/no-var-requires */
import { Logger } from '@nestjs/common';
import {
  ConexaoFirebird,
  DriverFirebirdContrato,
  ErroFirebird,
  Linha,
  OpcoesConexaoFirebird,
  Parametro,
  TransacaoFirebird,
} from './driver.interface';

/**
 * Driver baseado em "node-firebird": fala o protocolo do Firebird direto por
 * TCP, sem depender do fbclient.dll. Por isso funciona com Node x64 mesmo
 * quando o servidor Firebird instalado e de 32 bits.
 *
 * Limitacao conhecida: a biblioteca nao implementa wire encryption, entao o
 * servidor precisa estar com "WireCrypt = Enabled" no firebird.conf.
 */

type NodeFirebird = any;
type DbNodeFirebird = any;

export class PureDriver implements DriverFirebirdContrato {
  readonly nome = 'pure' as const;
  private readonly logger = new Logger(PureDriver.name);
  private firebird!: NodeFirebird;
  private pool: any;

  constructor(private readonly opcoes: OpcoesConexaoFirebird) {}

  private get opcoesDriver() {
    return {
      host: this.opcoes.host,
      port: this.opcoes.porta,
      database: this.opcoes.database,
      user: this.opcoes.usuario,
      password: this.opcoes.senha,
      lowercase_keys: false,
      role: null,
      pageSize: this.opcoes.pageSize,
      encoding: this.opcoes.charset,
      retryConnectionInterval: 1000,
      blobAsText: false,
    };
  }

  async iniciar(): Promise<void> {
    this.firebird = require('node-firebird');
    this.pool = this.firebird.pool(this.opcoes.poolMax, this.opcoesDriver);
    // Valida a conexao logo no boot: melhor falhar aqui do que na 1a request.
    const conexao = await this.obterConexao();
    try {
      await conexao.query('SELECT 1 AS OK FROM RDB$DATABASE');
    } finally {
      await conexao.liberar();
    }
    this.logger.log(
      `Conectado em ${this.opcoes.host}:${this.opcoes.porta} (driver puro, pool ${this.opcoes.poolMax})`,
    );
  }

  async bancoExiste(): Promise<boolean> {
    const firebird = this.firebird ?? require('node-firebird');
    return new Promise((resolve) => {
      firebird.attach(this.opcoesDriver, (erro: any, db: DbNodeFirebird) => {
        if (erro) return resolve(false);
        db.detach(() => resolve(true));
      });
    });
  }

  async criarBanco(): Promise<void> {
    const firebird = this.firebird ?? require('node-firebird');
    await new Promise<void>((resolve, reject) => {
      firebird.create(this.opcoesDriver, (erro: any, db: DbNodeFirebird) => {
        if (erro) return reject(normalizarErro(erro));
        db.detach(() => resolve());
      });
    });
  }

  async obterConexao(): Promise<ConexaoFirebird> {
    if (!this.pool) {
      this.firebird = this.firebird ?? require('node-firebird');
      this.pool = this.firebird.pool(this.opcoes.poolMax, this.opcoesDriver);
    }
    const db = await new Promise<DbNodeFirebird>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new ErroFirebird('timeout ao obter conexao do pool Firebird')),
        this.opcoes.connectTimeoutMs,
      );
      this.pool.get((erro: any, conexao: DbNodeFirebird) => {
        clearTimeout(timer);
        if (erro) return reject(normalizarErro(erro));
        resolve(conexao);
      });
    });
    return new ConexaoPura(db, this.firebird);
  }

  async encerrar(): Promise<void> {
    if (!this.pool) return;
    await new Promise<void>((resolve) => this.pool.destroy(() => resolve()));
    this.pool = undefined;
  }
}

class ConexaoPura implements ConexaoFirebird {
  constructor(
    private readonly db: DbNodeFirebird,
    private readonly firebird: NodeFirebird,
  ) {}

  query<T = Linha>(sql: string, parametros: Parametro[] = []): Promise<T[]> {
    return executarConsulta<T>(this.db, sql, parametros);
  }

  async executar(sql: string, parametros: Parametro[] = []): Promise<void> {
    await executarConsulta(this.db, sql, parametros);
  }

  async iniciarTransacao(somenteLeitura = false): Promise<TransacaoFirebird> {
    const isolamento = somenteLeitura
      ? this.firebird.ISOLATION_READ_COMMITTED_READ_ONLY
      : this.firebird.ISOLATION_READ_COMMITTED;

    const transacao = await new Promise<any>((resolve, reject) => {
      this.db.transaction(isolamento, (erro: any, tx: any) => {
        if (erro) return reject(normalizarErro(erro));
        resolve(tx);
      });
    });
    return new TransacaoPura(transacao);
  }

  liberar(): Promise<void> {
    // Em conexao vinda do pool, detach devolve a conexao ao pool.
    return new Promise((resolve) => this.db.detach(() => resolve()));
  }
}

class TransacaoPura implements TransacaoFirebird {
  private finalizada = false;

  constructor(private readonly tx: any) {}

  query<T = Linha>(sql: string, parametros: Parametro[] = []): Promise<T[]> {
    this.garantirAberta();
    return executarConsulta<T>(this.tx, sql, parametros);
  }

  async queryUm<T = Linha>(sql: string, parametros: Parametro[] = []): Promise<T | null> {
    const linhas = await this.query<T>(sql, parametros);
    return linhas.length ? linhas[0] : null;
  }

  async executar(sql: string, parametros: Parametro[] = []): Promise<void> {
    this.garantirAberta();
    await executarConsulta(this.tx, sql, parametros);
  }

  commit(): Promise<void> {
    this.garantirAberta();
    this.finalizada = true;
    return new Promise((resolve, reject) => {
      this.tx.commit((erro: any) => (erro ? reject(normalizarErro(erro)) : resolve()));
    });
  }

  rollback(): Promise<void> {
    if (this.finalizada) return Promise.resolve();
    this.finalizada = true;
    return new Promise((resolve) => {
      this.tx.rollback(() => resolve());
    });
  }

  private garantirAberta() {
    if (this.finalizada) {
      throw new ErroFirebird('a transacao ja foi finalizada (commit/rollback)');
    }
  }
}

/**
 * Executa e normaliza o retorno.
 *
 * Dois detalhes do node-firebird tratados aqui:
 *  - INSERT ... RETURNING devolve um objeto, nao um array;
 *  - colunas BLOB voltam como funcao de leitura assincrona, entao precisam
 *    ser materializadas antes de a linha chegar na aplicacao.
 */
async function executarConsulta<T = Linha>(
  alvo: any,
  sql: string,
  parametros: Parametro[],
): Promise<T[]> {
  const bruto = await new Promise<any>((resolve, reject) => {
    alvo.query(sql, normalizarParametros(parametros), (erro: any, resultado: any) => {
      if (erro) return reject(normalizarErro(erro, sql));
      resolve(resultado);
    });
  });

  if (bruto === undefined || bruto === null) return [];
  const linhas: Linha[] = Array.isArray(bruto) ? bruto : [bruto];
  return (await Promise.all(linhas.map(materializarLinha))) as T[];
}

function normalizarParametros(parametros: Parametro[]): unknown[] {
  return parametros.map((valor) => (valor === undefined ? null : valor));
}

/** Converte campos BLOB (funcoes) em string/Buffer. */
async function materializarLinha(linha: Linha): Promise<Linha> {
  if (!linha || typeof linha !== 'object') return linha;

  const chavesBlob = Object.keys(linha).filter((chave) => typeof linha[chave] === 'function');
  if (!chavesBlob.length) return linha;

  const resultado: Linha = { ...linha };
  for (const chave of chavesBlob) {
    resultado[chave] = await lerBlob(linha[chave] as BlobLeitor);
  }
  return resultado;
}

type BlobLeitor = (callback: (erro: any, nome: string, emissor: NodeJS.EventEmitter) => void) => void;

function lerBlob(leitor: BlobLeitor): Promise<string | Buffer | null> {
  return new Promise((resolve, reject) => {
    leitor((erro, _nome, emissor) => {
      if (erro) return reject(normalizarErro(erro));
      if (!emissor) return resolve(null);

      const pedacos: Buffer[] = [];
      emissor.on('data', (pedaco: Buffer) => pedacos.push(Buffer.from(pedaco)));
      emissor.on('error', (e: any) => reject(normalizarErro(e)));
      emissor.on('end', () => {
        const conteudo = Buffer.concat(pedacos);
        // BLOB SUB_TYPE TEXT e sempre UTF8 neste banco; binarios ficam Buffer.
        resolve(ehTextoUtf8(conteudo) ? conteudo.toString('utf8') : conteudo);
      });
    });
  });
}

/**
 * Heuristica simples: os unicos BLOBs binarios do schema sao envelopes AEAD
 * (tokens e segredos cifrados), sempre lidos por quem sabe que sao binarios.
 * Para os demais, decodificar como UTF8 e o comportamento util.
 */
function ehTextoUtf8(conteudo: Buffer): boolean {
  if (conteudo.length === 0) return true;
  const texto = conteudo.toString('utf8');
  return !texto.includes('�');
}

function normalizarErro(erro: any, sql?: string): ErroFirebird {
  if (erro instanceof ErroFirebird) return erro;
  const mensagem = erro?.message ?? String(erro);
  return new ErroFirebird(mensagem, erro?.gdscode, erro?.sqlcode, sql);
}
