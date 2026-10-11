import { BadGatewayException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type StkPushResponse = {
  MerchantRequestID?: string;
  CheckoutRequestID?: string;
  ResponseCode?: string;
  ResponseDescription?: string;
  errorMessage?: string;
};

export type StkQueryResponse = {
  ResultCode?: string | number;
  ResultDesc?: string;
  errorCode?: string; // present while Daraja is still processing
  errorMessage?: string;
};

@Injectable()
export class MpesaClient {
  private token?: { value: string; expiresAt: number };
  private readonly base: string;

  constructor(private readonly config: ConfigService) {
    this.base =
      config.get('MPESA_ENV', 'sandbox') === 'production'
        ? 'https://api.safaricom.co.ke'
        : 'https://sandbox.safaricom.co.ke';
  }

  isConfigured() {
    return [
      'MPESA_CONSUMER_KEY',
      'MPESA_CONSUMER_SECRET',
      'MPESA_SHORTCODE',
      'MPESA_PASSKEY',
      'MPESA_CALLBACK_BASE_URL',
      'MPESA_CALLBACK_SECRET',
    ].every((k) => !!this.config.get(k));
  }

  private async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000)
      return this.token.value;

    const key = this.config.getOrThrow<string>('MPESA_CONSUMER_KEY');
    const secret = this.config.getOrThrow<string>('MPESA_CONSUMER_SECRET');
    const res = await fetch(
      `${this.base}/oauth/v1/generate?grant_type=client_credentials`,
      {
        headers: {
          Authorization:
            'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64'),
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) throw new BadGatewayException('M-Pesa authentication failed');

    const json = (await res.json()) as {
      access_token: string;
      expires_in: string;
    };
    this.token = {
      value: json.access_token,
      expiresAt: Date.now() + Number(json.expires_in) * 1000,
    };
    return json.access_token;
  }

  // YYYYMMDDHHmmss in East Africa Time
  private timestamp() {
    return new Date(Date.now() + 3 * 3600 * 1000)
      .toISOString()
      .replace(/\D/g, '')
      .slice(0, 14);
  }

  private password(ts: string) {
    const shortcode = this.config.getOrThrow<string>('MPESA_SHORTCODE');
    const passkey = this.config.getOrThrow<string>('MPESA_PASSKEY');
    return Buffer.from(`${shortcode}${passkey}${ts}`).toString('base64');
  }

  private async post<T>(path: string, body: unknown) {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.getToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as T;
    return { ok: res.ok, json };
  }

  stkPush(p: { phone: string; amount: number; callbackUrl: string }) {
    const shortcode = this.config.getOrThrow<string>('MPESA_SHORTCODE');
    const ts = this.timestamp();
    return this.post<StkPushResponse>('/mpesa/stkpush/v1/processrequest', {
      BusinessShortCode: shortcode,
      Password: this.password(ts),
      Timestamp: ts,
      TransactionType: this.config.get(
        'MPESA_TRANSACTION_TYPE',
        'CustomerPayBillOnline',
      ),
      Amount: p.amount,
      PartyA: p.phone,
      PartyB: this.config.get('MPESA_PARTY_B') || shortcode,
      PhoneNumber: p.phone,
      CallBackURL: p.callbackUrl,
      AccountReference: 'POS',
      TransactionDesc: 'Payment',
    });
  }

  stkQuery(checkoutRequestId: string) {
    const ts = this.timestamp();
    return this.post<StkQueryResponse>('/mpesa/stkpushquery/v1/query', {
      BusinessShortCode: this.config.getOrThrow<string>('MPESA_SHORTCODE'),
      Password: this.password(ts),
      Timestamp: ts,
      CheckoutRequestID: checkoutRequestId,
    });
  }
}
