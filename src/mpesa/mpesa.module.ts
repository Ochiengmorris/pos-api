import { Module } from '@nestjs/common';
import { MpesaCallbackController } from './mpesa-callback.controller';
import { MpesaClient } from './mpesa.client';
import { MpesaController } from './mpesa.controller';
import { MpesaService } from './mpesa.service';

@Module({
  controllers: [MpesaController, MpesaCallbackController],
  providers: [MpesaService, MpesaClient],
})
export class MpesaModule {}
