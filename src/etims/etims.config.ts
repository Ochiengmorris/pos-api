import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type ProviderKind = 'disabled' | 'mock' | 'oscu';

@Injectable()
export class EtimsConfig {
  constructor(private readonly c: ConfigService) {}

  get provider(): ProviderKind {
    return this.c.get<ProviderKind>('ETIMS_PROVIDER', 'disabled');
  }
  get enabled() {
    return this.provider !== 'disabled';
  }
  get environment(): 'MOCK' | 'SANDBOX' | 'PRODUCTION' {
    if (this.provider === 'mock') return 'MOCK';
    return this.c.get('ETIMS_ENVIRONMENT', 'SANDBOX') === 'PRODUCTION'
      ? 'PRODUCTION'
      : 'SANDBOX';
  }
  get tin() {
    return this.c.get<string>('ETIMS_TIN', '');
  }
  get bhfId() {
    return this.c.get<string>('ETIMS_BHF_ID', '00');
  }
  get taxableBasis(): 'inclusive' | 'exclusive' {
    return this.c.get('ETIMS_TAXBL_BASIS', 'inclusive') === 'exclusive'
      ? 'exclusive'
      : 'inclusive';
  }
  get firstInvoiceNo() {
    return Number(this.c.get('ETIMS_FIRST_INVOICE_NO', '1'));
  }
  get maxAttempts() {
    return Number(this.c.get('ETIMS_MAX_ATTEMPTS', '20'));
  }
  get workerOn() {
    return this.c.get('ETIMS_WORKER', 'on') !== 'off';
  }
  get qrUrlTemplate() {
    return this.c.get<string>('ETIMS_QR_URL_TEMPLATE', '');
  }
  get mockMode() {
    return this.c.get<string>('MOCK_ETIMS_MODE', 'ok');
  }
  get stuckMinutes() {
    return Number(this.c.get('ETIMS_STUCK_MINUTES', '15'));
  }
  get alertWebhookUrl() {
    return this.c.get<string>('ETIMS_ALERT_WEBHOOK_URL', '');
  }
}
