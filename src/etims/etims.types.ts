import type { TaxTypeCode } from '@prisma/client';

type Buckets<P extends string> = { [K in TaxTypeCode as `${P}${K}`]: number };

export interface SalesItemPayload {
  itemSeq: number;
  itemClsCd: string | null;
  itemCd: string;
  itemNm: string;
  bcd: string | null;
  pkgUnitCd: string;
  pkg: number;
  qtyUnitCd: string;
  qty: number;
  prc: number;
  splyAmt: number;
  dcRt: number;
  dcAmt: number;
  isrccCd: null;
  isrccNm: null;
  isrcRt: null;
  isrcAmt: null;
  taxTyCd: TaxTypeCode;
  taxblAmt: number;
  taxAmt: number;
  totAmt: number;
}

// the saveTrnsSalesOsdc request body (field names from KRA's OSCU specification v2.0), without credentials
export type SalesPayload = Buckets<'taxblAmt'> &
  Buckets<'taxRt'> &
  Buckets<'taxAmt'> & {
    tin: string;
    bhfId: string;
    trdInvcNo: string;
    invcNo: number | null; // assigned when the invoice is first transmitted
    orgInvcNo: number;
    custTin: string | null;
    custNm: string | null;
    salesTyCd: string;
    rcptTyCd: 'S' | 'R';
    pmtTyCd: string;
    salesSttsCd: string;
    cfmDt: string;
    salesDt: string;
    stockRlsDt: string | null;
    cnclReqDt: null;
    cnclDt: null;
    rfdDt: string | null;
    rfdRsnCd: string | null;
    totItemCnt: number;
    totTaxblAmt: number;
    totTaxAmt: number;
    totAmt: number;
    prchrAcptcYn: 'N';
    remark: string | null;
    regrId: string;
    regrNm: string;
    modrId: string;
    modrNm: string;
    receipt: {
      custTin: string | null;
      custMblNo: string | null;
      rcptPbctDt: string;
      trdeNm: string | null;
      adrs: string | null;
      topMsg: string | null;
      btmMsg: string | null;
      prchrAcptcYn: 'N';
    };
    itemList: SalesItemPayload[];
  };

export type KraAcceptedData = {
  curRcptNo: number;
  totRcptNo: number;
  intrlData: string;
  rcptSign: string;
  sdcDateTime: string;
  sdcId?: string;
  mrcNo?: string;
};

// The four things that can happen when we talk to KRA. They are handled very differently.
export type SubmitResult =
  | { outcome: 'ACCEPTED'; data: KraAcceptedData }
  | { outcome: 'REJECTED'; code: string; message: string } // KRA answered "no": resending unchanged will not help
  | { outcome: 'RETRYABLE'; message: string; code?: string } // definitely not processed (e.g. could not connect)
  | { outcome: 'UNCERTAIN'; message: string; code?: string }; // the request may have been processed (timeout, lost reply)

export interface ETimsProvider {
  readonly kind: 'mock' | 'oscu';
  readonly environment: 'MOCK' | 'SANDBOX' | 'PRODUCTION';
  validateInvoicePayload(payload: SalesPayload): string[];
  submitInvoice(payload: SalesPayload): Promise<SubmitResult>;
  // After an UNCERTAIN outcome: find out what happened without creating a duplicate.
  // (KRA's OSCU specification has no "get sales invoice" call, so this is provider-specific.)
  reconcileInvoice(payload: SalesPayload): Promise<SubmitResult>;
  buildQrPayload(ctx: {
    tin: string;
    bhfId: string;
    data: KraAcceptedData;
  }): string | null;
}

export const ETIMS_PROVIDER = Symbol('ETIMS_PROVIDER');
