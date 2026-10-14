import { Module } from '@nestjs/common';
import { UsuariosModule } from '../usuarios/usuarios.module';
import { WahaController } from './waha.controller';
import { WahaRepository } from './waha.repository';
import { WahaService } from './waha.service';

@Module({
  imports: [UsuariosModule],
  controllers: [WahaController],
  providers: [WahaService, WahaRepository],
  exports: [WahaService, WahaRepository],
})
export class WahaModule {}
