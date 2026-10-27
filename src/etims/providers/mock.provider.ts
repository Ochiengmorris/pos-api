import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { EtimsConfig } from '../etims.config';
import { eatStamp, validateSalesPayload } from '../payload';
import type {
  ETimsProvider,
  KraAcceptedData,
  SalesPayload,
  SubmitResult,
} from '../etims.types';

export const MOCK_MODES = [
  'ok',
  'down',
  'timeout',
  'reject',
  'flaky',
  'lost_response',
  'lost_response_strict',
] as const;
export type MockMode = (typeof MOCK_MODES)[number];

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const fake = (n: number) =>
  Array.from(randomBytes(n), (b) => B32[b % 32]).join('');

/**
 * A stand-in for KRA, for development only. It behaves like the OSCU API in the official
 * specification (same request and response shapes, duplicate detection with code 994, 000 on
 * success), but NOTHING IS FILED WITH KRA. Everything it returns is visibly fake.
 */
@Injectable()
export class MockEtimsProvider implements ETimsProvider {
  readonly kind = 'mock' as const;
  readonly environment = 'MOCK' as const;

  private override: MockMode | null = null;
  private readonly seen = new Map<string, KraAcceptedData>(); // what the "server" accepted
  private receiptCounter = 0;

  constructor(private readonly cfg: EtimsConfig) {}

  get mode(): MockMode {
    const m = this.override ?? (this.cfg.mockMode as MockMode);
    return MOCK_MODES.includes(m) ? m : 'ok';
  }
  setMode(m: MockMode | null) {
    this.override = m;
  }
  reset() {
    this.seen.clear();
    this.receiptCounter = 0;
  }

  validateInvoicePayload(payload: SalesPayload) {
    return validateSalesPayload(payload, this.cfg.taxableBasis);
  }

  async submitInvoice(p: SalesPayload): Promise<SubmitResult> {
    switch (this.mode) {
      case 'down':
        return {
          outcome: 'RETRYABLE',
          message: 'Mock KRA is unreachable (simulated).',
        };
      case 'timeout':
        return {
          outcome: 'UNCERTAIN',
          message: 'Mock KRA timed out; the outcome is unknown (simulated).',
        };
      case 'reject':
        return {
          outcome: 'REJECTED',
          code: '910',
          message: 'Mock KRA: request parameter error (simulated).',
        };
      case 'flaky':
        return Math.random() < 0.5
          ? {
              outcome: 'RETRYABLE',
              message: 'Mock KRA failed this attempt (simulated).',
            }
          : this.accept(p);
      case 'lost_response':
      case 'lost_response_strict': {
        this.accept(p); // KRA records it...
        return {
          outcome: 'UNCERTAIN',
          message: 'Mock KRA accepted it but the reply was lost (simulated).',
        };
      }
      default:
        return this.accept(p);
    }
  }

  async reconcileInvoice(p: SalesPayload): Promise<SubmitResult> {
    const known = this.seen.get(this.key(p));
    if (this.mode === 'lost_response_strict') {
      // the worst case: a duplicate is refused and the original signature is not returned
      return {
        outcome: 'UNCERTAIN',
        code: '994',
        message:
          'Mock KRA: overlapped data. Could not retrieve the original signature (simulated).',
      };
    }
    if (known) return { outcome: 'ACCEPTED', data: known };
    return this.submitInvoice(p);
  }

  buildQrPayload(ctx: { tin: string; bhfId: string; data: KraAcceptedData }) {
    // deliberately NOT a URL and NOT KRA's format, so it can never be mistaken for a real verification code
    return `MOCK-NOT-A-KRA-FILING|${ctx.tin}|${ctx.bhfId}|${ctx.data.rcptSign}`;
  }

  private key(p: SalesPayload) {
    return `${p.tin}|${p.bhfId}|${p.invcNo}`;
  }

  private accept(p: SalesPayload): SubmitResult {
    if (this.seen.has(this.key(p))) {
      return {
        outcome: 'REJECTED',
        code: '994',
        message: 'Mock KRA: overlapped data (duplicate invoice number).',
      };
    }
    const n = ++this.receiptCounter;
    const data: KraAcceptedData = {
      curRcptNo: n,
      totRcptNo: n,
      intrlData: `MOCK${fake(22)}`, // KRA's field is 26 characters
      rcptSign: `MOCK${fake(12)}`, // KRA's field is 16 characters
      sdcDateTime: eatStamp(new Date()),
      sdcId: 'MOCK-SDC-0001',
      mrcNo: 'MOCKMRC0001',
    };
    this.seen.set(this.key(p), data);
    return { outcome: 'ACCEPTED', data };
  }
}
