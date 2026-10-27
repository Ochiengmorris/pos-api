import { Module } from '@nestjs/common';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { ProductImportService } from './import/product-import.service';

@Module({
  providers: [ProductsService, ProductImportService],
  controllers: [ProductsController],
})
export class ProductsModule {}
