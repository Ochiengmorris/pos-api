import { Prisma } from '@prisma/client';

type Num = Prisma.Decimal | string | number;
const D = (v: Num) => new Prisma.Decimal(v);
export const round2 = (d: Prisma.Decimal) =>
  d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

// Shelf prices are VAT-inclusive: VAT is extracted from the price, not added on top
export function priceLine(unitPrice: Num, taxRate: Num, quantity: number) {
  const lineTotal = round2(D(unitPrice).mul(quantity));
  const taxAmount = round2(
    lineTotal.mul(D(taxRate)).div(D(100).add(D(taxRate))),
  );
  return { lineTotal, taxAmount, net: lineTotal.sub(taxAmount) };
}
