import {
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  NotFoundException,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createHmac, timingSafeEqual } from 'crypto';
import { supportChatConfig, supportTriageConfig } from './support-config';
import { SupportIdentityService } from './support-identity.service';
import { DeskConversation, SupportTriageService } from './support-triage.service';

/** Webhook deliveries older than this are refused (replay protection). */
const MAX_WEBHOOK_AGE_MS = 10 * 60_000;

@ApiTags('Support')
@Controller('api/support')
export class SupportController {
  private readonly logger = new Logger(SupportController.name);

  constructor(
    private readonly identity: SupportIdentityService,
    private readonly triage: SupportTriageService,
  ) {}

  /**
   * GET /api/support/widget: what the frontend needs to load the chat widget
   * with a verified identity. 404 where the chat is not configured.
   */
  @Get('widget')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Support chat widget settings and signed identity for the current user' })
  async widget(@Req() req: any) {
    if (!supportChatConfig()) throw new NotFoundException();
    return this.identity.widgetSession(req.user.sub, req.user.organizationId ?? null);
  }

  /**
   * POST /api/support/webhook: Libredesk `conversation.created` deliveries,
   * signed with `X-Libredesk-Signature: sha256=<hex HMAC of the raw body>`.
   * Answers at once; the triage runs in the background (Libredesk does not
   * retry and times out after 15 s).
   */
  @Post('webhook')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  webhook(@Req() req: any, @Headers('x-libredesk-signature') signature?: string) {
    const cfg = supportTriageConfig();
    if (!cfg) throw new NotFoundException();

    const raw: Buffer | undefined = req.rawBody;
    if (!raw || !verifyLibredeskSignature(raw, signature, cfg.webhookSecret)) {
      throw new UnauthorizedException('Invalid signature');
    }

    const body = req.body ?? {};
    const sentAt = Date.parse(body.timestamp);
    if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > MAX_WEBHOOK_AGE_MS) {
      throw new UnauthorizedException('Stale delivery');
    }

    if (body.event === 'conversation.created' && body.payload?.uuid) {
      const conv = body.payload as DeskConversation;
      void this.triage.triage(conv).catch((err) =>
        this.logger.warn(`Support triage failed for ${conv.uuid}: ${(err as Error).message}`),
      );
    }
    return { ok: true };
  }
}

export function verifyLibredeskSignature(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`);
  const provided = Buffer.from(header.trim());
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}
