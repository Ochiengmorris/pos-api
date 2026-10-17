import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import type { AuthUser } from './decorators/current-user.decorator';
import { Throttle } from '@nestjs/throttler';
import { AllowPendingPassword } from './decorators/allow-pending-password.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } }) // 5 attempts per minute per IP
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @AllowPendingPassword()
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }
}
