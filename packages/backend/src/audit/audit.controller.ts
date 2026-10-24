import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { AuditService } from './audit.service';
import {
  ANALYTICS_DEFAULT_DAYS,
  ANALYTICS_MAX_DAYS,
  AnalyticsQueryDto,
} from './analytics-query.dto';

@ApiTags('Audit')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get('invocations')
  @ApiOperation({ summary: 'List tool invocation logs' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'toolId', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, enum: ['SUCCESS', 'ERROR', 'TIMEOUT'] })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'connectorId', required: false, type: String })
  @ApiQuery({ name: 'mcpServerId', required: false, type: String })
  async listInvocations(
    @Req() req: any,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('toolId') toolId?: string,
    @Query('status') status?: 'SUCCESS' | 'ERROR' | 'TIMEOUT',
    @Query('search') search?: string,
    @Query('connectorId') connectorId?: string,
    @Query('mcpServerId') mcpServerId?: string,
  ) {
    return this.auditService.getRecentInvocations(
      limit ? parseInt(limit, 10) : 100,
      offset ? parseInt(offset, 10) : 0,
      { toolId, status: status as any, search, connectorId, mcpServerId, organizationId: req.user.organizationId },
    );
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get invocation statistics' })
  async getStats(@Req() req: any) {
    return this.auditService.getStats(req.user.organizationId);
  }

  @Get('analytics')
  @ApiOperation({
    summary: 'Get analytics data with daily time-series and top tools',
    description:
      'Returns a daily breakdown (UTC days, last `days`, default 7) of invocations by status, ' +
      'top 10 most-used tools, success rate, and average duration.',
  })
  @ApiQuery({
    name: 'days',
    required: false,
    type: Number,
    description: `Window in days, 1 to ${ANALYTICS_MAX_DAYS} (default ${ANALYTICS_DEFAULT_DAYS})`,
  })
  async getAnalytics(@Req() req: any, @Query() query: AnalyticsQueryDto) {
    return this.auditService.getAnalytics(
      req.user.organizationId,
      query.days ?? ANALYTICS_DEFAULT_DAYS,
    );
  }

  @Get('breakdowns')
  @ApiOperation({
    summary: 'Usage & cost breakdowns by connector / MCP server / user',
    description:
      'Aggregates the last N days (default 30) of tool calls per connector, per ' +
      'MCP server and per user, with error counts, proxy-call metering and a ' +
      'volume-based cost estimate.',
  })
  @ApiQuery({ name: 'days', required: false, type: Number })
  async getBreakdowns(@Req() req: any, @Query('days') days?: string) {
    return this.auditService.getBreakdowns(
      req.user.organizationId,
      days ? parseInt(days, 10) : 30,
    );
  }
}
