import { Module } from '@nestjs/common';
import { AsanaCatalogoModule } from '../asana-catalogo/asana-catalogo.module';
import { ProjetosController } from './projetos.controller';
import { ProjetosRepository } from './projetos.repository';
import { ProjetosService } from './projetos.service';

@Module({
  imports: [AsanaCatalogoModule],
  controllers: [ProjetosController],
  providers: [ProjetosService, ProjetosRepository],
  exports: [ProjetosService, ProjetosRepository],
})
export class ProjetosModule {}
