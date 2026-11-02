import { Module } from '@nestjs/common';
import { StockCountController } from './stock-count.controller';
import { StockCountService } from './stock-count.service';

@Module({ controllers: [StockCountController], providers: [StockCountService] })
export class StockCountModule {}
