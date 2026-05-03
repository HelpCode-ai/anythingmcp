import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Shared query DTO for offset-based pagination on list endpoints.
 *
 *  - limit:  optional, 1..200, default applied by the caller (typically 50)
 *  - offset: optional, >= 0, default 0
 *
 * The route handler decides whether absent params mean "return everything"
 * (back-compat for callers that never asked for pagination) or "apply the
 * default page size". This DTO doesn't impose either policy.
 */
export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
