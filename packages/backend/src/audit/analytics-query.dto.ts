import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Longest window `GET /api/audit/analytics` aggregates. The dashboard offers
 * 7, 30 and 90 days; a longer window only makes one request scan more rows.
 */
export const ANALYTICS_MAX_DAYS = 90;
export const ANALYTICS_DEFAULT_DAYS = 7;

export class AnalyticsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ANALYTICS_MAX_DAYS)
  days?: number;
}
