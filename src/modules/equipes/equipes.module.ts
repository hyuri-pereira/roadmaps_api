import { Module } from '@nestjs/common';
import { AsanaCatalogoModule } from '../asana-catalogo/asana-catalogo.module';
import { UsuariosModule } from '../usuarios/usuarios.module';
import { EquipesController } from './equipes.controller';
import { EquipesRepository } from './equipes.repository';
import { EquipesService } from './equipes.service';

@Module({
  imports: [AsanaCatalogoModule, UsuariosModule],
  controllers: [EquipesController],
  providers: [EquipesService, EquipesRepository],
  exports: [EquipesService, EquipesRepository],
})
export class EquipesModule {}
