import { normalizeKenyanPhone } from './phone.util';

describe('normalizeKenyanPhone', () => {
  it.each([
    ['0712345678', '254712345678'],
    ['0112345678', '254112345678'],
    ['+254 712 345 678', '254712345678'],
    ['254712345678', '254712345678'],
    ['712345678', '254712345678'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeKenyanPhone(input)).toBe(expected);
  });

  it.each(['12345', '0612345678', '25471234567', 'abc'])(
    'rejects %s',
    (input) => {
      expect(() => normalizeKenyanPhone(input)).toThrow();
    },
  );
});
