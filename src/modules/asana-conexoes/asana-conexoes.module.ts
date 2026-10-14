import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AsanaConexoesController } from './asana-conexoes.controller';
import { AsanaConexoesRepository } from './asana-conexoes.repository';
import { AsanaConexoesService } from './asana-conexoes.service';

@Module({
  imports: [AuthModule],
  controllers: [AsanaConexoesController],
  providers: [AsanaConexoesService, AsanaConexoesRepository],
  exports: [AsanaConexoesService, AsanaConexoesRepository],
})
export class AsanaConexoesModule {}
