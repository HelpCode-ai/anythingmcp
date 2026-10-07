import { Controller, Get, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { TrustStatsService } from './trust-stats.service';
import type { TrustStats } from './trust-stats.format';

/**
 * Public aggregate numbers for the sign-up page and the marketing site. No
 * authentication: they are the same for everyone and say nothing about any
 * person or workspace.
 */
@ApiTags('Public')
@Controller('api/public')
export class PublicStatsController {
  constructor(private readonly stats: TrustStatsService) {}

  @Get('stats')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Public aggregate numbers',
    description:
      'GitHub stars, Docker Hub pulls, number of workspaces and AI tool calls in the ' +
      'last 30 days. Cached for an hour; a value that is unknown is null.',
  })
  async getStats(@Res({ passthrough: true }) res: Response): Promise<TrustStats> {
    res.setHeader('Cache-Control', 'public, max-age=600');
    // Readable from any site (the marketing site renders them); never with
    // credentials, which this endpoint does not use.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.removeHeader('Access-Control-Allow-Credentials');
    const s = await this.stats.get();
    return {
      githubStars: s.githubStars,
      dockerPulls: s.dockerPulls,
      workspaces: s.workspaces,
      toolCalls30d: s.toolCalls30d,
      updatedAt: s.updatedAt,
    };
  }
}
