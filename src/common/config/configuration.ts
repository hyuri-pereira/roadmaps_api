/**
 * Leitura e validacao de toda a configuracao vinda do .env.
 *
 * A aplicacao nao le process.env em nenhum outro lugar: tudo passa por aqui,
 * o que garante erro claro no boot quando falta alguma variavel obrigatoria.
 */

export type DriverFirebird = 'pure' | 'native';
export type SegurancaSmtp = 'TLS' | 'STARTTLS';

export interface AppConfig {
  app: {
    ambiente: string;
    porta: number;
    prefixo: string;
    urlPublica: string;
    urlFrontend: string;
    corsOrigens: string[];
    swaggerHabilitado: boolean;
    producao: boolean;
  };
  firebird: {
    driver: DriverFirebird;
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
    /** Credencial usada pela aplicacao em runtime (pode ser menos privilegiada). */
    usuarioRuntime: string;
    senhaRuntime: string;
  };
  seguranca: {
    chaveAtual: Buffer;
    versaoChave: string;
    chavesLegadas: Map<string, Buffer>;
    jwtSegredo: string;
    jwtAccessTtl: string;
    jwtRefreshTtl: string;
    jwtIssuer: string;
  };
  google: {
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
    dominiosPermitidos: string[];
    autoProvisionar: boolean;
    configurado: boolean;
  };
  asana: {
    baseUrl: string;
    oauthClientId: string;
    oauthClientSecret: string;
    oauthRedirectUri: string;
    oauthAuthorizeUrl: string;
    oauthTokenUrl: string;
    oauthScopes: string;
    oauthConfigurado: boolean;
    rateLimitPorMinuto: number;
    timeoutMs: number;
    nomeProjetoSprint: string;
    nomeProjetoBacklog: string;
    nomeSecaoSprint: string;
    nomeSecaoBacklog: string;
    webhookUrl: string;
    webhookAutoRegistrar: boolean;
    reconciliacaoCron: string;
    catalogoSyncCron: string;
  };
  workers: {
    habilitados: boolean;
    id: string;
    integracaoCron: string;
    integracaoLote: number;
    integracaoLeaseSegundos: number;
    integracaoMaxTentativas: number;
    notificacaoCron: string;
    notificacaoLote: number;
    notificacaoLeaseSegundos: number;
    notificacaoMaxTentativas: number;
    backoffBaseSegundos: number;
    backoffMaxSegundos: number;
  };
  mail: {
    habilitado: boolean;
    host: string;
    porta: number;
    seguranca: SegurancaSmtp;
    usuario: string;
    senha: string;
    remetenteEmail: string;
    remetenteNome: string;
    rejeitarNaoAutorizado: boolean;
  };
  waha: {
    habilitado: boolean;
    nome: string;
    baseUrl: string;
    apiKey: string;
    webhookSecret: string;
    webhookUrl: string;
    prefixoSessao: string;
    timeoutMs: number;
    codigoPaisPadrao: string;
  };
  storage: {
    driver: string;
    caminhoLocal: string;
    tamanhoMaximoBytes: number;
    mimesPermitidos: string[];
  };
  bootstrap: {
    adminEmail: string;
    adminNome: string;
    adminSenha: string;
  };
  log: {
    nivel: string;
    registrarPayloadIntegracao: boolean;
  };
}

class ErroConfiguracao extends Error {
  constructor(mensagem: string) {
    super(`[configuracao] ${mensagem}`);
  }
}

function texto(chave: string, padrao?: string): string {
  const valor = process.env[chave];
  if (valor === undefined || valor === '') {
    if (padrao !== undefined) return padrao;
    throw new ErroConfiguracao(`a variavel ${chave} e obrigatoria no .env`);
  }
  if (valor.startsWith('<') && valor.endsWith('>')) {
    throw new ErroConfiguracao(`a variavel ${chave} ainda esta com o placeholder ${valor}`);
  }
  return valor;
}

function textoOpcional(chave: string, padrao = ''): string {
  const valor = process.env[chave];
  if (valor === undefined || valor === '') return padrao;
  if (valor.startsWith('<') && valor.endsWith('>')) return padrao;
  return valor;
}

function inteiro(chave: string, padrao: number): number {
  const bruto = process.env[chave];
  if (bruto === undefined || bruto === '') return padrao;
  const valor = Number.parseInt(bruto, 10);
  if (Number.isNaN(valor)) {
    throw new ErroConfiguracao(`a variavel ${chave} precisa ser um numero inteiro`);
  }
  return valor;
}

function booleano(chave: string, padrao: boolean): boolean {
  const bruto = process.env[chave];
  if (bruto === undefined || bruto === '') return padrao;
  return ['1', 'true', 'sim', 'yes', 'on'].includes(bruto.trim().toLowerCase());
}

function lista(chave: string, padrao: string[] = []): string[] {
  const bruto = textoOpcional(chave);
  if (!bruto) return padrao;
  return bruto
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function chaveAead(chave: string): Buffer {
  const bruto = texto(chave);
  const buffer = Buffer.from(bruto, 'base64');
  if (buffer.length !== 32) {
    throw new ErroConfiguracao(
      `${chave} precisa ter 32 bytes em base64 (recebido ${buffer.length}). ` +
        'Gere com: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  return buffer;
}

function chavesLegadas(): Map<string, Buffer> {
  const mapa = new Map<string, Buffer>();
  for (const entrada of lista('ENCRYPTION_KEYS_LEGACY')) {
    const separador = entrada.indexOf(':');
    if (separador < 1) {
      throw new ErroConfiguracao(
        'ENCRYPTION_KEYS_LEGACY usa o formato "versao:chaveBase64", separadas por virgula',
      );
    }
    const versao = entrada.slice(0, separador).trim();
    const buffer = Buffer.from(entrada.slice(separador + 1).trim(), 'base64');
    if (buffer.length !== 32) {
      throw new ErroConfiguracao(`a chave legada "${versao}" nao tem 32 bytes`);
    }
    mapa.set(versao, buffer);
  }
  return mapa;
}

export function carregarConfiguracao(): AppConfig {
  const ambiente = textoOpcional('NODE_ENV', 'development');
  const driver = textoOpcional('FIREBIRD_DRIVER', 'pure') as DriverFirebird;
  if (driver !== 'pure' && driver !== 'native') {
    throw new ErroConfiguracao('FIREBIRD_DRIVER aceita apenas "pure" ou "native"');
  }

  const usuarioFb = texto('FIREBIRD_USER', 'SYSDBA');
  const senhaFb = texto('FIREBIRD_PASSWORD');
  const seguranca = textoOpcional('MAIL_SECURITY', 'STARTTLS').toUpperCase();
  if (seguranca !== 'TLS' && seguranca !== 'STARTTLS') {
    throw new ErroConfiguracao('MAIL_SECURITY aceita apenas "TLS" ou "STARTTLS"');
  }

  const googleClientId = textoOpcional('GOOGLE_CLIENT_ID');
  const googleClientSecret = textoOpcional('GOOGLE_CLIENT_SECRET');
  const asanaClientId = textoOpcional('ASANA_OAUTH_CLIENT_ID');
  const asanaClientSecret = textoOpcional('ASANA_OAUTH_CLIENT_SECRET');

  return {
    app: {
      ambiente,
      porta: inteiro('PORT', 3000),
      prefixo: textoOpcional('API_PREFIX', 'api').replace(/^\/+|\/+$/g, ''),
      urlPublica: textoOpcional('APP_PUBLIC_URL', 'http://localhost:3000').replace(/\/+$/, ''),
      urlFrontend: textoOpcional('FRONTEND_URL', 'http://localhost:5173').replace(/\/+$/, ''),
      corsOrigens: lista('CORS_ORIGINS', ['http://localhost:5173']),
      swaggerHabilitado: booleano('SWAGGER_ENABLED', true),
      producao: ambiente === 'production',
    },
    firebird: {
      driver,
      host: textoOpcional('FIREBIRD_HOST', '127.0.0.1'),
      porta: inteiro('FIREBIRD_PORT', 3050),
      database: texto('FIREBIRD_DATABASE'),
      usuario: usuarioFb,
      senha: senhaFb,
      charset: textoOpcional('FIREBIRD_CHARSET', 'UTF8'),
      pageSize: inteiro('FIREBIRD_PAGE_SIZE', 8192),
      poolMax: inteiro('FIREBIRD_POOL_MAX', 10),
      connectTimeoutMs: inteiro('FIREBIRD_CONNECT_TIMEOUT_MS', 15000),
      clientePathNativo: textoOpcional('FIREBIRD_NATIVE_CLIENT_PATH') || undefined,
      usuarioRuntime: textoOpcional('FIREBIRD_RUNTIME_USER') || usuarioFb,
      senhaRuntime: textoOpcional('FIREBIRD_RUNTIME_PASSWORD') || senhaFb,
    },
    seguranca: {
      chaveAtual: chaveAead('ENCRYPTION_KEY'),
      versaoChave: textoOpcional('ENCRYPTION_KEY_VERSION', 'v1'),
      chavesLegadas: chavesLegadas(),
      jwtSegredo: texto('JWT_SECRET'),
      jwtAccessTtl: textoOpcional('JWT_ACCESS_TTL', '15m'),
      jwtRefreshTtl: textoOpcional('JWT_REFRESH_TTL', '30d'),
      jwtIssuer: textoOpcional('JWT_ISSUER', 'roadmap-api'),
    },
    google: {
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      callbackUrl: textoOpcional(
        'GOOGLE_CALLBACK_URL',
        'http://localhost:3000/api/auth/google/callback',
      ),
      dominiosPermitidos: lista('GOOGLE_ALLOWED_DOMAINS').map((d) => d.toLowerCase()),
      autoProvisionar: booleano('GOOGLE_AUTO_PROVISION', true),
      configurado: Boolean(googleClientId && googleClientSecret),
    },
    asana: {
      baseUrl: textoOpcional('ASANA_API_BASE_URL', 'https://app.asana.com/api/1.0').replace(
        /\/+$/,
        '',
      ),
      oauthClientId: asanaClientId,
      oauthClientSecret: asanaClientSecret,
      oauthRedirectUri: textoOpcional(
        'ASANA_OAUTH_REDIRECT_URI',
        '',
      ),
      oauthAuthorizeUrl: textoOpcional(
        'ASANA_OAUTH_AUTHORIZE_URL',
        'https://app.asana.com/-/oauth_authorize',
      ),
      oauthTokenUrl: textoOpcional('ASANA_OAUTH_TOKEN_URL', 'https://app.asana.com/-/oauth_token'),
      oauthScopes: textoOpcional('ASANA_OAUTH_SCOPES', 'default'),
      oauthConfigurado: Boolean(asanaClientId && asanaClientSecret),
      rateLimitPorMinuto: inteiro('ASANA_RATE_LIMIT_PER_MINUTE', 140),
      timeoutMs: inteiro('ASANA_HTTP_TIMEOUT_MS', 20000),
      nomeProjetoSprint: textoOpcional('ASANA_PROJETO_SPRINT_NOME', 'SPRINT'),
      nomeProjetoBacklog: textoOpcional('ASANA_PROJETO_BACKLOG_NOME', 'Backlog'),
      nomeSecaoSprint: textoOpcional('ASANA_SECAO_SPRINT_PADRAO', 'A fazer'),
      nomeSecaoBacklog: textoOpcional('ASANA_SECAO_BACKLOG_PADRAO', 'Refino'),
      webhookUrl: textoOpcional('ASANA_WEBHOOK_URL'),
      webhookAutoRegistrar: booleano('ASANA_WEBHOOK_AUTO_REGISTER', true),
      reconciliacaoCron: textoOpcional('ASANA_RECONCILIACAO_CRON', '0 */15 * * * *'),
      catalogoSyncCron: textoOpcional('ASANA_CATALOGO_SYNC_CRON', '0 0 * * * *'),
    },
    workers: {
      habilitados: booleano('WORKERS_ENABLED', true),
      id: textoOpcional('WORKER_ID') || `${require('os').hostname()}-${process.pid}`,
      integracaoCron: textoOpcional('INTEGRACAO_WORKER_CRON', '*/10 * * * * *'),
      integracaoLote: inteiro('INTEGRACAO_WORKER_LOTE', 10),
      integracaoLeaseSegundos: inteiro('INTEGRACAO_WORKER_LEASE_SEGUNDOS', 120),
      integracaoMaxTentativas: inteiro('INTEGRACAO_MAX_TENTATIVAS', 8),
      notificacaoCron: textoOpcional('NOTIFICACAO_WORKER_CRON', '*/15 * * * * *'),
      notificacaoLote: inteiro('NOTIFICACAO_WORKER_LOTE', 10),
      notificacaoLeaseSegundos: inteiro('NOTIFICACAO_WORKER_LEASE_SEGUNDOS', 120),
      notificacaoMaxTentativas: inteiro('NOTIFICACAO_MAX_TENTATIVAS', 6),
      backoffBaseSegundos: inteiro('RETRY_BACKOFF_BASE_SEGUNDOS', 15),
      backoffMaxSegundos: inteiro('RETRY_BACKOFF_MAX_SEGUNDOS', 3600),
    },
    mail: {
      habilitado: booleano('MAIL_ENABLED', false),
      host: textoOpcional('MAIL_HOST'),
      porta: inteiro('MAIL_PORT', 587),
      seguranca: seguranca as SegurancaSmtp,
      usuario: textoOpcional('MAIL_USER'),
      senha: textoOpcional('MAIL_PASSWORD'),
      remetenteEmail: textoOpcional('MAIL_FROM_EMAIL'),
      remetenteNome: textoOpcional('MAIL_FROM_NAME', 'Gerenciador de Roadmap'),
      rejeitarNaoAutorizado: booleano('MAIL_TLS_REJECT_UNAUTHORIZED', true),
    },
    waha: {
      habilitado: booleano('WAHA_ENABLED', false),
      nome: textoOpcional('WAHA_NOME', 'WAHA Principal'),
      baseUrl: textoOpcional('WAHA_BASE_URL', 'http://localhost:3001').replace(/\/+$/, ''),
      apiKey: textoOpcional('WAHA_API_KEY'),
      webhookSecret: textoOpcional('WAHA_WEBHOOK_SECRET'),
      webhookUrl: textoOpcional('WAHA_WEBHOOK_URL'),
      prefixoSessao: textoOpcional('WAHA_SESSION_PREFIX', 'gestor'),
      timeoutMs: inteiro('WAHA_HTTP_TIMEOUT_MS', 30000),
      codigoPaisPadrao: textoOpcional('WHATSAPP_DEFAULT_COUNTRY_CODE', '55'),
    },
    storage: {
      driver: textoOpcional('STORAGE_DRIVER', 'local'),
      caminhoLocal: textoOpcional('STORAGE_LOCAL_PATH', './storage/referencias'),
      tamanhoMaximoBytes: inteiro('STORAGE_MAX_FILE_MB', 25) * 1024 * 1024,
      mimesPermitidos: lista('STORAGE_MIME_PERMITIDOS'),
    },
    bootstrap: {
      adminEmail: textoOpcional('BOOTSTRAP_ADMIN_EMAIL'),
      adminNome: textoOpcional('BOOTSTRAP_ADMIN_NOME', 'Administrador'),
      adminSenha: textoOpcional('BOOTSTRAP_ADMIN_SENHA'),
    },
    log: {
      nivel: textoOpcional('LOG_LEVEL', 'log'),
      registrarPayloadIntegracao: booleano('LOG_INTEGRACAO_PAYLOAD', true),
    },
  };
}

/** Token de injecao usado por todos os services. */
export const CONFIG_APP = 'CONFIG_APP';
