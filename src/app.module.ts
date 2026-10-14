import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { BootstrapService } from './bootstrap.service';
import { CommonModule } from './common/common.module';
import { JwtAuthGuard } from './common/guards';
import { DatabaseModule } from './database/database.module';
import { AsanaCatalogoModule } from './modules/asana-catalogo/asana-catalogo.module';
import { AsanaConexoesModule } from './modules/asana-conexoes/asana-conexoes.module';
import { AsanaWebhooksModule } from './modules/asana-webhooks/asana-webhooks.module';
import { AuditoriaModule } from './modules/auditoria/auditoria.module';
import { AuthModule } from './modules/auth/auth.module';
import { CardsModule } from './modules/cards/cards.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { EquipesModule } from './modules/equipes/equipes.module';
import { HealthModule } from './modules/health/health.module';
import { IntegracaoModule } from './modules/integracao/integracao.module';
import { NotificacoesModule } from './modules/notificacoes/notificacoes.module';
import { ProjetosModule } from './modules/projetos/projetos.module';
import { RoadmapsModule } from './modules/roadmaps/roadmaps.module';
import { UsuariosModule } from './modules/usuarios/usuarios.module';
import { WahaModule } from './modules/waha/waha.module';

@Module({
  imports: [
    // Le o .env uma unica vez; a validacao de verdade esta em carregarConfiguracao().
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    ScheduleModule.forRoot(),
    CommonModule,
    DatabaseModule,

    // Cada modulo corresponde a uma secao do DDL e a uma tag no Swagger.
    AuthModule,
    UsuariosModule,
    AsanaConexoesModule,
    AsanaCatalogoModule,
    EquipesModule,
    ProjetosModule,
    RoadmapsModule,
    CardsModule,
    IntegracaoModule,
    AsanaWebhooksModule,
    WahaModule,
    NotificacoesModule,
    DashboardModule,
    AuditoriaModule,
    HealthModule,
  ],
  providers: [
    BootstrapService,
    // JWT obrigatorio em tudo, menos nas rotas marcadas com @Publico().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
