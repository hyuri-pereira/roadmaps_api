import { Module } from '@nestjs/common';
import { AsanaConexoesModule } from '../asana-conexoes/asana-conexoes.module';
import { AsanaCatalogoController } from './asana-catalogo.controller';
import { AsanaCatalogoRepository } from './asana-catalogo.repository';
import { AsanaCatalogoService } from './asana-catalogo.service';
import { AsanaCatalogoWorker } from './asana-catalogo.worker';

@Module({
  imports: [AsanaConexoesModule],
  controllers: [AsanaCatalogoController],
  providers: [AsanaCatalogoService, AsanaCatalogoRepository, AsanaCatalogoWorker],
  exports: [AsanaCatalogoService, AsanaCatalogoRepository],
})
export class AsanaCatalogoModule {}
