import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Logger,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiSecurity,
  ApiResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtOrManagementKeyGuard } from '../auth/jwt-or-management-key.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { AuditService, InvocationFilters } from './audit.service';
import { AuditExportEncoder } from './audit-export.format';
import {
  ANALYTICS_DEFAULT_DAYS,
  ANALYTICS_MAX_DAYS,
  AnalyticsQueryDto,
} from './analytics-query.dto';
import { ToolPerformanceQueryDto } from './tool-performance-query.dto';
import { MemberVisibilityService } from '../settings/member-visibility.service';
import {
  ExportInvocationsQueryDto,
  InvocationFilterQueryDto,
  INVOCATION_STATUSES,
  ListInvocationsQueryDto,
} from './invocation-query.dto';

/** Write one chunk, waiting for the socket to drain when its buffer is full. */
async function writeChunk(res: Response, chunk: string): Promise<void> {
  if (!chunk || res.destroyed || res.write(chunk)) return;
  // A socket that is already gone has fired 'close' and will never drain.
  if (res.destroyed) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

/**
 * Every read route of this controller is scoped by member visibility: in a
 * workspace set to `restricted`, a member who is not an admin gets only the
 * calls they made themselves (rows without a user are hidden). Admins and open
 * workspaces take the unchanged workspace-wide path. The organisation filter
 * stays in every query; the user filter is added to it with AND, in SQL.
 */

@ApiTags('Audit')
@ApiBearerAuth()
@ApiSecurity('api-key')
@UseGuards(JwtOrManagementKeyGuard)
@Controller('api/audit')
export class AuditController {
  private readonly logger = new Logger(AuditController.name);

  constructor(
    private readonly auditService: AuditService,
    private readonly visibility: MemberVisibilityService,
  ) {}

  /** Query filters as the service takes them; a bare date is midnight UTC. */
  private filters(query: InvocationFilterQueryDto, organizationId?: string): InvocationFilters {
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    if (from && to && from >= to) {
      throw new BadRequestException('from must be before to');
    }
    return {
      organizationId,
      toolId: query.toolId,
      status: query.status,
      search: query.search,
      connectorId: query.connectorId,
      mcpServerId: query.mcpServerId,
      from,
      to,
    };
  }

  @Get('invocations')
  @ApiOperation({
    summary: 'List tool invocation logs',
    description:
      'The audit log of tool calls in your workspace, newest first: tool and connector, caller, MCP server, `input`, ' +
      '`output` or `error`, `status`, `durationMs` and `clientInfo` (how the caller authenticated, which key or client). ' +
      'A failure repeated within a minute is stored once with `repeatCount`. Filters combine with AND.\n\n' +
      'Typical uses: the last failures (`status=ERROR`), the calls of one tool or connector, or what one AI client did ' +
      'on one server (`mcpServerId`).\n\n' +
      '```bash\namcp api GET "/api/audit/invocations?status=ERROR&limit=20"\n```\n\n' +
      'In a workspace with restricted member visibility, a member who is not an admin gets only the calls they made ' +
      'themselves; calls without a user are hidden.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Rows to return (default 100).', example: 20 })
  @ApiQuery({ name: 'offset', required: false, type: Number, description: 'Rows to skip, for paging.', example: 0 })
  @ApiQuery({ name: 'toolId', required: false, type: String, description: 'Only calls of this tool.' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: INVOCATION_STATUSES,
    description: 'Only calls with this outcome.',
    example: 'ERROR',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Tool name contains this text (case-insensitive).',
    example: 'hubspot_',
  })
  @ApiQuery({ name: 'connectorId', required: false, type: String, description: 'Only calls of tools of this connector.' })
  @ApiQuery({ name: 'mcpServerId', required: false, type: String, description: 'Only calls made through this MCP server.' })
  @ApiQuery({ name: 'from', required: false, type: String, description: 'ISO date or date-time, inclusive.', example: '2026-11-01' })
  @ApiQuery({ name: 'to', required: false, type: String, description: 'ISO date or date-time, exclusive.', example: '2026-11-08' })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'array',
      items: { type: 'object' },
      example: [
        {
          id: 'cmod9e8f700f01zrpa1b2c3d4',
          toolId: 'cmob7a1b200d01zrp5h6j7k8l',
          status: 'ERROR',
          durationMs: 742,
          error: 'HTTP 403: missing scope crm.objects.deals.read',
          input: { objectType: 'deals', limit: 10 },
          output: null,
          repeatCount: 1,
          createdAt: '2026-11-05T09:41:12.000Z',
          tool: { name: 'hubspot_list_objects', connectorId: 'cmob60dvv00c01zrpeujwmnep', connector: { name: 'HubSpot', type: 'REST' } },
          user: { id: 'cmo8a7b6c0000abcdx1y2z3w4', email: 'ana@example.com', name: 'Ana' },
          mcpServer: { id: 'cmo9x1k2a0001abcdpq7rs8tu', name: 'Sales', slug: 'sales' },
        },
      ],
    },
  })
  async listInvocations(@Req() req: any, @Query() query: ListInvocationsQueryDto) {
    const filters = this.filters(query, req.user.organizationId);
    const scope = await this.visibility.scopeFor(req.user);
    if (scope.restricted) filters.onlyUserId = scope.userId;
    return this.auditService.getRecentInvocations(
      query.limit ?? 100,
      query.offset ?? 0,
      filters,
    );
  }

  @Get('invocations/export')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Download tool invocation logs as CSV or JSON (admins only)',
    description:
      'Takes the filters of the list endpoint and streams every matching row, newest first, ' +
      'up to AUDIT_EXPORT_MAX_ROWS (default 100,000). A capped CSV ends with a `# truncated` ' +
      'line; capped JSON has `truncated: true`. On Cloud, only rows still within retention exist.',
  })
  @ApiProduces('text/csv', 'application/json')
  @ApiQuery({ name: 'format', required: true, enum: ['csv', 'json'] })
  @ApiQuery({ name: 'payloads', required: false, type: Boolean, description: 'Include input and output (default false)' })
  @ApiQuery({ name: 'toolId', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, enum: INVOCATION_STATUSES })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'connectorId', required: false, type: String })
  @ApiQuery({ name: 'mcpServerId', required: false, type: String })
  @ApiQuery({ name: 'from', required: false, type: String, description: 'ISO date or date-time, inclusive' })
  @ApiQuery({ name: 'to', required: false, type: String, description: 'ISO date or date-time, exclusive' })
  async exportInvocations(
    @Req() req: any,
    @Query() query: ExportInvocationsQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const organizationId = req.user?.organizationId;
    if (!organizationId) {
      throw new ForbiddenException('Exporting the audit log needs an organization');
    }
    const filters = this.filters(query, organizationId);
    // Admin-only today, so never restricted; kept so the export can't show more than the list.
    const scope = await this.visibility.scopeFor(req.user);
    if (scope.restricted) filters.onlyUserId = scope.userId;
    const payloads = query.payloads ?? false;
    const encoder = new AuditExportEncoder(query.format, payloads);

    const day = (iso?: string) => iso?.slice(0, 10);
    const filename = `anythingmcp-audit-${day(query.from) ?? 'all'}-${
      day(query.to) ?? new Date().toISOString().slice(0, 10)
    }.${query.format}`;
    res.setHeader(
      'Content-Type',
      query.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');

    // The file starts with the first batch, so a failure before it still
    // reaches the client as an ordinary error response.
    let started = false;
    const begin = () => {
      if (started) return '';
      started = true;
      return encoder.start();
    };

    try {
      const result = await this.auditService.exportInvocations(filters, { payloads }, async (rows) => {
        await writeChunk(res, begin() + encoder.rows(rows));
        return !res.destroyed;
      });
      if (result.aborted || res.destroyed) return;
      res.end(begin() + encoder.end(result));
    } catch (err: any) {
      if (!res.headersSent) throw err;
      // Mid-file: a clean end would pass a partial file off as complete.
      this.logger.error(`Audit export for organization ${organizationId} failed: ${err?.message}`);
      res.destroy(err);
    }
  }

  @Get('stats')
  @ApiOperation({
    summary: 'Get invocation statistics',
    description:
      'Tool-call counters for your workspace: last 24 hours, errors in the last 24 hours, last 7 days and all time.' +
      ' In a workspace with restricted member visibility, a member who is not an admin gets only their own calls.',
  })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      example: { invocations24h: 312, errors24h: 7, invocations7d: 2140, totalInvocations: 48211 },
    },
  })
  async getStats(@Req() req: any) {
    const scope = await this.visibility.scopeFor(req.user);
    if (!scope.restricted) {
      return this.auditService.getStats(req.user.organizationId);
    }
    return this.auditService.getStats(req.user.organizationId, scope.userId);
  }

  @Get('analytics')
  @ApiOperation({
    summary: 'Get analytics data with daily time-series and top tools',
    description:
      'Returns a daily breakdown (UTC days, last `days`, default 7) of invocations by status, ' +
      'top 10 most-used tools, success rate, and average duration.\n\n' +
      '```bash\namcp api GET "/api/audit/analytics?days=30"\n```\n\n' +
      'In a workspace with restricted member visibility, a member who is not an admin gets only their own calls.',
  })
  @ApiQuery({
    name: 'days',
    required: false,
    type: Number,
    description: `Window in days, 1 to ${ANALYTICS_MAX_DAYS} (default ${ANALYTICS_DEFAULT_DAYS})`,
  })
  async getAnalytics(@Req() req: any, @Query() query: AnalyticsQueryDto) {
    const scope = await this.visibility.scopeFor(req.user);
    if (!scope.restricted) {
      return this.auditService.getAnalytics(
        req.user.organizationId,
        query.days ?? ANALYTICS_DEFAULT_DAYS,
      );
    }
    return this.auditService.getAnalytics(
      req.user.organizationId,
      query.days ?? ANALYTICS_DEFAULT_DAYS,
      scope.userId,
    );
  }

  @Get('tool-performance')
  @ApiOperation({
    summary: 'Get per-tool latency percentiles and failure rates',
    description:
      'Groups the last hours (default 24, maximum 2160) by tool, connector and MCP server. ' +
      'ERROR and TIMEOUT count as failures. Latency percentiles use stored duration samples; ' +
      'repeated failures retain their first recorded server and duration.' +
      ' In a workspace with restricted member visibility, a member who is not an admin gets only their own calls.',
  })
  @ApiQuery({ name: 'hours', required: false, type: Number })
  @ApiQuery({ name: 'connectorId', required: false, type: String })
  @ApiQuery({ name: 'mcpServerId', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  async getToolPerformance(
    @Req() req: { user: { sub: string; role: string; organizationId: string } },
    @Query() query: ToolPerformanceQueryDto,
  ) {
    const scope = await this.visibility.scopeFor(req.user);
    if (!scope.restricted) {
      return this.auditService.getToolPerformance(req.user.organizationId, query);
    }
    return this.auditService.getToolPerformance(req.user.organizationId, query, scope.userId);
  }

  @Get('breakdowns')
  @ApiOperation({
    summary: 'Usage & cost breakdowns by connector / MCP server / user',
    description:
      'Aggregates the last N days (default 30) of tool calls per connector, per ' +
      'MCP server and per user, with error counts, proxy-call metering and a ' +
      'volume-based cost estimate. Each list holds the top 20 by calls; `estCostMicros` is 0 unless the ' +
      'instance sets per-call rates.' +
      ' In a workspace with restricted member visibility, a member who is not an admin gets only their own calls: every list and total counts only their calls, and `byUser` holds only their own row.',
  })
  @ApiQuery({ name: 'days', required: false, type: Number, description: 'Window in days, 1 to 365 (default 30).', example: 30 })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      example: {
        days: 30,
        total: 9120,
        errors: 143,
        proxyCalls: 0,
        estCostMicros: 0,
        rates: { callMicros: 0, proxyCallMicros: 0 },
        byConnector: [{ id: 'cmob60dvv00c01zrpeujwmnep', label: 'HubSpot', count: 5210, errors: 61 }],
        byServer: [{ id: 'cmo9x1k2a0001abcdpq7rs8tu', label: 'Sales', count: 6001, errors: 70 }],
        byUser: [{ id: 'cmo8a7b6c0000abcdx1y2z3w4', label: 'Ana', count: 3302, errors: 12 }],
      },
    },
  })
  async getBreakdowns(@Req() req: any, @Query('days') days?: string) {
    const scope = await this.visibility.scopeFor(req.user);
    if (!scope.restricted) {
      return this.auditService.getBreakdowns(
        req.user.organizationId,
        days ? parseInt(days, 10) : 30,
      );
    }
    return this.auditService.getBreakdowns(
      req.user.organizationId,
      days ? parseInt(days, 10) : 30,
      scope.userId,
    );
  }
}
