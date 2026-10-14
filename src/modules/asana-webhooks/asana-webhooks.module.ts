import { Module } from '@nestjs/common';
import { AsanaCatalogoModule } from '../asana-catalogo/asana-catalogo.module';
import { AsanaConexoesModule } from '../asana-conexoes/asana-conexoes.module';
import { CardsModule } from '../cards/cards.module';
import { IntegracaoModule } from '../integracao/integracao.module';
import { AsanaWebhooksController } from './asana-webhooks.controller';
import { AsanaWebhooksRepository } from './asana-webhooks.repository';
import { AsanaWebhooksService } from './asana-webhooks.service';
import { AsanaWebhooksWorker } from './asana-webhooks.worker';

@Module({
  imports: [AsanaConexoesModule, AsanaCatalogoModule, CardsModule, IntegracaoModule],
  controllers: [AsanaWebhooksController],
  providers: [AsanaWebhooksService, AsanaWebhooksRepository, AsanaWebhooksWorker],
  exports: [AsanaWebhooksService],
})
export class AsanaWebhooksModule {}
