import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { AppConfig, CONFIG_APP } from '../../common/config/configuration';
import { RoadmapsModule } from '../roadmaps/roadmaps.module';
import { CardsController } from './cards.controller';
import { CardsRepository } from './cards.repository';
import { CardsService } from './cards.service';
import { StorageService } from './storage.service';

@Module({
  imports: [
    RoadmapsModule,
    // Arquivo fica em memoria ate o StorageService validar e gravar; o limite
    // do multer evita que um upload gigante consuma RAM antes da validacao.
    MulterModule.registerAsync({
      inject: [CONFIG_APP],
      useFactory: (config: AppConfig) => ({
        storage: memoryStorage(),
        limits: { fileSize: config.storage.tamanhoMaximoBytes, files: 1 },
      }),
    }),
  ],
  controllers: [CardsController],
  providers: [CardsService, CardsRepository, StorageService],
  exports: [CardsService, CardsRepository, StorageService],
})
export class CardsModule {}
