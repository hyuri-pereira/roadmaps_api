/** Utilitarios compartilhados, sem dependencia de Nest. */

/** Remove acentos e normaliza para comparar nomes vindos do Asana. */
export function normalizarTexto(valor: string | null | undefined): string {
  if (!valor) return '';
  return valor
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

/** Compara nomes de projeto/secao ignorando acento, caixa e espacos extras. */
export function mesmoNome(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizarTexto(a).replace(/\s+/g, ' ') === normalizarTexto(b).replace(/\s+/g, ' ');
}

/**
 * Normaliza um telefone para E.164.
 * Aceita "(11) 91234-5678", "11912345678" ou "+5511912345678".
 * Retorna null quando o numero nao tem tamanho plausivel.
 */
export function paraE164(bruto: string, codigoPaisPadrao = '55'): string | null {
  if (!bruto) return null;
  const temMais = bruto.trim().startsWith('+');
  const digitos = bruto.replace(/\D/g, '');
  if (!digitos) return null;

  const completo = temMais || digitos.length > 11 ? digitos : `${codigoPaisPadrao}${digitos}`;
  if (completo.length < 10 || completo.length > 15) return null;
  return `+${completo}`;
}

/** chatId do WhatsApp no formato que o WAHA espera. */
export function e164ParaChatId(e164: string): string {
  return `${e164.replace(/\D/g, '')}@c.us`;
}

/** Espera exponencial limitada, usada pelas duas filas. */
export function calcularBackoffSegundos(
  tentativa: number,
  baseSegundos: number,
  maxSegundos: number,
): number {
  const espera = baseSegundos * 2 ** Math.max(0, tentativa - 1);
  // Jitter de ate 20% evita que varios jobs acordem no mesmo instante.
  const jitter = espera * 0.2 * Math.random();
  return Math.min(maxSegundos, Math.round(espera + jitter));
}

/** Converte Date -> 'YYYY-MM-DD' aceito pelo campo due_on do Asana. */
export function paraDataAsana(data: Date | string | null | undefined): string | null {
  if (!data) return null;
  const d = data instanceof Date ? data : new Date(data);
  if (Number.isNaN(d.getTime())) return null;
  const ano = d.getFullYear();
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

/** 'YYYY-MM-DD' -> Date local (sem deslocar o dia por fuso). */
export function deDataAsana(valor: string | null | undefined): Date | null {
  if (!valor) return null;
  const partes = valor.slice(0, 10).split('-').map(Number);
  if (partes.length !== 3 || partes.some(Number.isNaN)) return null;
  return new Date(partes[0], partes[1] - 1, partes[2]);
}

/** Remove segredos antes de qualquer log ou gravacao em INTEGRACAO_LOGS. */
export function mascararSegredos(valor: unknown): unknown {
  const CHAVES_SENSIVEIS =
    /(authorization|token|secret|password|senha|api[_-]?key|qr|refresh|client_secret)/i;

  const percorrer = (item: unknown, profundidade: number): unknown => {
    if (profundidade > 8) return '[profundo demais]';
    if (Array.isArray(item)) return item.map((i) => percorrer(i, profundidade + 1));
    if (item && typeof item === 'object') {
      const saida: Record<string, unknown> = {};
      for (const [chave, sub] of Object.entries(item as Record<string, unknown>)) {
        saida[chave] = CHAVES_SENSIVEIS.test(chave) ? '***' : percorrer(sub, profundidade + 1);
      }
      return saida;
    }
    if (typeof item === 'string' && /^Bearer\s+/i.test(item)) return 'Bearer ***';
    return item;
  };

  return percorrer(valor, 0);
}

/** Trunca texto respeitando o limite das colunas VARCHAR do schema. */
export function truncar(valor: string | null | undefined, limite: number): string | null {
  if (valor === null || valor === undefined) return null;
  return valor.length <= limite ? valor : valor.slice(0, limite);
}

export function paraJson(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;
  try {
    return JSON.stringify(valor);
  } catch {
    return null;
  }
}

export function deJson<T>(valor: unknown): T | null {
  if (!valor) return null;
  if (typeof valor === 'object') return valor as T;
  try {
    return JSON.parse(String(valor)) as T;
  } catch {
    return null;
  }
}

/** Firebird devolve BOOLEAN como true/false, mas 1/0 aparece em agregacoes. */
export function paraBooleano(valor: unknown): boolean {
  return valor === true || valor === 1 || valor === '1' || valor === 'T';
}

export function paraNumero(valor: unknown): number {
  if (valor === null || valor === undefined) return 0;
  return typeof valor === 'number' ? valor : Number(valor);
}

export function paraDataOuNulo(valor: unknown): Date | null {
  if (!valor) return null;
  const data = valor instanceof Date ? valor : new Date(String(valor));
  return Number.isNaN(data.getTime()) ? null : data;
}
