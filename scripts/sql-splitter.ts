/**
 * Divide um script .sql do Firebird em comandos executaveis.
 *
 * Precisa lidar com tres coisas que o isql entende e um driver nao:
 *  - SET TERM ^ ; que troca o terminador para poder declarar procedures
 *    e triggers com ponto e virgula no corpo;
 *  - diretivas que so existem no isql (SET SQL DIALECT, SET NAMES,
 *    SET AUTODDL), que devem ser ignoradas;
 *  - literais e comentarios, onde um terminador nao termina nada.
 */

export interface ComandoSql {
  texto: string;
  linha: number;
}

const DIRETIVAS_ISQL = /^SET\s+(SQL\s+DIALECT|NAMES|AUTODDL|TERM)\b/i;

export function dividirScript(script: string): ComandoSql[] {
  const comandos: ComandoSql[] = [];
  let terminador = ';';
  let buffer = '';
  let linhaInicio = 1;
  let linhaAtual = 1;

  let i = 0;
  while (i < script.length) {
    const caractere = script[i];

    if (caractere === '\n') linhaAtual += 1;

    // Comentario de bloco: copiado inteiro, sem procurar terminador dentro.
    if (caractere === '/' && script[i + 1] === '*') {
      const fim = script.indexOf('*/', i + 2);
      const trecho = fim === -1 ? script.slice(i) : script.slice(i, fim + 2);
      linhaAtual += contarQuebras(trecho);
      buffer += trecho;
      i += trecho.length;
      continue;
    }

    // Comentario de linha.
    if (caractere === '-' && script[i + 1] === '-') {
      const fim = script.indexOf('\n', i);
      const trecho = fim === -1 ? script.slice(i) : script.slice(i, fim);
      buffer += trecho;
      i += trecho.length;
      continue;
    }

    // Literal: aspas simples duplicadas escapam a propria aspa.
    if (caractere === "'") {
      let j = i + 1;
      while (j < script.length) {
        if (script[j] === "'" && script[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (script[j] === "'") break;
        if (script[j] === '\n') linhaAtual += 1;
        j += 1;
      }
      const trecho = script.slice(i, Math.min(j + 1, script.length));
      buffer += trecho;
      i += trecho.length;
      continue;
    }

    // Identificador entre aspas duplas.
    if (caractere === '"') {
      const fim = script.indexOf('"', i + 1);
      const trecho = fim === -1 ? script.slice(i) : script.slice(i, fim + 1);
      buffer += trecho;
      i += trecho.length;
      continue;
    }

    /*
     * Troca de terminador. A sintaxe e "SET TERM <novo> <terminador atual>",
     * ou seja, "SET TERM ^;" quando o atual e ";" e "SET TERM ;^" na volta.
     * Por isso o fim do comando depende do terminador em vigor, e nao de um
     * ponto e virgula fixo. A propria linha do SET TERM nao vai para o banco.
     */
    const setTerm = new RegExp(`^SET\\s+TERM\\s+(\\S+?)\\s*${escaparRegex(terminador)}`, 'i').exec(
      script.slice(i),
    );
    if (setTerm && ehInicioDeComando(buffer)) {
      terminador = setTerm[1];
      i += setTerm[0].length;
      buffer = '';
      linhaInicio = linhaAtual;
      continue;
    }

    if (script.startsWith(terminador, i)) {
      adicionar(comandos, buffer, linhaInicio);
      i += terminador.length;
      buffer = '';
      linhaInicio = linhaAtual;
      continue;
    }

    buffer += caractere;
    i += 1;
  }

  adicionar(comandos, buffer, linhaInicio);
  return comandos;
}

function adicionar(comandos: ComandoSql[], bruto: string, linha: number): void {
  const texto = bruto.trim();
  if (!texto) return;

  const semComentarios = removerComentarios(texto).trim();
  if (!semComentarios) return;
  // COMMIT do script e desnecessario: cada comando roda na propria transacao.
  if (/^COMMIT\s*(WORK)?$/i.test(semComentarios)) return;
  if (DIRETIVAS_ISQL.test(semComentarios)) return;

  comandos.push({ texto, linha });
}

function ehInicioDeComando(buffer: string): boolean {
  return removerComentarios(buffer).trim() === '';
}

function removerComentarios(texto: string): string {
  return texto.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function escaparRegex(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function contarQuebras(texto: string): number {
  let total = 0;
  for (const caractere of texto) if (caractere === '\n') total += 1;
  return total;
}
