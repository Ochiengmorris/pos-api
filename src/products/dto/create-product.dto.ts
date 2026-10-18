import { TaxTypeCode } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';

export class CreateProductDto {
  @IsString()
  @MinLength(1)
  sku: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  barcode?: string;

  @IsString()
  @MinLength(2)
  name: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  costPrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  taxRate?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  reorderLevel?: number;

  // Opening stock: recorded as a PURCHASE movement
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  initialStock?: number;

  @IsEnum(TaxTypeCode)
  taxTyCd?: TaxTypeCode;
}
