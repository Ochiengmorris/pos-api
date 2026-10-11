import { Controller, Get, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import {
  ReportRangeDto,
  ShiftDto,
  TopProductsDto,
  TrendDto,
} from './dto/report-query.dto';
import { ReportsService } from './reports.service';

@Roles(Role.MANAGER) // class default: managers and admins
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('dashboard')
  dashboard() {
    return this.reports.dashboard();
  }

  @Get('overview')
  overview(@Query() q: ReportRangeDto) {
    return this.reports.overview(q);
  }

  @Get('trend')
  trend(@Query() q: TrendDto) {
    return this.reports.trend(q);
  }

  @Get('top-products')
  topProducts(@Query() q: TopProductsDto) {
    return this.reports.topProducts(q);
  }

  @Get('categories')
  categories(@Query() q: ReportRangeDto) {
    return this.reports.salesByCategory(q);
  }

  @Get('payment-methods')
  paymentMethods(@Query() q: ReportRangeDto) {
    return this.reports.paymentMethods(q);
  }

  @Get('tax')
  tax(@Query() q: ReportRangeDto) {
    return this.reports.tax(q);
  }

  @Get('cashiers')
  cashiers(@Query() q: ReportRangeDto) {
    return this.reports.cashiers(q);
  }

  // Method-level @Roles replaces the class default: cashiers allowed, scoped to themselves
  @Roles(Role.CASHIER, Role.MANAGER)
  @Get('shift')
  shift(@Query() q: ShiftDto, @CurrentUser() user: AuthUser) {
    return this.reports.shift(user, q);
  }
}
