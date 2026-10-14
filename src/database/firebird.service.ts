import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { AppConfig, CONFIG_APP } from '../common/config/configuration';
import { NativeDriver } from './drivers/native.driver';
import { PureDriver } from './drivers/pure.driver';
import {
  DriverFirebirdContrato,
  ErroFirebird,
  Linha,
  Parametro,
  TransacaoFirebird,
} from './drivers/driver.interface';

/** Codigos do Firebird que valem uma nova tentativa da transacao inteira. */
const GDSCODES_CONFLITO = new Set([
  335544336, // deadlock
  335544451, // update conflicts with concurrent update
  335544345, // lock conflict on no wait transaction
]);

export interface OpcoesTransacao {
  somenteLeitura?: boolean;
  /** Numero maximo de tentativas em caso de conflito de concorrencia. */
  tentativas?: number;
}

@Injectable()
export class FirebirdService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(FirebirdService.name);
  private readonly driver: DriverFirebirdContrato;

  constructor(@Inject(CONFIG_APP) private readonly config: AppConfig) {
    this.driver = criarDriver(config);
  }

  async onModuleInit(): Promise<void> {
    await this.driver.iniciar();
    await this.conferirRelogio();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.driver.encerrar();
  }

  get nomeDriver(): string {
    return this.driver.nome;
  }

  /**
   * Executa um bloco dentro de uma transacao, com commit/rollback automatico.
   *
   * Toda escrita da aplicacao deve usar este metodo: as regras do banco
   * dependem de o UPDATE e o SP_SOLICITAR_SYNC_ITEM acontecerem juntos.
   * Conflitos de concorrencia refazem a transacao inteira, como manda o
   * contrato de integracao (a trigger BIU_ITEM_LOCK serializa por roadmap).
   */
  async transacao<T>(
    executor: (tx: TransacaoFirebird) => Promise<T>,
    opcoes: OpcoesTransacao = {},
  ): Promise<T> {
    const maxTentativas = opcoes.tentativas ?? 3;
    let ultimoErro: unknown;

    for (let tentativa = 1; tentativa <= maxTentativas; tentativa += 1) {
      const conexao = await this.driver.obterConexao();
      const tx = await conexao.iniciarTransacao(opcoes.somenteLeitura);
      try {
        const resultado = await executor(tx);
        await tx.commit();
        return resultado;
      } catch (erro) {
        await tx.rollback();
        ultimoErro = erro;

        if (!ehConflito(erro) || tentativa === maxTentativas) throw erro;
        const espera = 25 * 2 ** (tentativa - 1);
        this.logger.warn(
          `Conflito de concorrencia no Firebird; refazendo a transacao em ${espera}ms ` +
            `(tentativa ${tentativa + 1}/${maxTentativas})`,
        );
        await new Promise((r) => setTimeout(r, espera));
      } finally {
        await conexao.liberar();
      }
    }

    throw ultimoErro;
  }

  /** Consulta somente leitura, em transacao propria. */
  async query<T = Linha>(sql: string, parametros: Parametro[] = []): Promise<T[]> {
    return this.transacao((tx) => tx.query<T>(sql, parametros), { somenteLeitura: true });
  }

  async queryUm<T = Linha>(sql: string, parametros: Parametro[] = []): Promise<T | null> {
    const linhas = await this.query<T>(sql, parametros);
    return linhas.length ? linhas[0] : null;
  }

  /** Escrita avulsa. Prefira transacao() quando houver mais de um comando. */
  async executar(sql: string, parametros: Parametro[] = []): Promise<void> {
    await this.transacao((tx) => tx.executar(sql, parametros));
  }

  /**
   * Escrita avulsa que devolve dados: INSERT/UPDATE ... RETURNING.
   *
   * Nao use query()/queryUm() para isso: aqueles abrem transacao
   * SOMENTE LEITURA e o Firebird recusa a escrita com
   * "attempted update during read-only transaction".
   */
  async escreverRetornando<T = Linha>(
    sql: string,
    parametros: Parametro[] = [],
  ): Promise<T | null> {
    const linhas = await this.transacao((tx) => tx.query<T>(sql, parametros));
    return linhas.length ? linhas[0] : null;
  }

  /**
   * O driver puro converte TIMESTAMP usando o fuso local do processo, e o
   * banco grava CURRENT_TIMESTAMP no fuso do servidor. Como API e Firebird
   * rodam no mesmo host, os instantes batem; se algum dia forem separados e
   * ficarem em fusos distintos, este aviso aparece no boot.
   */
  private async conferirRelogio(): Promise<void> {
    try {
      const linha = await this.queryUm<{ AGORA: Date }>(
        'SELECT CURRENT_TIMESTAMP AS AGORA FROM RDB$DATABASE',
      );
      if (!linha?.AGORA) return;
      const diferencaMin = Math.abs(Date.now() - new Date(linha.AGORA).getTime()) / 60000;
      if (diferencaMin > 5) {
        this.logger.warn(
          `O relogio do Firebird esta ${diferencaMin.toFixed(0)} minutos distante do relogio ` +
            'da API. Datas gravadas por triggers (CURRENT_TIMESTAMP) vao divergir das gravadas ' +
            'pela aplicacao. Alinhe o fuso/horario dos dois.',
        );
      }
    } catch (erro) {
      this.logger.warn(`Nao foi possivel conferir o relogio do banco: ${(erro as Error).message}`);
    }
  }
}

export function criarDriver(config: AppConfig): DriverFirebirdContrato {
  const opcoes = {
    host: config.firebird.host,
    porta: config.firebird.porta,
    database: config.firebird.database,
    usuario: config.firebird.usuarioRuntime,
    senha: config.firebird.senhaRuntime,
    charset: config.firebird.charset,
    pageSize: config.firebird.pageSize,
    poolMax: config.firebird.poolMax,
    connectTimeoutMs: config.firebird.connectTimeoutMs,
    clientePathNativo: config.firebird.clientePathNativo,
  };
  return config.firebird.driver === 'native' ? new NativeDriver(opcoes) : new PureDriver(opcoes);
}

function ehConflito(erro: unknown): boolean {
  const gds = (erro as ErroFirebird)?.gdscode;
  if (gds && GDSCODES_CONFLITO.has(gds)) return true;
  const mensagem = (erro as Error)?.message?.toLowerCase() ?? '';
  return mensagem.includes('deadlock') || mensagem.includes('concurrent update');
}
