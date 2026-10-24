// src/reports/reports.module.ts
import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { EtimsModule } from '../etims/etims.module';

@Module({
  imports: [InventoryModule, EtimsModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
