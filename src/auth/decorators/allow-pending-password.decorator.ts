import { SetMetadata } from '@nestjs/common';

export const ALLOW_PENDING_PASSWORD_KEY = 'allowPendingPassword';
// marks the few routes a user may call while their password change is still pending
export const AllowPendingPassword = () =>
  SetMetadata(ALLOW_PENDING_PASSWORD_KEY, true);
