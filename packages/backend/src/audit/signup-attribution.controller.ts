import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { DeploymentService } from '../common/deployment.service';
import { ProductEventService } from './product-event.service';
import { AttributionClickId } from './signup-attribution';

/**
 * GET /api/auth/attribution/click-ids — the signed-in user's own Google Ads
 * click id, so the cloud app can pass it on to the pricing page and a
 * purchase can be uploaded to Google Ads as an offline conversion.
 *
 * Only ever the caller's own sign-up (the user id comes from the session,
 * never from the request), only an id stored with ad consent granted, and
 * only on AnythingMCP Cloud: a self-hosted instance records no attribution
 * and answers an empty object.
 */
@ApiTags('Auth')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/auth/attribution')
export class SignupAttributionController {
  constructor(
    private readonly events: ProductEventService,
    private readonly deployment: DeploymentService,
  ) {}

  @Get('click-ids')
  @ApiOperation({
    summary: "The signed-in user's own sign-up click id, if it was stored with ad consent (cloud only)",
  })
  async clickIds(@Req() req: any): Promise<AttributionClickId | Record<string, never>> {
    if (!this.deployment.isCloud()) return {};
    return (await this.events.clickIdForUser(req.user?.sub)) ?? {};
  }
}
