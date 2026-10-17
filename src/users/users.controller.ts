import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ChangePasswordDto } from './dto/change-password.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersDto } from './dto/list-users.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UsersService } from './users.service';
import { AllowPendingPassword } from '../auth/decorators/allow-pending-password.decorator';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  // Any logged-in user (no @Roles)
  @AllowPendingPassword()
  @Patch('me/password')
  changeOwnPassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.users.changeOwnPassword(user, dto);
  }

  // Admin only from here down
  @Roles(Role.ADMIN)
  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }

  @Roles(Role.ADMIN)
  @Get()
  findAll(@Query() query: ListUsersDto) {
    return this.users.findAll(query);
  }

  @Roles(Role.ADMIN)
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.users.findOne(id);
  }

  @Roles(Role.ADMIN)
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.users.update(id, dto, actor);
  }

  @Roles(Role.ADMIN)
  @Patch(':id/password')
  resetPassword(
    @Param('id') id: string,
    @Body() dto: ResetPasswordDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.users.resetPassword(id, dto, actor);
  }
}
