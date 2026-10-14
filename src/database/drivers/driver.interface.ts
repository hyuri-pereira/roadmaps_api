/**
 * Contrato comum aos drivers Firebird.
 *
 * Existem duas implementacoes: "pure" (node-firebird, protocolo TCP) e
 * "native" (node-firebird-driver-native, via fbclient.dll). O resto da
 * aplicacao so conhece esta interface, entao trocar de driver e trocar
 * uma variavel no .env.
 */

export type Linha = Record<string, unknown>;
export type Parametro = string | number | boolean | Date | Buffer | null | undefined;

export interface OpcoesConexaoFirebird {
  host: string;
  porta: number;
  database: string;
  usuario: string;
  senha: string;
  charset: string;
  pageSize: number;
  poolMax: number;
  connectTimeoutMs: number;
  clientePathNativo?: string;
}

/**
 * Transacao explicita. Toda escrita da aplicacao passa por aqui, porque as
 * triggers do banco dependem de UPDATE + SP_SOLICITAR_SYNC_ITEM acontecerem
 * na MESMA transacao.
 */
export interface TransacaoFirebird {
  query<T = Linha>(sql: string, parametros?: Parametro[]): Promise<T[]>;
  queryUm<T = Linha>(sql: string, parametros?: Parametro[]): Promise<T | null>;
  executar(sql: string, parametros?: Parametro[]): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface ConexaoFirebird {
  query<T = Linha>(sql: string, parametros?: Parametro[]): Promise<T[]>;
  executar(sql: string, parametros?: Parametro[]): Promise<void>;
  iniciarTransacao(somenteLeitura?: boolean): Promise<TransacaoFirebird>;
  liberar(): Promise<void>;
}

export interface DriverFirebirdContrato {
  readonly nome: 'pure' | 'native';
  iniciar(): Promise<void>;
  obterConexao(): Promise<ConexaoFirebird>;
  criarBanco(): Promise<void>;
  bancoExiste(): Promise<boolean>;
  encerrar(): Promise<void>;
}

/** Erro normalizado, independente do driver. */
export class ErroFirebird extends Error {
  constructor(
    mensagem: string,
    readonly gdscode?: number,
    readonly sqlcode?: number,
    readonly sql?: string,
  ) {
    super(mensagem);
    this.name = 'ErroFirebird';
  }
}
