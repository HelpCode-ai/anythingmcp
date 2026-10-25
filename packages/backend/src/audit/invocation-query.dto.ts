import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, Min } from 'class-validator';

export const INVOCATION_STATUSES = ['SUCCESS', 'ERROR', 'TIMEOUT'] as const;
export const EXPORT_FORMATS = ['csv', 'json'] as const;
export type AuditExportFormat = (typeof EXPORT_FORMATS)[number];

/** Filters shared by `GET /api/audit/invocations` and its export. */
export class InvocationFilterQueryDto {
  @IsOptional()
  @IsString()
  toolId?: string;

  @IsOptional()
  @IsIn(INVOCATION_STATUSES)
  status?: (typeof INVOCATION_STATUSES)[number];

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  connectorId?: string;

  @IsOptional()
  @IsString()
  mcpServerId?: string;

  /** ISO date or date-time, inclusive. A bare date is midnight UTC. */
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  /** ISO date or date-time, exclusive. A bare date is midnight UTC. */
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
}

export class ListInvocationsQueryDto extends InvocationFilterQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class ExportInvocationsQueryDto extends InvocationFilterQueryDto {
  @IsIn(EXPORT_FORMATS)
  format!: AuditExportFormat;

  /** Include each call's input and output. Query strings only carry text, so map 'true' / 'false'. */
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  payloads?: boolean;
}
