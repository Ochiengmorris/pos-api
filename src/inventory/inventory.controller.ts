import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdjustDto } from './dto/adjust.dto';
import { CountDto } from './dto/count.dto';
import { ListMovementsDto } from './dto/list-movements.dto';
import { RestockDto } from './dto/restock.dto';
import { InventoryService } from './inventory.service';

@Roles(Role.MANAGER) // whole controller: managers and admins only
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Post('restock')
  restock(@Body() dto: RestockDto, @CurrentUser() user: AuthUser) {
    return this.inventory.restock(dto, user.id);
  }

  @Post('adjust')
  adjust(@Body() dto: AdjustDto, @CurrentUser() user: AuthUser) {
    return this.inventory.adjust(dto, user.id);
  }

  @Post('count')
  count(@Body() dto: CountDto, @CurrentUser() user: AuthUser) {
    return this.inventory.count(dto, user.id);
  }

  @Get('movements')
  movements(@Query() query: ListMovementsDto) {
    return this.inventory.movements(query);
  }

  @Get('summary')
  summary() {
    return this.inventory.summary();
  }
}
