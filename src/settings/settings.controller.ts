import { Body, Controller, Get, Patch } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { UpdateStoreDto } from './dto/update-store.dto';
import { SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get('store')
  store() {
    return this.settings.get();
  }

  @Roles(Role.ADMIN)
  @Patch('store')
  update(@Body() dto: UpdateStoreDto, @CurrentUser() user: AuthUser) {
    return this.settings.update(dto, user);
  }
}
