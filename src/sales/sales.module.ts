import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';
import { SettingsModule } from '../settings/settings.module';
import { EtimsModule } from '../etims/etims.module';
import { CashModule } from '../cash/cash.module';

@Module({
  imports: [InventoryModule, SettingsModule, EtimsModule, CashModule],
  controllers: [SalesController],
  providers: [SalesService],
})
export class SalesModule {}
