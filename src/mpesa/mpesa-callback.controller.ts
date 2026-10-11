import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { MpesaService } from './mpesa.service';
import { SkipThrottle } from '@nestjs/throttler';

@SkipThrottle()
@Controller('payments/hooks')
export class MpesaCallbackController {
  constructor(private readonly mpesa: MpesaService) {}

  @Public() // Daraja has no JWT; the secret in the path authenticates it
  @Post('stk/:secret')
  @HttpCode(200)
  callback(@Param('secret') secret: string, @Body() body: unknown) {
    return this.mpesa.handleCallback(secret, body);
  }
}
