import { PaymentMethod } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class SaleItemDto {
  @IsString()
  productId: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity: number;
}

export class SalePaymentDto {
  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  // The part of the bill this method covers. All amounts must add up to the total.
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount: number;

  // Cash only: what the customer handed over (>= amount). Change is computed.
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  tendered?: number;

  @IsOptional()
  @IsString()
  mpesaPaymentId?: string;

  // M-Pesa receipt code or card reference. Required for non-cash.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  reference?: string;
}

export class CreateSaleDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => SaleItemDto)
  items: SaleItemDto[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => SalePaymentDto)
  payments: SalePaymentDto[];

  @IsOptional()
  @IsString()
  customerId?: string;

  // Generate a UUID per checkout attempt on the client; reuse it on retries
  @IsOptional()
  @IsString()
  @MaxLength(64)
  clientRequestId?: string;

  // a business customer's KRA PIN, so they can claim the purchase
  @IsOptional()
  @Matches(/^[AP]\d{9}[A-Z]$/, {
    message: 'customerPin must be a valid KRA PIN',
  })
  customerPin?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  customerName?: string;
}
