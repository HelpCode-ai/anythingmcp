import { Prisma } from '../generated/prisma/client';
import { ToolPerformanceQueryDto } from './tool-performance-query.dto';

export interface ToolPerformanceRow {
  tool_id: string;
  tool_name: string;
  connector_id: string;
  connector_name: string;
  mcp_server_id: string | null;
  mcp_server_name: string | null;
  calls: bigint;
  errors: bigint;
  latency_sample_count: bigint;
  latency: number[] | null;
  last_error: string | null;
  last_error_at: Date | null;
}

/**
 * Page groups before looking up their latest errors, avoiding an array of every error in the window.
 *
 * `onlyUserId` (restricted member visibility) keeps only that user's calls, in
 * the groups and in the latest-error lookup, so another member's error text
 * never shows. It also names only the MCP servers that user owns: a call made
 * through another member's server is grouped with the calls made without a
 * server (`mcp_server_id` and `mcp_server_name` null), and filtering by such a
 * server matches nothing. It is a bound value; without it the query is the
 * workspace-wide one.
 */
export function toolPerformanceQuery(
  organizationId: string,
  since: Date,
  until: Date,
  options: ToolPerformanceQueryDto,
  limit: number,
  onlyUserId?: string,
): Prisma.Sql {
  const connectorFilter = options.connectorId
    ? Prisma.sql`AND c.id = ${options.connectorId}`
    : Prisma.empty;
  const restricted = onlyUserId !== undefined;
  const serverFilter = options.mcpServerId
    ? restricted
      ? Prisma.sql`AND ti.mcp_server_id = ${options.mcpServerId} AND s.user_id = ${onlyUserId}`
      : Prisma.sql`AND ti.mcp_server_id = ${options.mcpServerId}`
    : Prisma.empty;
  const userFilter = restricted ? Prisma.sql`AND ti.user_id = ${onlyUserId}` : Prisma.empty;
  // The server as reported: restricted, only one the caller owns.
  const serverId = restricted
    ? Prisma.sql`CASE WHEN s.user_id = ${onlyUserId} THEN ti.mcp_server_id END`
    : Prisma.sql`ti.mcp_server_id`;
  const serverName = restricted
    ? Prisma.sql`CASE WHEN s.user_id = ${onlyUserId} THEN s.name END`
    : Prisma.sql`s.name`;
  // The same expression in the latest-error lookup, over its own join.
  const latestServerJoin = restricted
    ? Prisma.sql`LEFT JOIN mcp_server_configs ls ON ls.id = ti.mcp_server_id`
    : Prisma.empty;
  const latestServerId = restricted
    ? Prisma.sql`CASE WHEN ls.user_id = ${onlyUserId} THEN ti.mcp_server_id END`
    : Prisma.sql`ti.mcp_server_id`;

  return Prisma.sql`
    WITH page AS (
      SELECT
        t.id AS tool_id,
        t.name AS tool_name,
        c.id AS connector_id,
        c.name AS connector_name,
        ${serverId} AS mcp_server_id,
        ${serverName} AS mcp_server_name,
        SUM(ti.repeat_count)::bigint AS calls,
        COALESCE(SUM(ti.repeat_count) FILTER (WHERE ti.status IN ('ERROR', 'TIMEOUT')), 0)::bigint AS errors,
        COUNT(ti.duration_ms)::bigint AS latency_sample_count,
        percentile_cont(ARRAY[0.5, 0.95, 0.99])
          WITHIN GROUP (ORDER BY ti.duration_ms) AS latency
      FROM tool_invocations ti
      JOIN mcp_tools t ON t.id = ti.tool_id
      JOIN connectors c ON c.id = t.connector_id
      LEFT JOIN mcp_server_configs s
        ON s.id = ti.mcp_server_id AND s.organization_id = ${organizationId}
      WHERE c.organization_id = ${organizationId}
        AND (ti.mcp_server_id IS NULL OR s.id IS NOT NULL)
        AND ti.created_at >= (${since.toISOString()}::timestamptz AT TIME ZONE 'UTC')
        AND ti.created_at < (${until.toISOString()}::timestamptz AT TIME ZONE 'UTC')
        ${connectorFilter}
        ${serverFilter}
        ${userFilter}
      -- By position: the server columns are expressions with bound values,
      -- which Postgres would not match to a repeated expression.
      GROUP BY 1, 2, 3, 4, 5, 6
      ORDER BY calls DESC, c.id, t.id, mcp_server_id NULLS FIRST
      LIMIT ${limit + 1} OFFSET ${options.offset ?? 0}
    )
    SELECT page.*, latest.last_error, latest.last_error_at
    FROM page
    LEFT JOIN LATERAL (
      SELECT
        ti.error AS last_error,
        ti.created_at AT TIME ZONE 'UTC' AS last_error_at
      FROM tool_invocations ti
      ${latestServerJoin}
      WHERE ti.tool_id = page.tool_id
        AND ${latestServerId} IS NOT DISTINCT FROM page.mcp_server_id
        AND ti.status IN ('ERROR', 'TIMEOUT')
        AND ti.error IS NOT NULL AND ti.error <> ''
        AND ti.created_at >= (${since.toISOString()}::timestamptz AT TIME ZONE 'UTC')
        AND ti.created_at < (${until.toISOString()}::timestamptz AT TIME ZONE 'UTC')
        ${userFilter}
      ORDER BY ti.created_at DESC, ti.id DESC
      LIMIT 1
    ) latest ON true
    ORDER BY page.calls DESC, page.connector_id, page.tool_id, page.mcp_server_id NULLS FIRST
  `;
}
