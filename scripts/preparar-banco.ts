/**
 * Deixa o banco pronto para a API subir. Roda a cada start do container.
 *
 *   node dist-scripts/scripts/preparar-banco.js     (dentro do container)
 *   npx ts-node scripts/preparar-banco.ts            (fora dele)
 *
 * 1. Espera o Firebird aceitar conexoes TCP (o container do banco sobe junto).
 * 2. Banco inexistente: cria e aplica db/schema.sql. O schema.sql e mantido
 *    consolidado (ja contem as migracoes), entao as migracoes presentes sao
 *    apenas registradas em SCHEMA_MIGRACOES.
 * 3. Banco existente: aplica so as migracoes de db/migracoes que ainda nao
 *    estao em SCHEMA_MIGRACOES.
 *
 * Banco que ja existia antes desta tabela (ex.: restaurado de um backup do
 * ambiente antigo) e tratado como atualizado: as migracoes presentes sao
 * apenas registradas, nao executadas, porque nao sao reexecutaveis.
 */
import 'dotenv/config';
import { readdirSync, readFileSync } from 'fs';
import net from 'net';
import { join, resolve } from 'path';
import { carregarConfiguracao } from '../src/common/config/configuration';
import { ConexaoFirebird } from '../src/database/drivers/driver.interface';
import { criarDriver } from '../src/database/firebird.service';
import { dividirScript } from './sql-splitter';

const PASTA_DB = resolve(process.env.DB_SCRIPTS_PATH ?? join(process.cwd(), 'db'));
const ESPERA_MAXIMA_MS = 120_000;

async function main(): Promise<void> {
  const config = carregarConfiguracao();
  const { host, porta, database } = config.firebird;
  console.log(`Banco: ${host}:${porta} ${database}`);

  await esperarPorta(host, porta);

  const driver = criarDriver(config);
  const novo = !(await driver.bancoExiste());
  if (novo) {
    console.log('Banco nao existe: criando.');
    await driver.criarBanco();
  }

  await driver.iniciar();
  const conexao = await driver.obterConexao();
  try {
    if (novo || (await contarTabelas(conexao)) === 0) {
      await aplicarArquivo(conexao, join(PASTA_DB, 'schema.sql'));
      await criarTabelaControle(conexao);
      for (const migracao of listarMigracoes()) {
        await registrarMigracao(conexao, migracao, 'incluida no schema.sql');
      }
    } else {
      const controleExistia = await tabelaControleExiste(conexao);
      await criarTabelaControle(conexao);
      const aplicadas = await migracoesAplicadas(conexao);
      for (const migracao of listarMigracoes()) {
        if (aplicadas.has(migracao)) continue;
        if (controleExistia) await aplicarMigracao(conexao, migracao);
        else await registrarMigracao(conexao, migracao, 'presumida: banco anterior ao controle');
      }
    }
    console.log('Banco pronto.');
  } finally {
    await conexao.liberar();
    await driver.encerrar();
  }
}

function esperarPorta(host: string, porta: number): Promise<void> {
  const limite = Date.now() + ESPERA_MAXIMA_MS;
  return new Promise((resolver, rejeitar) => {
    const tentar = () => {
      const socket = net.connect({ host, port: porta });
      socket.once('connect', () => {
        socket.destroy();
        resolver();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > limite) return rejeitar(new Error(`Firebird nao respondeu em ${host}:${porta}`));
        setTimeout(tentar, 2000);
      });
    };
    tentar();
  });
}

function listarMigracoes(): string[] {
  return readdirSync(join(PASTA_DB, 'migracoes'))
    .filter((nome) => nome.toLowerCase().endsWith('.sql'))
    .sort();
}

async function contarTabelas(conexao: ConexaoFirebird): Promise<number> {
  const [linha] = await conexao.query<{ TOTAL: number }>(
    `SELECT COUNT(*) AS TOTAL FROM RDB$RELATIONS
      WHERE RDB$SYSTEM_FLAG = 0 AND RDB$VIEW_BLR IS NULL`,
  );
  return Number(linha?.TOTAL ?? 0);
}

async function tabelaControleExiste(conexao: ConexaoFirebird): Promise<boolean> {
  const linhas = await conexao.query(
    "SELECT 1 AS OK FROM RDB$RELATIONS WHERE RDB$RELATION_NAME = 'SCHEMA_MIGRACOES'",
  );
  return linhas.length > 0;
}

async function criarTabelaControle(conexao: ConexaoFirebird): Promise<void> {
  if (await tabelaControleExiste(conexao)) return;
  await executarIsolado(
    conexao,
    `CREATE TABLE SCHEMA_MIGRACOES (
       ARQUIVO     VARCHAR(200) NOT NULL PRIMARY KEY,
       APLICADA_EM TIMESTAMP DEFAULT LOCALTIMESTAMP NOT NULL,
       OBSERVACAO  VARCHAR(200)
     )`,
  );
}

async function migracoesAplicadas(conexao: ConexaoFirebird): Promise<Set<string>> {
  const linhas = await conexao.query<{ ARQUIVO: string }>('SELECT ARQUIVO FROM SCHEMA_MIGRACOES');
  return new Set(linhas.map((l) => l.ARQUIVO.trim()));
}

async function aplicarMigracao(conexao: ConexaoFirebird, arquivo: string): Promise<void> {
  await aplicarArquivo(conexao, join(PASTA_DB, 'migracoes', arquivo));
  await registrarMigracao(conexao, arquivo, null);
}

async function registrarMigracao(
  conexao: ConexaoFirebird,
  arquivo: string,
  observacao: string | null,
): Promise<void> {
  const tx = await conexao.iniciarTransacao();
  try {
    await tx.executar('INSERT INTO SCHEMA_MIGRACOES (ARQUIVO, OBSERVACAO) VALUES (?, ?)', [
      arquivo,
      observacao,
    ]);
    await tx.commit();
  } catch (erro) {
    await tx.rollback();
    throw erro;
  }
  console.log(`Migracao ${arquivo} ${observacao ? `registrada (${observacao})` : 'aplicada'}.`);
}

/** Mesmo comportamento do db:schema: um comando por transacao, para no primeiro erro. */
async function aplicarArquivo(conexao: ConexaoFirebird, caminho: string): Promise<void> {
  const comandos = dividirScript(readFileSync(caminho, 'utf8'));
  console.log(`Aplicando ${comandos.length} comandos de ${caminho}`);
  for (const comando of comandos) {
    try {
      await executarIsolado(conexao, comando.texto);
    } catch (erro) {
      console.error(`\nFalha na linha ${comando.linha} de ${caminho}:`);
      console.error(comando.texto.slice(0, 600));
      throw erro;
    }
  }
}

async function executarIsolado(conexao: ConexaoFirebird, sql: string): Promise<void> {
  const tx = await conexao.iniciarTransacao();
  try {
    await tx.executar(sql);
    await tx.commit();
  } catch (erro) {
    await tx.rollback();
    throw erro;
  }
}

// O pool do node-firebird deixa handles abertos mesmo apos destroy; sem o
// exit explicito o entrypoint nunca chegaria a iniciar a API.
main().then(
  () => process.exit(0),
  (erro) => {
    console.error(`Nao foi possivel preparar o banco: ${(erro as Error).message}`);
    process.exit(1);
  },
);
