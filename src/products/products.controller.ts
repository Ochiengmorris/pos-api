import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreateProductDto } from './dto/create-product.dto';
import { ListProductsDto } from './dto/list-products.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductsService } from './products.service';
import { ProductImportService } from './import/product-import.service';
import { FileInterceptor } from '@nestjs/platform-express';
import { ImportQueryDto } from './import/import.dto';

@Controller('products')
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly importer: ProductImportService,
  ) {}

  @Get('lookup/:code')
  lookup(@Param('code') code: string, @CurrentUser() user: AuthUser) {
    return this.products.findByCode(code, user);
  }

  @Get()
  findAll(@Query() query: ListProductsDto, @CurrentUser() user: AuthUser) {
    return this.products.findAll(query, user);
  }

  @Roles(Role.MANAGER)
  @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  exportCsv() {
    return this.importer.exportCsv();
  }

  @Roles(Role.MANAGER)
  @Post('import')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }),
  )
  importCsv(
    @UploadedFile() file: Parameters<ProductImportService['run']>[0],
    // @UploadedFile() file: Express.Multer.File,
    @Query() q: ImportQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    if (!file)
      throw new BadRequestException('Attach a CSV file in the "file" field');
    return this.importer.run(file, q, user);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.products.findOne(id, user);
  }

  @Roles(Role.MANAGER)
  @Post()
  create(@Body() dto: CreateProductDto, @CurrentUser() user: AuthUser) {
    return this.products.create(dto, user);
  }

  @Roles(Role.MANAGER)
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.products.update(id, dto, user);
  }
}
