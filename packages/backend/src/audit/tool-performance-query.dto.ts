import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ANALYTICS_MAX_DAYS } from './analytics-query.dto';

export const TOOL_PERFORMANCE_DEFAULT_HOURS = 24;
export const TOOL_PERFORMANCE_MAX_HOURS = ANALYTICS_MAX_DAYS * 24;
export const TOOL_PERFORMANCE_DEFAULT_LIMIT = 25;

export class ToolPerformanceQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(TOOL_PERFORMANCE_MAX_HOURS)
  hours?: number;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  connectorId?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  mcpServerId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  offset?: number;
}
