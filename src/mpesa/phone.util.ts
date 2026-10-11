import { BadRequestException } from '@nestjs/common';

// 0712345678, 0112345678, +254712345678, 254712345678 -> 254712345678
export function normalizeKenyanPhone(input: string): string {
  const digits = input.replace(/\D/g, '');
  let msisdn = digits;
  if (/^0[17]\d{8}$/.test(digits)) msisdn = '254' + digits.slice(1);
  else if (/^[17]\d{8}$/.test(digits)) msisdn = '254' + digits;

  if (!/^254[17]\d{8}$/.test(msisdn)) {
    throw new BadRequestException('Enter a valid Kenyan phone number');
  }
  return msisdn;
}
