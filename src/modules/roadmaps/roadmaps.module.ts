import { Module } from '@nestjs/common';
import { AsanaCatalogoModule } from '../asana-catalogo/asana-catalogo.module';
import { AsanaConexoesModule } from '../asana-conexoes/asana-conexoes.module';
import { EquipesModule } from '../equipes/equipes.module';
import { ProjetosModule } from '../projetos/projetos.module';
import { RoadmapsController } from './roadmaps.controller';
import { RoadmapsRepository } from './roadmaps.repository';
import { RoadmapsService } from './roadmaps.service';

@Module({
  imports: [EquipesModule, AsanaCatalogoModule, AsanaConexoesModule, ProjetosModule],
  controllers: [RoadmapsController],
  providers: [RoadmapsService, RoadmapsRepository],
  exports: [RoadmapsService, RoadmapsRepository],
})
export class RoadmapsModule {}
