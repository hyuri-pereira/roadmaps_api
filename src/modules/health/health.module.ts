import { Controller, Get, Inject, Injectable, Module } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppConfig, CONFIG_APP } from '../../common/config/configuration';
import { Publico } from '../../common/decorators';
import { FirebirdService } from '../../database/firebird.service';

@Injectable()
export class HealthService {
  constructor(
    private readonly db: FirebirdService,
    @Inject(CONFIG_APP) private readonly config: AppConfig,
  ) {}

  async verificar() {
    const inicio = Date.now();
    let banco: { ok: boolean; latenciaMs?: number; erro?: string };

    try {
      await this.db.queryUm('SELECT 1 AS OK FROM RDB$DATABASE');
      banco = { ok: true, latenciaMs: Date.now() - inicio };
    } catch (erro) {
      banco = { ok: false, erro: (erro as Error).message };
    }

    return {
      status: banco.ok ? 'ok' : 'degradado',
      ambiente: this.config.app.ambiente,
      versaoNode: process.version,
      uptimeSegundos: Math.round(process.uptime()),
      banco: {
        ...banco,
        driver: this.db.nomeDriver,
        host: `${this.config.firebird.host}:${this.config.firebird.porta}`,
      },
      integracoes: {
        // Apenas indica se esta configurado, nunca expoe credenciais.
        googleOAuth: this.config.google.configurado,
        asanaOAuth: this.config.asana.oauthConfigurado,
        asanaWebhook: Boolean(this.config.asana.webhookUrl),
        email: this.config.mail.habilitado,
        whatsapp: this.config.waha.habilitado,
        workers: this.config.workers.habilitados,
      },
    };
  }
}

@ApiTags('13. Saude')
@Controller('health')
export class HealthController {
  constructor(private readonly service: HealthService) {}

  @Publico()
  @Get()
  @ApiOperation({
    summary: 'Verifica a API e a conexao com o Firebird',
    description: 'Rota publica, usada por monitoramento. Nao expoe credenciais.',
  })
  verificar() {
    return this.service.verificar();
  }
}

@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
