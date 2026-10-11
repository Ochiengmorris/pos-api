// src/sales/sales.controller.ts
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreateSaleDto } from './dto/create-sale.dto';
import { ListSalesDto } from './dto/list-sales.dto';
import { VoidSaleDto } from './dto/void-sale.dto';
import { SalesService } from './sales.service';

@Controller('sales')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Post()
  create(@Body() dto: CreateSaleDto, @CurrentUser() user: AuthUser) {
    return this.sales.create(dto, user);
  }

  @Get()
  findAll(@Query() query: ListSalesDto, @CurrentUser() user: AuthUser) {
    return this.sales.findAll(query, user);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.sales.findOne(id, user);
  }

  @Get(':id/receipt')
  receipt(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.sales.receipt(id, user);
  }

  @Roles(Role.MANAGER)
  @Post(':id/void')
  voidSale(
    @Param('id') id: string,
    @Body() dto: VoidSaleDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.sales.voidSale(id, dto, user);
  }
}
