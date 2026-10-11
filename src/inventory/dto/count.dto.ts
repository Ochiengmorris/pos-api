import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CountDto {
  @IsString()
  productId: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  countedQty: number;

  @IsOptional()
  @IsString()
  reason?: string;
}
