import { Module } from '@nestjs/common';
import { EquipesModule } from '../equipes/equipes.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [EquipesModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
