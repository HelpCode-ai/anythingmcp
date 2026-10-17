import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsObject,
  IsInt,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class RunScriptDto {
  @IsString()
  @MinLength(1)
  @MaxLength(32768)
  code: string;

  @IsObject()
  input: Record<string, unknown>;

  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  allowedTools: string[];
}

export class SaveScriptDto extends RunScriptDto {
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(1)
  @MaxLength(120)
  @Matches(/\S/, { message: 'name must contain a non-whitespace character' })
  name: string;

  @IsString()
  @MaxLength(2000)
  description: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  mcpServerId: string;
}

export class UpdateScriptDto extends SaveScriptDto {
  @IsInt()
  @Min(1)
  revision: number;
}

export class RunSavedScriptDto {
  @IsObject()
  input: Record<string, unknown>;

  // The version the user reviewed. A changed script must be re-opened before
  // running it rather than silently executing a collaborator's new source.
  @IsInt()
  @Min(1)
  revision: number;
}
