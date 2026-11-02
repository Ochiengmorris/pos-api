import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';

import { Roles } from '../auth/decorators/roles.decorator';
import {
  ApplyCountDto,
  CreateCountDto,
  FindQueryDto,
  LinesQueryDto,
  SaveEntriesDto,
} from './dto/stock-count.dto';
import { StockCountService } from './stock-count.service';

@Roles(Role.MANAGER)
@Controller('stock-counts')
export class StockCountController {
  constructor(private readonly counts: StockCountService) {}

  @Post() create(@Body() dto: CreateCountDto, @CurrentUser() user: AuthUser) {
    return this.counts.create(dto, user);
  }
  @Get() list() {
    return this.counts.list();
  }
  @Get(':id') detail(@Param('id') id: string) {
    return this.counts.detail(id);
  }
  @Get(':id/lines') lines(@Param('id') id: string, @Query() q: LinesQueryDto) {
    return this.counts.lines(id, q);
  }
  @Get(':id/find') find(@Param('id') id: string, @Query() q: FindQueryDto) {
    return this.counts.find(id, q.q);
  }

  @Post(':id/entries') save(
    @Param('id') id: string,
    @Body() dto: SaveEntriesDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.counts.saveEntries(id, dto, user);
  }
  @Delete(':id/entries/:productId') remove(
    @Param('id') id: string,
    @Param('productId') productId: string,
  ) {
    return this.counts.removeEntry(id, productId);
  }

  // an administrator is required inside the service when the difference is large
  @Post(':id/apply') apply(
    @Param('id') id: string,
    @Body() dto: ApplyCountDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.counts.apply(id, dto, user);
  }
  @Post(':id/cancel') cancel(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.counts.cancel(id, user);
  }

  @Get(':id/export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  exportCsv(@Param('id') id: string) {
    return this.counts.exportCsv(id);
  }
}
