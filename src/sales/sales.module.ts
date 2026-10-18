import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';
import { SettingsModule } from '../settings/settings.module';
import { EtimsModule } from '../etims/etims.module';

@Module({
  imports: [InventoryModule, SettingsModule, EtimsModule],
  controllers: [SalesController],
  providers: [SalesService],
})
export class SalesModule {}
