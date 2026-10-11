import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class ReportRangeDto {
  @IsOptional()
  @Matches(DATE, { message: 'from must be YYYY-MM-DD' })
  from?: string;

  @IsOptional()
  @Matches(DATE, { message: 'to must be YYYY-MM-DD' })
  to?: string;
}

export class TrendDto extends ReportRangeDto {
  @IsOptional()
  @IsIn(['hour', 'day', 'week', 'month'])
  interval?: 'hour' | 'day' | 'week' | 'month';
}

export class TopProductsDto extends ReportRangeDto {
  @IsOptional()
  @IsIn(['revenue', 'quantity', 'profit'])
  by: 'revenue' | 'quantity' | 'profit' = 'revenue';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 10;
}

export class ShiftDto {
  @IsOptional()
  @Matches(DATE, { message: 'date must be YYYY-MM-DD' })
  date?: string;

  @IsOptional()
  @IsString()
  cashierId?: string; // managers only; cashiers always get their own
}
