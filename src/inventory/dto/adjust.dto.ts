import { Type } from 'class-transformer';
import { IsInt, IsString, MinLength } from 'class-validator';

export class AdjustDto {
  @IsString()
  productId: string;

  // Signed change: -3 for damaged goods, +2 for found stock
  @Type(() => Number)
  @IsInt()
  quantity: number;

  @IsString()
  @MinLength(3)
  reason: string;
}
