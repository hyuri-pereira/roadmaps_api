/**
 * Aplica db/schema.sql no banco configurado no .env.
 *
 *   npm run db:schema
 *
 * Cada comando roda na propria transacao, entao um erro nao deixa o banco
 * meio construido sem aviso: o script para no primeiro problema e mostra o
 * comando exato que falhou, com a linha do arquivo.
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { carregarConfiguracao } from '../src/common/config/configuration';
import { criarDriver } from '../src/database/firebird.service';
import { dividirScript } from './sql-splitter';

async function main(): Promise<void> {
  const config = carregarConfiguracao();
  const caminho = resolve(__dirname, '..', 'db', 'schema.sql');
  const script = readFileSync(caminho, 'utf8');
  const comandos = dividirScript(script);

  console.log(`Aplicando ${comandos.length} comandos de ${caminho}`);
  console.log(`Banco: ${config.firebird.host}:${config.firebird.porta} ${config.firebird.database}`);

  const driver = criarDriver(config);
  await driver.iniciar();
  const conexao = await driver.obterConexao();

  let aplicados = 0;
  try {
    for (const comando of comandos) {
      const tx = await conexao.iniciarTransacao();
      try {
        await tx.executar(comando.texto);
        await tx.commit();
        aplicados += 1;
      } catch (erro) {
        await tx.rollback();
        console.error(`\nFalha na linha ${comando.linha} do schema.sql:`);
        console.error(comando.texto.slice(0, 600));
        console.error(`\n-> ${(erro as Error).message}\n`);
        throw erro;
      }
    }
    console.log(`\nSchema aplicado: ${aplicados} comandos executados com sucesso.`);
  } finally {
    await conexao.liberar();
    await driver.encerrar();
  }
}

main().catch((erro) => {
  console.error(`Nao foi possivel aplicar o schema: ${(erro as Error).message}`);
  process.exit(1);
});
