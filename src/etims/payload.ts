// src/etims/payload.ts: building and validating the invoice body. Pure functions, easy to test.
import { PaymentMethod, Prisma, TaxTypeCode } from '@prisma/client';
import type { SalesItemPayload, SalesPayload } from './etims.types';

export const TAX_CODES: TaxTypeCode[] = ['A', 'B', 'C', 'D', 'E'];
const PIN = /^[AP]\d{9}[A-Z]$/;
const D = (v: Prisma.Decimal | number | string) => new Prisma.Decimal(v);
const cut = (s: string | null | undefined, n: number) =>
  s ? s.slice(0, n) : null;

// KRA wants yyyyMMddHHmmss. Nairobi is UTC+3 with no daylight saving.
export const eatStamp = (d: Date) =>
  new Date(d.getTime() + 3 * 3600_000)
    .toISOString()
    .replace(/\D/g, '')
    .slice(0, 14);

// item code format from KRA's specification: country + product type + packaging unit + quantity unit + 7-digit counter
export const etimsItemCode = (p: {
  etimsSeq: number;
  pkgUnitCd: string;
  qtyUnitCd: string;
}) => `KE2${p.pkgUnitCd}${p.qtyUnitCd}${String(p.etimsSeq).padStart(7, '0')}`; // 2 = finished product

export function paymentTypeCode(methods: PaymentMethod[]): string {
  const set = new Set(methods);
  if (set.size === 1) {
    const m = [...set][0];
    return m === 'CASH' ? '01' : m === 'CARD' ? '05' : '06'; // 06 = mobile money
  }
  return '07'; // mixed payment: "other". Confirm the right code for split tender with KRA.
}

export type BuildSaleInput = {
  tin: string;
  bhfId: string;
  basis: 'inclusive' | 'exclusive';
  internalNo: string;
  createdAt: Date;
  cashier: { id: string; name: string };
  store: { name: string; address: string };
  methods: PaymentMethod[];
  customer: { pin?: string | null; name?: string | null };
  rates: Map<TaxTypeCode, Prisma.Decimal>;
  lines: {
    name: string;
    quantity: number;
    unitPrice: Prisma.Decimal;
    lineTotal: Prisma.Decimal; // VAT-inclusive
    taxAmount: Prisma.Decimal; // VAT contained in lineTotal
    taxTyCd: TaxTypeCode;
    itemCd: string;
    itemClsCd: string | null;
    barcode: string | null;
    pkgUnitCd: string;
    qtyUnitCd: string;
  }[];
};

export function buildSalePayload(i: BuildSaleInput): SalesPayload {
  const stamp = eatStamp(i.createdAt);
  const taxbl = Object.fromEntries(TAX_CODES.map((c) => [c, D(0)])) as Record<
    TaxTypeCode,
    Prisma.Decimal
  >;
  const tax = Object.fromEntries(TAX_CODES.map((c) => [c, D(0)])) as Record<
    TaxTypeCode,
    Prisma.Decimal
  >;

  const itemList: SalesItemPayload[] = i.lines.map((l, n) => {
    // prices here are VAT-inclusive: KRA's own sample shows taxblAmt equal to totAmt with the VAT contained in it
    const blAmt =
      i.basis === 'inclusive' ? l.lineTotal : l.lineTotal.sub(l.taxAmount);
    taxbl[l.taxTyCd] = taxbl[l.taxTyCd].add(blAmt);
    tax[l.taxTyCd] = tax[l.taxTyCd].add(l.taxAmount);
    return {
      itemSeq: n + 1,
      itemClsCd: l.itemClsCd,
      itemCd: l.itemCd,
      itemNm: l.name.slice(0, 200),
      bcd: cut(l.barcode, 20),
      pkgUnitCd: l.pkgUnitCd,
      pkg: l.quantity,
      qtyUnitCd: l.qtyUnitCd,
      qty: l.quantity,
      prc: l.unitPrice.toNumber(),
      splyAmt: l.unitPrice.mul(l.quantity).toDecimalPlaces(2).toNumber(),
      dcRt: 0,
      dcAmt: 0,
      isrccCd: null,
      isrccNm: null,
      isrcRt: null,
      isrcAmt: null,
      taxTyCd: l.taxTyCd,
      taxblAmt: blAmt.toNumber(),
      taxAmt: l.taxAmount.toNumber(),
      totAmt: l.lineTotal.toNumber(),
    };
  });

  const sum = (r: Record<TaxTypeCode, Prisma.Decimal>) =>
    TAX_CODES.reduce((s, c) => s.add(r[c]), D(0));
  const totAmt = i.lines.reduce((s, l) => s.add(l.lineTotal), D(0));

  const buckets: Record<string, number> = {};
  for (const c of TAX_CODES) {
    buckets[`taxblAmt${c}`] = taxbl[c].toNumber();
    buckets[`taxRt${c}`] = (i.rates.get(c) ?? D(0)).toNumber();
    buckets[`taxAmt${c}`] = tax[c].toNumber();
  }

  return {
    ...(buckets as any),
    tin: i.tin,
    bhfId: i.bhfId,
    trdInvcNo: i.internalNo,
    invcNo: null,
    orgInvcNo: 0,
    custTin: i.customer.pin ?? null,
    custNm: cut(i.customer.name, 60),
    salesTyCd: 'N',
    rcptTyCd: 'S',
    pmtTyCd: paymentTypeCode(i.methods),
    salesSttsCd: '02', // approved
    cfmDt: stamp,
    salesDt: stamp.slice(0, 8),
    stockRlsDt: stamp,
    cnclReqDt: null,
    cnclDt: null,
    rfdDt: null,
    rfdRsnCd: null,
    totItemCnt: itemList.length,
    totTaxblAmt: sum(taxbl).toNumber(),
    totTaxAmt: sum(tax).toNumber(),
    totAmt: totAmt.toNumber(),
    prchrAcptcYn: 'N',
    remark: null,
    regrId: i.cashier.id.slice(0, 20),
    regrNm: i.cashier.name.slice(0, 60),
    modrId: i.cashier.id.slice(0, 20),
    modrNm: i.cashier.name.slice(0, 60),
    receipt: {
      custTin: i.customer.pin ?? null,
      custMblNo: null,
      rcptPbctDt: stamp,
      trdeNm: cut(i.store.name, 20), // KRA allows 20 characters here
      adrs: cut(i.store.address, 200),
      topMsg: null,
      btmMsg: null,
      prchrAcptcYn: 'N',
    },
    itemList,
  };
}

// A credit note reverses a previously accepted invoice (KRA invoices cannot be deleted)
export function buildCreditNotePayload(
  original: SalesPayload,
  originalInvcNo: number,
  internalNo: string,
  now: Date,
): SalesPayload {
  const stamp = eatStamp(now);
  return {
    ...original,
    trdInvcNo: internalNo,
    invcNo: null,
    orgInvcNo: originalInvcNo,
    rcptTyCd: 'R',
    salesSttsCd: '05', // credit note generated
    rfdDt: stamp,
    rfdRsnCd: '06', // refund
    cfmDt: stamp,
    receipt: { ...original.receipt, rcptPbctDt: stamp },
  };
}

// The checks KRA would make, run locally first so a bad invoice never leaves the building
export function validateSalesPayload(
  p: SalesPayload,
  basis: 'inclusive' | 'exclusive',
): string[] {
  const errs: string[] = [];
  const need = (ok: boolean, msg: string) => {
    if (!ok) errs.push(msg);
  };

  need(PIN.test(p.tin ?? ''), 'tin is not a valid KRA PIN');
  need(/^\d{2}$/.test(p.bhfId ?? ''), 'bhfId must be 2 digits');
  need(
    !!p.trdInvcNo && p.trdInvcNo.length <= 50,
    'trdInvcNo is required (max 50 characters)',
  );
  need(
    Number.isInteger(p.invcNo) && (p.invcNo as number) > 0,
    'invcNo must be a positive whole number',
  );
  need(p.rcptTyCd === 'S' || p.rcptTyCd === 'R', 'rcptTyCd must be S or R');
  need(
    p.rcptTyCd === 'R' ? p.orgInvcNo > 0 : p.orgInvcNo === 0,
    'orgInvcNo is required for credit notes and must be 0 for sales',
  );
  need(
    ['C', 'N', 'P', 'T'].includes(p.salesTyCd),
    'salesTyCd is not a valid transaction type',
  );
  need(
    ['01', '02', '03', '04', '05', '06', '07'].includes(p.pmtTyCd),
    'pmtTyCd is not a valid payment type',
  );
  need(
    ['01', '02', '03', '04', '05', '06'].includes(p.salesSttsCd),
    'salesSttsCd is not valid',
  );
  need(
    /^\d{14}$/.test(p.cfmDt ?? '') && /^\d{8}$/.test(p.salesDt ?? ''),
    'cfmDt/salesDt have the wrong format',
  );
  need(
    p.custTin === null || PIN.test(p.custTin),
    'custTin is not a valid KRA PIN',
  );
  need(
    p.itemList.length > 0 && p.totItemCnt === p.itemList.length,
    'totItemCnt must equal the number of items',
  );

  const bl = Object.fromEntries(TAX_CODES.map((c) => [c, D(0)])) as Record<
    TaxTypeCode,
    Prisma.Decimal
  >;
  const tx = Object.fromEntries(TAX_CODES.map((c) => [c, D(0)])) as Record<
    TaxTypeCode,
    Prisma.Decimal
  >;
  let tot = D(0);

  p.itemList.forEach((it, idx) => {
    const n = idx + 1;
    need(TAX_CODES.includes(it.taxTyCd), `item ${n}: unknown taxTyCd`);
    need(
      it.qty > 0 && it.prc >= 0,
      `item ${n}: quantity and price must be positive`,
    );
    const t = D(it.totAmt);
    const b = D(it.taxblAmt);
    const x = D(it.taxAmt);
    need(x.gte(0) && x.lte(t), `item ${n}: tax amount is out of range`);
    need(
      basis === 'inclusive' ? b.eq(t) : b.add(x).eq(t),
      `item ${n}: taxblAmt, taxAmt and totAmt do not reconcile`,
    );
    need(
      D(it.prc).mul(it.qty).toDecimalPlaces(2).eq(D(it.splyAmt)),
      `item ${n}: splyAmt is not price x quantity`,
    );
    if (TAX_CODES.includes(it.taxTyCd)) {
      bl[it.taxTyCd] = bl[it.taxTyCd].add(b);
      tx[it.taxTyCd] = tx[it.taxTyCd].add(x);
    }
    tot = tot.add(t);
  });

  for (const c of TAX_CODES) {
    need(
      D((p as any)[`taxblAmt${c}`]).eq(bl[c]),
      `taxblAmt${c} does not match the item lines`,
    );
    need(
      D((p as any)[`taxAmt${c}`]).eq(tx[c]),
      `taxAmt${c} does not match the item lines`,
    );
  }
  need(D(p.totAmt).eq(tot), 'totAmt does not match the item lines');
  need(
    D(p.totTaxAmt).eq(TAX_CODES.reduce((s, c) => s.add(tx[c]), D(0))),
    'totTaxAmt does not match the item lines',
  );
  need(
    D(p.totTaxblAmt).eq(TAX_CODES.reduce((s, c) => s.add(bl[c]), D(0))),
    'totTaxblAmt does not match the item lines',
  );
  return errs;
}
