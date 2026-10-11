import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { InitiateStkDto } from './dto/initiate-stk.dto';
import { MpesaService } from './mpesa.service';

@Controller('payments/mpesa')
export class MpesaController {
  constructor(private readonly mpesa: MpesaService) {}

  @Post('stk')
  initiate(@Body() dto: InitiateStkDto, @CurrentUser() user: AuthUser) {
    return this.mpesa.initiate(dto, user);
  }

  @Roles(Role.MANAGER)
  @Get('unclaimed')
  unclaimed() {
    return this.mpesa.unclaimed();
  }

  @Get(':id')
  status(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.mpesa.getStatus(id, user);
  }
}
