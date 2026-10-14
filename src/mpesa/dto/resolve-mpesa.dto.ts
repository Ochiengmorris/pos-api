import { MpesaResolution } from '@prisma/client';
import { IsEnum, IsString, MinLength } from 'class-validator';

export class ResolveMpesaDto {
  @IsEnum(MpesaResolution)
  resolution: MpesaResolution;

  @IsString()
  @MinLength(3)
  note: string;
}
