import { Module } from '@nestjs/common';
import { C2bController } from './c2b.controller';
import { TillPaymentsController } from './till-payments.controller';
import { TillPaymentsService } from './till-payments.service';

@Module({
  controllers: [C2bController, TillPaymentsController],
  providers: [TillPaymentsService],
  exports: [TillPaymentsService],
})
export class TillPaymentsModule {}
