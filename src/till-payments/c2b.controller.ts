import { Body, Controller, HttpCode, Logger, Param, Post, Req } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
// ADJUST THIS ONE LINE: import the "no login needed" decorator exactly as your health controller does.
import { Public } from '../auth/decorators/public.decorator';
import { TillPaymentsService } from './till-payments.service';

/**
 * Where Safaricom sends payment notifications.
 *
 *   POST /api/v1/c2b/<C2B_CALLBACK_TOKEN>/confirmation   money has arrived (this is the one that matters)
 *   POST /api/v1/c2b/<C2B_CALLBACK_TOKEN>/validation     optional pre-check, only if Safaricom enabled it for you
 *
 * Daraja rejects URLs that contain certain words (it has refused ones with "mpesa" in them),
 * so the path says "c2b" and nothing else. Keep it that way.
 */
@Controller('c2b')
export class C2bController {
  private readonly log = new Logger(C2bController.name);

  constructor(private readonly tills: TillPaymentsService) {}

  @Public()
  @SkipThrottle()
  @HttpCode(200)
  @Post(':token/confirmation')
  async confirmation(
    @Param('token') token: string,
    @Body() body: Record<string, unknown>,
    @Req() req: { ip?: string },
  ) {
    this.tills.assertCallbackAccess(token, req.ip);
    // A database error is thrown here on purpose: a 500 makes Safaricom try again later.
    const outcome = await this.tills.recordConfirmation(body ?? {});
    this.log.log(`C2B confirmation ${String((body ?? {}).TransID ?? '?')}: ${outcome}`);
    return { ResultCode: 0, ResultDesc: 'Accepted' };
  }

  @Public()
  @SkipThrottle()
  @HttpCode(200)
  @Post(':token/validation')
  validation(@Param('token') token: string, @Req() req: { ip?: string }) {
    this.tills.assertCallbackAccess(token, req.ip);
    // We never refuse a payment here: the customer has already decided to pay.
    return { ResultCode: 0, ResultDesc: 'Accepted' };
  }
}
