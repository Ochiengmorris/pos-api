import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import {
  IgnoreDto,
  ListQueryDto,
  ReserveDto,
  WaitingQueryDto,
} from './dto/till-payments.dto';
import { TillPaymentsService } from './till-payments.service';

@Controller('till-payments')
export class TillPaymentsController {
  constructor(private readonly tills: TillPaymentsService) {}

  // ---- any signed-in user (the till)
  @Get('config')
  config() {
    return this.tills.publicConfig();
  }

  @Get('waiting')
  waiting(@Query() q: WaitingQueryDto, @CurrentUser() u: AuthUser) {
    return this.tills.waiting(u, q);
  }

  @Post(':transId/reserve')
  reserve(
    @Param('transId') transId: string,
    @Body() dto: ReserveDto,
    @CurrentUser() u: AuthUser,
  ) {
    return this.tills.reserve(u, transId, dto);
  }

  // ---- managers
  @Roles(Role.MANAGER)
  @Get()
  list(@Query() q: ListQueryDto) {
    return this.tills.list(q);
  }

  @Roles(Role.MANAGER)
  @Get('export')
  export(@Query() q: ListQueryDto) {
    return this.tills.exportCsv(q.date);
  }

  @Roles(Role.MANAGER)
  @Post(':id/ignore')
  ignore(
    @Param('id') id: string,
    @Body() dto: IgnoreDto,
    @CurrentUser() u: AuthUser,
  ) {
    return this.tills.ignore(u, id, dto);
  }
}
