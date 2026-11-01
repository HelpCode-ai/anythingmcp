import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';

/**
 * Request bodies of the File Search API. The nested `config` object is
 * validated field by field in file-search-config.ts (one schema shared with
 * the worker); here only its shape is checked.
 */

export class FileSearchTestDto {
  @IsObject()
  config!: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  secrets?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  connectorId?: string;
}

export class FileSearchDraftDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsObject()
  config!: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  secrets?: Record<string, unknown>;
}

export class FileSearchUpdateSourceDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  secrets?: Record<string, unknown>;
}

export class FileSearchScanDto {
  @IsOptional()
  @IsBoolean()
  useAi?: boolean;
}

export class FileSearchSelectionDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(1024, { each: true })
  excludeFolders!: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  @MaxLength(16, { each: true })
  extensions?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  maxAgeYears?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  scanId?: string;
}

export class FileSearchActivateDto {
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  instructions?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  summary?: string;

  @IsOptional()
  @IsString()
  @MaxLength(31)
  toolPrefix?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  syncIntervalMinutes?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  mcpServerIds?: string[];
}

export class FileSearchDescriptionDto {
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  instructions?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  summary?: string;
}

export class FileSearchScheduleDto {
  @IsInt()
  @Min(1)
  syncIntervalMinutes!: number;
}

export class FileSearchPolicyDto {
  @IsOptional()
  @IsBoolean()
  publicLinks?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxTtlHours?: number | null;

  @IsOptional()
  @IsBoolean()
  aiDrafting?: boolean;

  @IsOptional()
  @IsBoolean()
  allowPlainFtp?: boolean;
}

export class FileAccessRuleDto {
  @IsString()
  @MaxLength(64)
  roleId!: string;

  @IsString()
  @MaxLength(512)
  pattern!: string;

  @IsIn(['allow', 'deny'])
  effect!: 'allow' | 'deny';
}

export class FileAccessRulesDto {
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => FileAccessRuleDto)
  rules!: FileAccessRuleDto[];
}

export class FileShareUploadDto {
  @IsString()
  @MaxLength(200)
  filename!: string;

  @IsOptional()
  @IsString()
  @MaxLength(15_000_000)
  content?: string;

  @IsOptional()
  @IsString()
  @MaxLength(70_000_000)
  contentBase64?: string;

  @IsOptional()
  @IsIn(['internal', 'public'])
  access?: 'internal' | 'public';

  @IsOptional()
  @IsInt()
  @Min(1)
  ttlHours?: number;
}
