import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Role, TaxTypeCode } from '@prisma/client';
import { IsIn } from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import {
  ConfirmTaxDto,
  ListInvoicesDto,
  ResolveInvoiceDto,
  RetryDto,
  TaxReviewQueryDto,
  UpdateTaxRateDto,
} from './dto/etims.dto';
import { EtimsConfig } from './etims.config';
import { EtimsService } from './etims.service';
import {
  MOCK_MODES,
  MockEtimsProvider,
  type MockMode,
} from './providers/mock.provider';

class MockModeDto {
  @IsIn([...MOCK_MODES])
  mode: MockMode;
}

@Controller('etims')
export class EtimsController {
  constructor(
    private readonly etims: EtimsService,
    private readonly cfg: EtimsConfig,
    private readonly mock: MockEtimsProvider,
  ) {}

  // ----- any signed-in user (cashiers only for their own sales) -----
  @Get('sales/:saleId')
  forSale(@Param('saleId') saleId: string, @CurrentUser() user: AuthUser) {
    return this.etims.statusForSale(saleId, user);
  }

  @Post('sales/:saleId/printed')
  printed(@Param('saleId') saleId: string, @CurrentUser() user: AuthUser) {
    return this.etims.markPrinted(saleId, user);
  }

  // ----- managers -----
  @Roles(Role.MANAGER)
  @Get('summary')
  summary() {
    return this.etims.summary();
  }

  @Roles(Role.MANAGER)
  @Get('invoices')
  list(@Query() q: ListInvoicesDto) {
    return this.etims.listInvoices(q);
  }

  @Roles(Role.MANAGER)
  @Get('invoices/:id')
  detail(@Param('id') id: string) {
    return this.etims.invoiceDetail(id);
  }

  @Roles(Role.MANAGER)
  @Post('invoices/:id/retry')
  retry(
    @Param('id') id: string,
    @Body() dto: RetryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.etims.retry(id, user, dto.rebuild === true);
  }

  @Roles(Role.MANAGER)
  @Post('retry-failed')
  retryFailed(@CurrentUser() user: AuthUser) {
    return this.etims.retryFailed(user);
  }

  // entering KRA's data by hand is further restricted to administrators inside the service
  @Roles(Role.MANAGER)
  @Post('invoices/:id/resolve')
  resolve(
    @Param('id') id: string,
    @Body() dto: ResolveInvoiceDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.etims.resolve(id, dto, user);
  }

  @Roles(Role.MANAGER)
  @Get('tax-review')
  taxReview(@Query() q: TaxReviewQueryDto) {
    return this.etims.taxReview(q);
  }

  @Roles(Role.MANAGER)
  @Post('tax-review/confirm')
  confirmTax(@Body() dto: ConfirmTaxDto, @CurrentUser() user: AuthUser) {
    return this.etims.confirmTax(dto.productIds, user);
  }

  @Roles(Role.MANAGER)
  @Get('tax-types')
  taxTypes() {
    return this.etims.taxTypes();
  }

  @Roles(Role.ADMIN)
  @Patch('tax-types/:code')
  updateRate(
    @Param('code') code: string,
    @Body() dto: UpdateTaxRateDto,
    @CurrentUser() user: AuthUser,
  ) {
    if (!['A', 'B', 'C', 'D', 'E'].includes(code))
      throw new NotFoundException('Unknown tax class');
    return this.etims.updateTaxRate(code as TaxTypeCode, dto.rate, user);
  }

  // ----- development only -----
  @Roles(Role.ADMIN)
  @Get('dev/mock-mode')
  getMode() {
    this.devOnly();
    return { mode: this.mock.mode, modes: MOCK_MODES };
  }

  @Roles(Role.ADMIN)
  @Post('dev/mock-mode')
  setMode(@Body() dto: MockModeDto) {
    this.devOnly();
    this.mock.setMode(dto.mode);
    return { mode: this.mock.mode };
  }

  private devOnly() {
    if (process.env.NODE_ENV === 'production' || this.cfg.provider !== 'mock')
      throw new NotFoundException();
  }
}
