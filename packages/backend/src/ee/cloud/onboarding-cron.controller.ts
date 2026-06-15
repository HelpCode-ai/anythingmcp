import {
  Controller,
  Post,
  Headers,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { OnboardingCronService } from './onboarding-cron.service';

/**
 * POST /api/cron/onboarding-reminders
 *
 * Triggered by the `onboarding-reminders.yml` GitHub Actions workflow
 * every 6 hours. Pings the cloud backend to run the drip pipeline.
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>`. The secret is shared
 * between the workflow and the cloud env. Self-host deployments
 * normally don't set CRON_SECRET → the endpoint refuses anonymous
 * calls there too, so the drip is effectively cloud-only.
 */
@ApiTags('Cron')
@Controller('api/cron')
export class OnboardingCronController {
  private readonly logger = new Logger(OnboardingCronController.name);

  constructor(private readonly cron: OnboardingCronService) {}

  @Post('onboarding-reminders')
  @ApiOperation({
    summary:
      'Send onboarding drip emails to users registered ≥24h ago with 0 connectors',
  })
  async run(@Headers('authorization') authHeader?: string) {
    const expected = process.env.CRON_SECRET;
    if (!expected) {
      this.logger.warn(
        'CRON_SECRET is not configured — refusing onboarding cron call.',
      );
      throw new UnauthorizedException('Cron not configured');
    }
    const provided =
      authHeader?.startsWith('Bearer ') && authHeader.substring(7);
    if (provided !== expected) {
      throw new UnauthorizedException('Invalid cron token');
    }

    const result = await this.cron.run();
    return { ok: true, ...result };
  }
}
