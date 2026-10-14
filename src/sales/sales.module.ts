import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [InventoryModule, SettingsModule],
  controllers: [SalesController],
  providers: [SalesService],
})
export class SalesModule {}
