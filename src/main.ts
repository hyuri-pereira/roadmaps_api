import { Logger, LogLevel, ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import helmet from 'helmet';
import * as express from 'express';
import { AppModule } from './app.module';
import { AppConfig, CONFIG_APP } from './common/config/configuration';
import {
  FirebirdExceptionFilter,
  HttpExceptionFilter,
} from './common/filters/firebird-exception.filter';

const NIVEIS: Record<string, LogLevel[]> = {
  error: ['error'],
  warn: ['error', 'warn'],
  log: ['error', 'warn', 'log'],
  debug: ['error', 'warn', 'log', 'debug'],
  verbose: ['error', 'warn', 'log', 'debug', 'verbose'],
};

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: NIVEIS[process.env.LOG_LEVEL ?? 'log'] ?? NIVEIS.log,
    bufferLogs: true,
  });

  const config = app.get<AppConfig>(CONFIG_APP);
  const logger = new Logger('Bootstrap');

  /**
   * O webhook do Asana assina o corpo BRUTO. Sem guardar o buffer original,
   * a validacao do HMAC falharia por qualquer diferenca de serializacao.
   */
  app.use(
    express.json({
      limit: '2mb',
      verify: (req: express.Request & { rawBody?: Buffer }, _res, buffer) => {
        req.rawBody = Buffer.from(buffer);
      },
    }),
  );
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  app.use(
    helmet({
      // O Swagger UI precisa de scripts/estilos inline.
      contentSecurityPolicy: config.app.producao
        ? {
            // Servido em HTTP puro, upgrade-insecure-requests faria o navegador
            // pedir os assets do Swagger em HTTPS, que nao existe.
            directives: config.app.urlPublica.startsWith('https://')
              ? {}
              : { upgradeInsecureRequests: null },
          }
        : false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(compression());

  app.setGlobalPrefix(config.app.prefixo);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: false as never });

  app.enableCors({
    origin: config.app.corsOrigens.length ? config.app.corsOrigens : true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // A ordem importa: o filtro mais especifico (Firebird) e registrado por
  // ultimo para ter prioridade sobre o de HttpException.
  app.useGlobalFilters(new HttpExceptionFilter(), new FirebirdExceptionFilter());

  app.enableShutdownHooks();

  if (config.app.swaggerHabilitado) {
    const documento = new DocumentBuilder()
      .setTitle('Gerenciador de Roadmap + Asana')
      .setDescription(
        [
          'Backend do gerenciador de roadmaps integrado ao Asana.',
          '',
          '**Como o sistema funciona, em resumo:**',
          '1. O gestor conecta o Asana com o proprio PAT ou por OAuth (secao 2).',
          '2. Sincroniza o catalogo e escolhe, para a equipe, os destinos SPRINT/"A fazer" ' +
            'e Backlog/"Refino" (secoes 3 e 4).',
          '3. Cria um roadmap vinculado a um projeto, com periodo de 1 semana a 3 meses ' +
            'e um objetivo em texto (secao 5).',
          '4. Escreve cards; marcados vao para SPRINT/"A fazer", desmarcados para ' +
            'Backlog/"Refino" (secao 6).',
          '5. Os workers publicam tudo no Asana e trazem de volta as mudancas feitas la ' +
            '(secoes 7 e 8).',
          '6. O percentual do roadmap sai da view do banco e muda sozinho conforme os ' +
            'cards sao incluidos, excluidos ou concluidos (secao 11).',
          '',
          'Autenticacao: obtenha o token em `/auth/login` ou pelo fluxo Google em ' +
            '`/auth/google`, e envie em `Authorization: Bearer <token>`.',
        ].join('\n'),
      )
      .setVersion('1.0')
      .addBearerAuth({
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Cole aqui o accessToken devolvido pelo login.',
      })
      .build();

    const spec = SwaggerModule.createDocument(app, documento);
    SwaggerModule.setup(`${config.app.prefixo}/docs`, app, spec, {
      swaggerOptions: { persistAuthorization: true, tagsSorter: 'alpha' },
      customSiteTitle: 'API Roadmap + Asana',
    });
  }

  await app.listen(config.app.porta, '0.0.0.0');

  logger.log(`API ouvindo em http://localhost:${config.app.porta}/${config.app.prefixo}`);
  if (config.app.swaggerHabilitado) {
    logger.log(`Swagger em http://localhost:${config.app.porta}/${config.app.prefixo}/docs`);
  }
}

bootstrap().catch((erro) => {
  // Falha de configuracao precisa ser obvia: sem stack trace gigante.
  const mensagem = erro instanceof Error ? erro.message : String(erro);
  // eslint-disable-next-line no-console
  console.error(`\nNao foi possivel iniciar a API:\n  ${mensagem}\n`);
  process.exit(1);
});
