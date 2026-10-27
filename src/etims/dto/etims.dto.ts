import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class ListInvoicesDto {
  @IsOptional()
  @IsIn([
    'ATTENTION',
    'PENDING',
    'ACCEPTED',
    'REJECTED',
    'FAILED',
    'UNCERTAIN',
    'CANCELLED',
  ])
  status?:
    | 'ATTENTION'
    | 'PENDING'
    | 'ACCEPTED'
    | 'REJECTED'
    | 'FAILED'
    | 'UNCERTAIN'
    | 'CANCELLED';

  @IsOptional()
  @IsIn(['SALE', 'CREDIT_NOTE'])
  type?: 'SALE' | 'CREDIT_NOTE';

  @IsOptional() @IsString() @MaxLength(60) search?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number =
    20;
}

export class RetryDto {
  @IsOptional()
  @IsBoolean()
  rebuild?: boolean; // refresh catalogue fields from the product before resending (rejected invoices only)
}

export class ResolveInvoiceDto {
  @IsIn(['CONFIRM_FILED', 'CONFIRM_NOT_FILED'])
  action: 'CONFIRM_FILED' | 'CONFIRM_NOT_FILED';

  @IsString()
  @MinLength(5)
  @MaxLength(300)
  note: string; // what was checked, e.g. "Looked up invoice 1042 on the eTIMS portal on 20 Oct"

  // only for CONFIRM_FILED: the values printed on KRA's own record
  @ValidateIf((o) => o.action === 'CONFIRM_FILED')
  @Type(() => Number)
  @IsInt()
  @Min(1)
  scuReceiptNo?: number;
  @ValidateIf((o) => o.action === 'CONFIRM_FILED')
  @Type(() => Number)
  @IsInt()
  @Min(1)
  scuTotalReceiptNo?: number;
  @ValidateIf((o) => o.action === 'CONFIRM_FILED')
  @IsString()
  @Length(8, 16)
  signature?: string;
  @ValidateIf((o) => o.action === 'CONFIRM_FILED')
  @IsString()
  @Length(8, 26)
  internalData?: string;
  @ValidateIf((o) => o.action === 'CONFIRM_FILED')
  @IsString()
  @Length(1, 18)
  sdcId?: string;
  @ValidateIf((o) => o.action === 'CONFIRM_FILED')
  @Matches(/^\d{14}$/, { message: 'sdcDateTime must be yyyyMMddHHmmss' })
  sdcDateTime?: string;
  @IsOptional()
  @IsString()
  @MaxLength(11)
  mrcNo?: string;
}

export class TaxReviewQueryDto {
  @IsOptional() @IsString() @MaxLength(60) search?: string;
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  all?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number =
    20;
}

export class ConfirmTaxDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  productIds: string[];
}

export class UpdateTaxRateDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  rate: number;
}
