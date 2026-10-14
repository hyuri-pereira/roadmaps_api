import { Module } from '@nestjs/common';
import { MailService } from '../../integrations/mail/mail.service';
import { UsuariosModule } from '../usuarios/usuarios.module';
import { WahaModule } from '../waha/waha.module';
import { NotificacoesController } from './notificacoes.controller';
import { NotificacoesRepository } from './notificacoes.repository';
import { NotificacoesService } from './notificacoes.service';
import { NotificacoesWorker } from './notificacoes.worker';

@Module({
  imports: [UsuariosModule, WahaModule],
  controllers: [NotificacoesController],
  providers: [NotificacoesService, NotificacoesRepository, NotificacoesWorker, MailService],
  exports: [NotificacoesService, MailService],
})
export class NotificacoesModule {}
