import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class WaitingQueryDto {
  /** The sale total. Only payments of exactly this amount are offered as matches. */
  @IsOptional()
  @Matches(/^\d+(\.\d{1,2})?$/, {
    message: 'amount must be a number such as 390 or 390.50',
  })
  amount?: string;

  /** The end of the M-Pesa code the customer reads from their SMS, e.g. "XYZ123". */
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(12)
  code?: string;
}

export class ReserveDto {
  /** Required only when C2B_REQUIRE_CODE_ENTRY=true. */
  @IsOptional()
  @IsString()
  @MaxLength(8)
  codeLast4?: string;
}

export class ListQueryDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must look like 2026-11-07' })
  date!: string;

  @IsOptional()
  @IsIn(['UNCLAIMED', 'CLAIMED', 'MATCHED_STK', 'IGNORED'])
  status?: 'UNCLAIMED' | 'CLAIMED' | 'MATCHED_STK' | 'IGNORED';
}

export class IgnoreDto {
  @IsString()
  @MinLength(5, { message: 'Give a reason of at least 5 characters' })
  @MaxLength(200)
  reason!: string;
}
