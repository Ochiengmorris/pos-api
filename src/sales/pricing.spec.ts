import { priceLine } from './pricing';

describe('priceLine (VAT-inclusive prices)', () => {
  it('extracts 16% VAT from a 210.00 line', () => {
    const r = priceLine('70', '16', 3);
    expect(r.lineTotal.toFixed(2)).toBe('210.00');
    expect(r.taxAmount.toFixed(2)).toBe('28.97');
    expect(r.net.toFixed(2)).toBe('181.03');
  });

  it('charges no VAT at 0%', () => {
    const r = priceLine('65', '0', 2);
    expect(r.taxAmount.toFixed(2)).toBe('0.00');
    expect(r.net.toFixed(2)).toBe('130.00');
  });

  it('rounds half-up to 2 decimals', () => {
    // 10.05 * 16 / 116 = 1.3862... -> 1.39
    expect(priceLine('10.05', '16', 1).taxAmount.toFixed(2)).toBe('1.39');
  });

  it('net + tax always equals the line total', () => {
    for (const price of ['0.99', '12.34', '199.95', '1234.56']) {
      for (const qty of [1, 3, 7]) {
        const r = priceLine(price, '16', qty);
        expect(r.net.add(r.taxAmount).toFixed(2)).toBe(r.lineTotal.toFixed(2));
      }
    }
  });
});
