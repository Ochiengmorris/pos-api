import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsIn } from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
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

  // any signed-in user, scoped to their own sales for cashiers
  @Get('sales/:saleId')
  forSale(@Param('saleId') saleId: string, @CurrentUser() user: AuthUser) {
    return this.etims.statusForSale(saleId, user);
  }

  @Post('sales/:saleId/printed')
  printed(@Param('saleId') saleId: string, @CurrentUser() user: AuthUser) {
    return this.etims.markPrinted(saleId, user);
  }

  @Roles(Role.MANAGER)
  @Post('invoices/:id/retry')
  retry(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.etims.retry(id, user);
  }

  // Development only: switch the mock KRA between normal and failure behaviours to see every state in the UI
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
