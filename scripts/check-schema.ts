/**
 * Confere se db/schema.sql e dividido corretamente em comandos, sem tocar
 * no banco.
 *
 *   npx ts-node scripts/check-schema.ts
 *
 * Serve para pegar cedo o erro mais chato deste tipo de script: um bloco
 * SET TERM mal fechado, que faria uma procedure inteira virar varios
 * comandos quebrados na hora de aplicar.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { dividirScript } from './sql-splitter';

const caminho = resolve(__dirname, '..', 'db', 'schema.sql');
const comandos = dividirScript(readFileSync(caminho, 'utf8'));

const tipos: Record<string, number> = {};
for (const comando of comandos) {
  const limpo = comando.texto.replace(/\/\*[\s\S]*?\*\//g, '').trim();
  const casado = /^(CREATE\s+\w+|ALTER\s+\w+|INSERT|UPDATE|DELETE)/i.exec(limpo);
  const chave = casado ? casado[1].toUpperCase().replace(/\s+/g, ' ') : 'OUTRO';
  tipos[chave] = (tipos[chave] ?? 0) + 1;
}

console.log(`Arquivo: ${caminho}`);
console.log(`Comandos reconhecidos: ${comandos.length}\n`);
for (const [tipo, total] of Object.entries(tipos).sort()) {
  console.log(`  ${tipo.padEnd(20)} ${total}`);
}

const problemas: string[] = [];

const comSetTerm = comandos.filter((c) => /\bSET\s+TERM\b/i.test(c.texto));
if (comSetTerm.length) {
  problemas.push(`${comSetTerm.length} comando(s) ainda contem "SET TERM".`);
}

// Todo bloco PSQL precisa terminar em END; se nao terminar, o corte saiu errado.
const psqlQuebrado = comandos.filter(
  (c) => /^\s*CREATE\s+(OR\s+ALTER\s+)?(PROCEDURE|TRIGGER|FUNCTION)/i.test(c.texto.trim()) &&
    !/END\s*$/i.test(c.texto.trim()),
);
if (psqlQuebrado.length) {
  problemas.push(
    `${psqlQuebrado.length} bloco(s) PSQL nao terminam em END: ` +
      psqlQuebrado.map((c) => `linha ${c.linha}`).join(', '),
  );
}

const outros = Object.keys(tipos).filter((t) => t === 'OUTRO');
if (outros.length) {
  const exemplos = comandos
    .filter((c) => !/^(CREATE|ALTER|INSERT|UPDATE|DELETE)/i.test(c.texto.replace(/\/\*[\s\S]*?\*\//g, '').trim()))
    .slice(0, 3)
    .map((c) => `linha ${c.linha}: ${c.texto.slice(0, 60)}`);
  problemas.push(`Comandos nao classificados:\n    ${exemplos.join('\n    ')}`);
}

if (problemas.length) {
  console.error('\nProblemas encontrados:');
  for (const problema of problemas) console.error(`  - ${problema}`);
  process.exit(1);
}

console.log('\nSchema pronto para ser aplicado com: npm run db:schema');
