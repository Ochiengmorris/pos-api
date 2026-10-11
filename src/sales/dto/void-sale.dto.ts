import { IsString, MinLength } from 'class-validator';

export class VoidSaleDto {
  @IsString()
  @MinLength(3)
  reason: string;
}
