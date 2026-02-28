import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { AuditService } from './audit.service';

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
  async listInvocations(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('toolId') toolId?: string,
    @Query('status') status?: 'SUCCESS' | 'ERROR' | 'TIMEOUT',
  ) {
    return this.auditService.getRecentInvocations(
      limit ? parseInt(limit, 10) : 100,
      offset ? parseInt(offset, 10) : 0,
      { toolId, status: status as any },
    );
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get invocation statistics' })
  async getStats() {
    return this.auditService.getStats();
  }

  @Get('analytics')
  @ApiOperation({
    summary: 'Get analytics data with daily time-series and top tools',
    description:
      'Returns 7-day daily breakdown of invocations by status, ' +
      'top 10 most-used tools, success rate, and average duration.',
  })
  async getAnalytics() {
    return this.auditService.getAnalytics();
  }
}
