import { Type } from 'class-transformer';
import { IsInt, IsString, Max, Min, MinLength } from 'class-validator';

export class InitiateStkDto {
  @IsString()
  @MinLength(9)
  phone: string;

  // STK push only takes whole shillings. If the bill has cents, take those in cash.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(250000)
  amount: number;
}
