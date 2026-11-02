import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class CreateCountDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsString() categoryId?: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class EntryDto {
  @IsString() productId: string;
  @Type(() => Number) @IsInt() @Min(0) @Max(1_000_000) countedQty: number;
}

export class SaveEntriesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => EntryDto)
  entries: EntryDto[];
}

export class LinesQueryDto {
  @IsOptional()
  @IsIn(['counted', 'differences', 'uncounted'])
  filter: 'counted' | 'differences' | 'uncounted' = 'counted';
  @IsOptional() @IsString() @MaxLength(60) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number =
    20;
}

export class FindQueryDto {
  @IsString() @MinLength(1) @MaxLength(60) q: string;
}

export class ApplyCountDto {
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}
