import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import {
  AcknowledgeDto,
  CloseShiftDto,
  ListShiftsDto,
  MovementDto,
  OpenShiftDto,
  SummaryQueryDto,
} from './dto/cash.dto';
import { CashService } from './cash.service';

@Controller('cash')
export class CashController {
  constructor(private readonly cash: CashService) {}

  // any signed-in user; cashiers only ever see their own shifts (enforced in the service)
  @Get('shifts/current') current(@CurrentUser() u: AuthUser) {
    return this.cash.current(u);
  }
  @Post('shifts') open(@Body() dto: OpenShiftDto, @CurrentUser() u: AuthUser) {
    return this.cash.open(u, dto);
  }
  @Get('shifts') list(@Query() q: ListShiftsDto, @CurrentUser() u: AuthUser) {
    return this.cash.list(q, u);
  }
  @Get('shifts/:id') detail(
    @Param('id') id: string,
    @CurrentUser() u: AuthUser,
  ) {
    return this.cash.detail(id, u);
  }
  @Post('shifts/:id/movements') move(
    @Param('id') id: string,
    @Body() dto: MovementDto,
    @CurrentUser() u: AuthUser,
  ) {
    return this.cash.addMovement(id, dto, u);
  }
  @Post('shifts/:id/close') close(
    @Param('id') id: string,
    @Body() dto: CloseShiftDto,
    @CurrentUser() u: AuthUser,
  ) {
    return this.cash.close(id, dto, u);
  }

  @Roles(Role.MANAGER)
  @Post('shifts/:id/acknowledge')
  acknowledge(
    @Param('id') id: string,
    @Body() dto: AcknowledgeDto,
    @CurrentUser() u: AuthUser,
  ) {
    return this.cash.acknowledge(id, dto, u);
  }

  @Roles(Role.MANAGER)
  @Get('summary')
  summary(@Query() q: SummaryQueryDto) {
    return this.cash.summary(q.date);
  }
}
