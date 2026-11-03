import {
  Controller,
  Headers,
  HttpCode,
  Logger,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { ConnectorsService } from './connectors.service';
import { WebhookEventsService } from './webhook-events.service';
import { verifyStripeSignature } from './webhook-signature.util';

/** Checked before the signature, so an oversized body never reaches the HMAC. */
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

/**
 * POST /api/webhooks/:connectorId — inbound webhook deliveries for any
 * connector that opted in (Connector.webhookEnabled). Stripe only for now;
 * other providers are a follow-up (each needs its own verification scheme).
 *
 * An unknown connector id, a disabled hook and a bad signature all answer
 * identically: there is no way for a caller to tell which one happened, so
 * this endpoint is not an oracle for probing which connector ids exist.
 *
 * Raw bytes: main.ts captures `req.rawBody` for this path specifically,
 * because Stripe's HMAC is computed over the exact bytes it sent, not a
 * re-serialization of the parsed JSON.
 */
@Controller('api/webhooks')
export class WebhookIngestController {
  private readonly logger = new Logger(WebhookIngestController.name);

  constructor(
    private readonly connectors: ConnectorsService,
    private readonly webhookEvents: WebhookEventsService,
  ) {}

  @Post(':connectorId')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async receive(
    @Param('connectorId') connectorId: string,
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('stripe-signature') stripeSignature?: string,
  ): Promise<{ ok: true }> {
    const raw = req.rawBody;
    if (!raw || raw.length > MAX_WEBHOOK_BODY_BYTES) {
      throw new UnauthorizedException();
    }

    const connector = await this.connectors.findByIdInternal(connectorId).catch(() => null);
    const sameResponseForAllOfThese =
      !connector ||
      !connector.isActive ||
      !connector.webhookEnabled ||
      connector.webhookProvider !== 'stripe';
    if (sameResponseForAllOfThese) {
      throw new UnauthorizedException();
    }

    const secret = this.connectors.decryptWebhookSecret(connector);
    if (!secret || !verifyStripeSignature(raw, stripeSignature, secret)) {
      throw new UnauthorizedException();
    }

    const event = this.parseStripeEvent(raw);
    const recorded = await this.webhookEvents.recordEvent({
      connectorId: connector.id,
      organizationId: connector.organizationId,
      provider: 'stripe',
      eventType: event?.type,
      externalId: event?.id,
      payload: event ?? {},
    });
    if (!recorded) {
      this.logger.log(`Duplicate Stripe delivery for connector ${connector.id}, event ${event?.id}`);
    }

    return { ok: true };
  }

  private parseStripeEvent(raw: Buffer): { id?: string; type?: string } | null {
    try {
      const parsed = JSON.parse(raw.toString('utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
}
