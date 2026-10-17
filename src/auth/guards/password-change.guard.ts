import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ALLOW_PENDING_PASSWORD_KEY } from '../decorators/allow-pending-password.decorator';

@Injectable()
export class PasswordChangeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const { user } = context.switchToHttp().getRequest();
    if (!user?.mustChangePassword) return true; // public routes have no user; everyone else passes

    const allowed = this.reflector.getAllAndOverride<boolean>(
      ALLOW_PENDING_PASSWORD_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (allowed) return true;

    throw new ForbiddenException({
      code: 'PASSWORD_CHANGE_REQUIRED',
      message: 'You must change your password before continuing',
    });
  }
}
