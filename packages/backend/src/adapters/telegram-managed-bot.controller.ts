import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  NotFoundException,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { TelegramManagedBotService } from './telegram-managed-bot.service';

/**
 * POST /api/telegram/manager-webhook: the updates of this instance's manager
 * bot (see telegram-managed-bot.ts). Telegram is the only caller: it sends
 * back the secret given to setWebhook in `X-Telegram-Bot-Api-Secret-Token`,
 * which is compared in constant time. Does not exist (404) while the feature
 * is not configured.
 *
 * Telegram sends an update again when the answer is not 2xx, so 503 is used
 * only when trying again can help (Telegram's API did not answer); every
 * other outcome is 200, handled or not.
 */
@Controller('api/telegram')
export class TelegramManagedBotController {
  private readonly logger = new Logger(TelegramManagedBotController.name);

  constructor(private readonly bots: TelegramManagedBotService) {}

  @Post('manager-webhook')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  // All updates come from Telegram's few addresses: the default per-address limit would drop a busy minute.
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  async receive(
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() update: unknown,
  ): Promise<{ ok: true }> {
    if (!this.bots.isConfigured()) throw new NotFoundException();
    if (!this.bots.verifyWebhookSecret(secret)) {
      this.logger.warn('Rejected a Telegram manager webhook call with a missing or wrong secret');
      throw new UnauthorizedException();
    }
    let outcome: Awaited<ReturnType<TelegramManagedBotService['handleUpdate']>>;
    try {
      outcome = await this.bots.handleUpdate(update);
    } catch (err) {
      // Nothing Telegram can fix by sending it again; a name only, never the update.
      this.logger.warn(`A Telegram manager update could not be handled (${(err as Error)?.name || 'error'})`);
      return { ok: true };
    }
    if (outcome === 'retry') throw new ServiceUnavailableException();
    return { ok: true };
  }
}
