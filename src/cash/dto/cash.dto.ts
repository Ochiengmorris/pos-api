import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class OpenShiftDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000)
  openingFloat: number;
}

export class MovementDto {
  @IsIn(['PAID_OUT', 'CASH_DROP', 'CASH_IN'])
  type: 'PAID_OUT' | 'CASH_DROP' | 'CASH_IN';

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(1_000_000)
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class CloseShiftDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10_000_000)
  countedCash: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class AcknowledgeDto {
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  note: string;
}

export class ListShiftsDto {
  @IsOptional() @IsIn(['OPEN', 'CLOSED']) status?: 'OPEN' | 'CLOSED';
  @IsOptional() @IsIn(['needed']) review?: 'needed';
  @IsOptional() @IsString() cashierId?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number =
    20;
}

export class SummaryQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be yyyy-mm-dd' })
  date?: string;
}
