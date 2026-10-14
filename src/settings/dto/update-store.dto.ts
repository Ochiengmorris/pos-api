import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateStoreDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  taxPin?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  receiptFooter?: string;
}
