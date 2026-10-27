import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

const toBool =
  (fallback: boolean) =>
  ({ value }: { value: unknown }) =>
    value === undefined ? fallback : value === 'true' || value === true;

export class ImportQueryDto {
  // a preview unless you explicitly ask for the real thing
  @IsOptional()
  @Transform(toBool(true))
  @IsBoolean()
  dryRun: boolean = true;

  @IsOptional()
  @Transform(toBool(false))
  @IsBoolean()
  updateExisting: boolean = false;

  @IsOptional()
  @Transform(toBool(false))
  @IsBoolean()
  skipInvalid: boolean = false;
}
