import { Module } from '@nestjs/common';
import { AsanaConexoesModule } from '../asana-conexoes/asana-conexoes.module';
import { IntegracaoController } from './integracao.controller';
import { IntegracaoRepository } from './integracao.repository';
import { IntegracaoService } from './integracao.service';
import { IntegracaoWorker } from './integracao.worker';
import { SincronizacaoRepository } from './sincronizacao.repository';

@Module({
  imports: [AsanaConexoesModule],
  controllers: [IntegracaoController],
  providers: [IntegracaoService, IntegracaoRepository, SincronizacaoRepository, IntegracaoWorker],
  exports: [IntegracaoService, IntegracaoRepository, SincronizacaoRepository],
})
export class IntegracaoModule {}
