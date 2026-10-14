/**
 * Cria o arquivo .FDB definido em FIREBIRD_DATABASE.
 *
 *   npm run db:create
 *   npm run db:create -- --force    (apaga e recria; destrutivo)
 *
 * O banco nasce em UTF8 e SQL dialect 3, como o schema exige.
 */
import 'dotenv/config';
import { carregarConfiguracao } from '../src/common/config/configuration';
import { criarDriver } from '../src/database/firebird.service';

async function main(): Promise<void> {
  const config = carregarConfiguracao();
  const forcar = process.argv.includes('--force');
  const driver = criarDriver(config);

  const alvo = `${config.firebird.host}:${config.firebird.porta} ${config.firebird.database}`;

  if (await driver.bancoExiste()) {
    if (!forcar) {
      console.log(`O banco ja existe em ${alvo}. Nada a fazer.`);
      console.log('Para recriar do zero, use: npm run db:create -- --force');
      await driver.encerrar();
      return;
    }

    // Apagar o arquivo e irreversivel; exigimos o --force explicito acima.
    console.log(`--force informado: removendo o banco atual em ${alvo}`);
    await apagarArquivo(config.firebird.database);
  }

  await driver.criarBanco();
  await driver.encerrar();

  console.log(`Banco criado em ${alvo}`);
  console.log('Proximo passo: npm run db:schema');
}

/**
 * Remove o arquivo do banco. So funciona quando a API e o Firebird rodam na
 * mesma maquina, que e o cenario desta instalacao; em servidor remoto, apague
 * o arquivo por la.
 */
async function apagarArquivo(caminho: string): Promise<void> {
  const { unlink } = await import('fs/promises');
  try {
    await unlink(caminho);
  } catch (erro) {
    const codigo = (erro as NodeJS.ErrnoException).code;
    if (codigo === 'ENOENT') return;
    if (codigo === 'EBUSY' || codigo === 'EPERM') {
      throw new Error(
        `O arquivo ${caminho} esta em uso. Feche as conexoes (incluindo a API e o isql) ` +
          'e tente de novo.',
      );
    }
    throw erro;
  }
}

main().catch((erro) => {
  console.error(`Nao foi possivel criar o banco: ${(erro as Error).message}`);
  process.exit(1);
});
