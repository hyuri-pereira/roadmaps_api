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
 * Driver baseado em "node-firebird-driver-native".
 *
 * Usa o fbclient.dll oficial, portanto suporta wire encryption e todos os
 * tipos do Firebird 5 (inclusive TIMESTAMP WITH TIME ZONE). Em troca exige:
 *   1. um fbclient.dll com a MESMA arquitetura do processo Node (x64 aqui);
 *   2. o pacote node-firebird-native-api compilado (node-gyp + Build Tools).
 *
 * Enquanto esses dois pre-requisitos nao estiverem atendidos, use
 * FIREBIRD_DRIVER=pure. Este arquivo existe para que a troca seja apenas
 * uma variavel de ambiente, sem mudar uma linha do resto da aplicacao.
 */

type ClienteNativo = any;
type AnexoNativo = any;
type TransacaoNativa = any;

export class NativeDriver implements DriverFirebirdContrato {
  readonly nome = 'native' as const;
  private readonly logger = new Logger(NativeDriver.name);
  private cliente?: ClienteNativo;
  private lib: any;
  /** Pool simples: o driver nativo nao traz um pronto. */
  private readonly disponiveis: AnexoNativo[] = [];
  private emprestados = 0;

  constructor(private readonly opcoes: OpcoesConexaoFirebird) {}

  private get uri(): string {
    return `${this.opcoes.host}/${this.opcoes.porta}:${this.opcoes.database}`;
  }

  private get credenciais() {
    return { username: this.opcoes.usuario, password: this.opcoes.senha };
  }

  async iniciar(): Promise<void> {
    try {
      this.lib = require('node-firebird-driver-native');
    } catch (erro: any) {
      throw new ErroFirebird(
        'FIREBIRD_DRIVER=native exige o pacote node-firebird-driver-native compilado. ' +
          `Instale as Build Tools e rode "npm rebuild node-firebird-native-api". Detalhe: ${erro?.message}`,
      );
    }

    const biblioteca = this.opcoes.clientePathNativo
      ? require('path').join(this.opcoes.clientePathNativo, this.lib.getDefaultLibraryFilename())
      : this.lib.getDefaultLibraryFilename();

    this.cliente = this.lib.createNativeClient(biblioteca);

    const conexao = await this.obterConexao();
    try {
      await conexao.query('SELECT 1 AS OK FROM RDB$DATABASE');
    } finally {
      await conexao.liberar();
    }
    this.logger.log(`Conectado em ${this.uri} (driver nativo, fbclient: ${biblioteca})`);
  }

  async bancoExiste(): Promise<boolean> {
    if (!this.cliente) await this.iniciar();
    try {
      const anexo = await this.cliente.connect(this.uri, this.credenciais);
      await anexo.disconnect();
      return true;
    } catch {
      return false;
    }
  }

  async criarBanco(): Promise<void> {
    if (!this.cliente) {
      this.lib = require('node-firebird-driver-native');
      this.cliente = this.lib.createNativeClient(
        this.opcoes.clientePathNativo
          ? require('path').join(this.opcoes.clientePathNativo, this.lib.getDefaultLibraryFilename())
          : this.lib.getDefaultLibraryFilename(),
      );
    }
    const anexo = await this.cliente.createDatabase(this.uri, {
      ...this.credenciais,
      forcedWrite: false,
    });
    await anexo.disconnect();
  }

  async obterConexao(): Promise<ConexaoFirebird> {
    if (!this.cliente) await this.iniciar();

    let anexo = this.disponiveis.pop();
    if (!anexo) {
      if (this.emprestados >= this.opcoes.poolMax) {
        anexo = await this.aguardarLiberacao();
      } else {
        anexo = await this.cliente.connect(this.uri, this.credenciais);
      }
    }
    this.emprestados += 1;
    return new ConexaoNativa(anexo, this.lib, (usado) => this.devolver(usado));
  }

  private async aguardarLiberacao(): Promise<AnexoNativo> {
    const limite = Date.now() + this.opcoes.connectTimeoutMs;
    while (Date.now() < limite) {
      await new Promise((r) => setTimeout(r, 25));
      const livre = this.disponiveis.pop();
      if (livre) return livre;
    }
    throw new ErroFirebird('timeout ao obter conexao do pool Firebird (driver nativo)');
  }

  private devolver(anexo: AnexoNativo) {
    this.emprestados = Math.max(0, this.emprestados - 1);
    if (anexo?.isValid) this.disponiveis.push(anexo);
  }

  async encerrar(): Promise<void> {
    for (const anexo of this.disponiveis.splice(0)) {
      try {
        await anexo.disconnect();
      } catch {
        /* conexao ja caiu; nada a fazer no shutdown */
      }
    }
    if (this.cliente?.isValid) await this.cliente.dispose();
    this.cliente = undefined;
  }
}

class ConexaoNativa implements ConexaoFirebird {
  constructor(
    private readonly anexo: AnexoNativo,
    private readonly lib: any,
    private readonly aoLiberar: (anexo: AnexoNativo) => void,
  ) {}

  /** Consulta avulsa: abre e fecha a propria transacao. */
  async query<T = Linha>(sql: string, parametros: Parametro[] = []): Promise<T[]> {
    const tx = await this.iniciarTransacao(true);
    try {
      const linhas = await tx.query<T>(sql, parametros);
      await tx.commit();
      return linhas;
    } catch (erro) {
      await tx.rollback();
      throw erro;
    }
  }

  async executar(sql: string, parametros: Parametro[] = []): Promise<void> {
    const tx = await this.iniciarTransacao();
    try {
      await tx.executar(sql, parametros);
      await tx.commit();
    } catch (erro) {
      await tx.rollback();
      throw erro;
    }
  }

  async iniciarTransacao(somenteLeitura = false): Promise<TransacaoFirebird> {
    const tx = await this.anexo.startTransaction({
      isolation: this.lib.TransactionIsolation.READ_COMMITTED,
      readCommittedMode: 'RECORD_VERSION',
      accessMode: somenteLeitura ? 'READ_ONLY' : 'READ_WRITE',
      waitMode: 'NO_WAIT',
    });
    return new TransacaoNativaImpl(this.anexo, tx, this.lib);
  }

  async liberar(): Promise<void> {
    this.aoLiberar(this.anexo);
  }
}

class TransacaoNativaImpl implements TransacaoFirebird {
  private finalizada = false;

  constructor(
    private readonly anexo: AnexoNativo,
    private readonly tx: TransacaoNativa,
    private readonly lib: any,
  ) {}

  async query<T = Linha>(sql: string, parametros: Parametro[] = []): Promise<T[]> {
    this.garantirAberta();
    // DDL e comandos sem result set precisam de execute, nao executeQuery.
    if (!retornaLinhas(sql)) {
      await this.executar(sql, parametros);
      return [];
    }

    let resultado: any;
    try {
      resultado = await this.anexo.executeQuery(this.tx, sql, normalizar(parametros));
    } catch (erro: any) {
      throw normalizarErro(erro, sql);
    }

    try {
      const linhas: Linha[] = await resultado.fetchAsObject();
      return (await Promise.all(
        linhas.map((linha: Linha) => this.materializar(linha)),
      )) as T[];
    } finally {
      await resultado.close();
    }
  }

  async queryUm<T = Linha>(sql: string, parametros: Parametro[] = []): Promise<T | null> {
    const linhas = await this.query<T>(sql, parametros);
    return linhas.length ? linhas[0] : null;
  }

  async executar(sql: string, parametros: Parametro[] = []): Promise<void> {
    this.garantirAberta();
    try {
      await this.anexo.execute(this.tx, sql, normalizar(parametros));
    } catch (erro: any) {
      throw normalizarErro(erro, sql);
    }
  }

  async commit(): Promise<void> {
    this.garantirAberta();
    this.finalizada = true;
    await this.tx.commit();
  }

  async rollback(): Promise<void> {
    if (this.finalizada) return;
    this.finalizada = true;
    try {
      await this.tx.rollback();
    } catch {
      /* transacao ja encerrada pelo servidor */
    }
  }

  /** Converte handles de BLOB em string/Buffer. */
  private async materializar(linha: Linha): Promise<Linha> {
    const resultado: Linha = { ...linha };
    for (const [chave, valor] of Object.entries(linha)) {
      if (valor instanceof this.lib.Blob) {
        resultado[chave] = await this.lerBlob(valor);
      }
    }
    return resultado;
  }

  private async lerBlob(blob: any): Promise<string | Buffer> {
    const stream = await this.anexo.openBlob(this.tx, blob);
    const pedacos: Buffer[] = [];
    try {
      const buffer = Buffer.alloc(64 * 1024);
      for (;;) {
        const lidos = await stream.read(buffer);
        if (lidos <= 0) break;
        pedacos.push(Buffer.from(buffer.subarray(0, lidos)));
      }
    } finally {
      await stream.close();
    }
    const conteudo = Buffer.concat(pedacos);
    const texto = conteudo.toString('utf8');
    return texto.includes('�') ? conteudo : texto;
  }

  private garantirAberta() {
    if (this.finalizada) {
      throw new ErroFirebird('a transacao ja foi finalizada (commit/rollback)');
    }
  }
}

function retornaLinhas(sql: string): boolean {
  const inicio = sql.trim().replace(/^\/\*[\s\S]*?\*\//, '').trimStart().toUpperCase();
  if (inicio.startsWith('SELECT') || inicio.startsWith('WITH')) return true;
  return /\bRETURNING\b/i.test(sql);
}

function normalizar(parametros: Parametro[]): unknown[] {
  return parametros.map((valor) => (valor === undefined ? null : valor));
}

function normalizarErro(erro: any, sql?: string): ErroFirebird {
  if (erro instanceof ErroFirebird) return erro;
  return new ErroFirebird(erro?.message ?? String(erro), erro?.gdscode, erro?.sqlcode, sql);
}
