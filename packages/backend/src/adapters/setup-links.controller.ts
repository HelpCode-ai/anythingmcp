import { Body, Controller, GoneException, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ConnectorSetupService } from './connector-setup.service';

/**
 * Opening a one-time setup link (/s/<token> in the dashboard). Authenticated:
 * the link only works for the user it was made for, so one forwarded or
 * leaked from a chat opens nothing for anyone else.
 */
@ApiTags('Connector setup')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/setup-links')
export class SetupLinksController {
  constructor(private readonly setup: ConnectorSetupService) {}

  @Post('resolve')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Open a one-time connector setup link' })
  async resolve(@Req() req: any, @Body() body: { token?: string; from?: string }): Promise<{ redirect: string }> {
    // `from` only picks the setup page's way back, from a fixed list.
    const out = await this.setup.resolveLink(String(body?.token ?? ''), req.user.sub, body?.from);
    if ('error' in out) throw new GoneException(out.error);
    return out;
  }
}
