/**
 * Diagnostico rapido da conexao com o Firebird.
 *
 *   npm run db:ping
 *
 * Util para separar "a API esta com problema" de "o banco nao responde".
 */
import 'dotenv/config';
import { carregarConfiguracao } from '../src/common/config/configuration';
import { criarDriver } from '../src/database/firebird.service';

async function main(): Promise<void> {
  const config = carregarConfiguracao();
  console.log(`Driver: ${config.firebird.driver}`);
  console.log(`Alvo:   ${config.firebird.host}:${config.firebird.porta}`);
  console.log(`Banco:  ${config.firebird.database}`);

  const driver = criarDriver(config);
  const inicio = Date.now();

  try {
    await driver.iniciar();
    const conexao = await driver.obterConexao();

    const versao = await conexao.query<{ V: string }>(
      "SELECT rdb$get_context('SYSTEM', 'ENGINE_VERSION') AS V FROM rdb$database",
    );
    const tabelas = await conexao.query<{ TOTAL: number }>(
      `SELECT COUNT(*) AS TOTAL FROM RDB$RELATIONS
        WHERE RDB$SYSTEM_FLAG = 0 AND RDB$VIEW_BLR IS NULL`,
    );
    const agora = await conexao.query<{ AGORA: Date }>(
      'SELECT CURRENT_TIMESTAMP AS AGORA FROM RDB$DATABASE',
    );

    console.log(`\nConectado em ${Date.now() - inicio}ms`);
    console.log(`Firebird:        ${versao[0]?.V}`);
    console.log(`Tabelas:         ${tabelas[0]?.TOTAL}`);
    console.log(`Relogio do banco: ${agora[0]?.AGORA}`);
    console.log(`Relogio da API:   ${new Date().toISOString()}`);

    await conexao.liberar();
  } finally {
    await driver.encerrar();
  }
}

main().catch((erro) => {
  const mensagem = (erro as Error).message;
  console.error(`\nFalha: ${mensagem}\n`);

  if (mensagem.includes('wire encryption')) {
    console.error(
      'O driver puro (node-firebird) nao faz wire encryption e o Firebird 5 vem com\n' +
        'WireCrypt = Required. Ajuste o firebird.conf do Firebird 5.0 para\n' +
        '"WireCrypt = Enabled" e reinicie o servico.',
    );
  } else if (mensagem.includes('Token unknown')) {
    console.error(
      'A porta configurada pode estar servida por outra versao do Firebird.\n' +
        'Confira RemoteServicePort no firebird.conf da instalacao 5.0.',
    );
  } else if (mensagem.toLowerCase().includes('econnrefused')) {
    console.error('Nada escutando nessa porta. Confira se o servico do Firebird esta ativo.');
  }

  process.exit(1);
});
