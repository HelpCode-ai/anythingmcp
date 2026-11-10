import {
  Body,
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
import { supportChatConfig, supportChatDisabledFor, supportTriageConfig } from './support-config';
import { SupportIdentityService } from './support-identity.service';
import { DeskConversation, SupportTriageService } from './support-triage.service';
import { DeskMessage, SupportTelegramSetupService } from './support-telegram-setup.service';
import { DeskToolArgs, SupportConnectorSetupService } from './support-connector-setup.service';
import { SupportHandoffNoticeService } from './support-handoff-notice.service';

/** Webhook deliveries older than this are refused (replay protection). */
const MAX_WEBHOOK_AGE_MS = 10 * 60_000;

@ApiTags('Support')
@Controller('api/support')
export class SupportController {
  private readonly logger = new Logger(SupportController.name);

  constructor(
    private readonly identity: SupportIdentityService,
    private readonly triage: SupportTriageService,
    private readonly telegramSetup: SupportTelegramSetupService,
    private readonly connectorSetup: SupportConnectorSetupService,
    private readonly handoffNotice: SupportHandoffNoticeService,
  ) {}

  /**
   * GET /api/support/widget: what the frontend needs to load the chat widget
   * with a verified identity. 404 where the chat is not configured, or is
   * switched off for the caller's workspace (SUPPORT_CHAT_DISABLED_ORGS).
   */
  @Get('widget')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Support chat widget settings and signed identity for the current user' })
  async widget(@Req() req: any) {
    if (!supportChatConfig()) throw new NotFoundException();
    const organizationId = req.user.organizationId ?? null;
    if (supportChatDisabledFor(organizationId)) throw new NotFoundException();
    return this.identity.widgetSession(req.user.sub, organizationId);
  }

  /**
   * POST /api/support/webhook: Libredesk `conversation.created` and
   * `message.created` deliveries,
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

    if (body.event === 'message.created' && body.payload?.uuid) {
      const msg = body.payload as DeskMessage;
      void this.telegramSetup.handleMessage(msg).catch((err) =>
        this.logger.warn(`Support message handling failed for ${msg.conversation_uuid}: ${(err as Error).message}`),
      );
      void this.handoffNotice.handleMessage(msg).catch((err) =>
        this.logger.warn(`Support handoff notice failed for ${msg.conversation_uuid}: ${(err as Error).message}`),
      );
    }
    if (body.event === 'conversation.created' && body.payload?.uuid) {
      const conv = body.payload as DeskConversation;
      void this.triage.triage(conv).catch((err) =>
        this.logger.warn(`Support triage failed for ${conv.uuid}: ${(err as Error).message}`),
      );
    }
    return { ok: true };
  }

  /**
   * POST /api/support/desk-tools/connector: the desk AI assistant's custom
   * tool "set_up_connector". Libredesk adds the contact's identity headers
   * itself; the model only fills the body. Answers 200 with what to tell the
   * customer, also when nothing could be set up.
   */
  @Post('desk-tools/connector')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async deskConnector(
    @Headers() headers: Record<string, string | undefined>,
    @Body() body: DeskToolArgs,
  ) {
    const cfg = supportTriageConfig();
    if (!cfg) throw new NotFoundException();
    if (!verifyDeskToolKey(headers['x-desk-tool-key'], cfg.webhookSecret)) {
      throw new UnauthorizedException('Invalid key');
    }
    try {
      return await this.connectorSetup.handle(
        {
          externalUserId: headers['x-libredesk-contact-external-id'],
          contactType: headers['x-libredesk-contact-type'],
          conversationUuid: headers['x-libredesk-conversation-uuid'],
        },
        body ?? {},
      );
    } catch (err) {
      this.logger.warn(`Desk connector tool failed: ${(err as Error).message?.slice(0, 200)}`);
      return { error: 'Something went wrong on our side. Give the customer the setup page link instead.' };
    }
  }
}

/**
 * The key Libredesk sends on calls of our custom AI tools (header
 * X-Desk-Tool-Key, stored encrypted in the tool's auth headers). Derived
 * from the webhook secret, so it needs no variable of its own.
 */
export function deskToolKey(webhookSecret: string): string {
  return createHmac('sha256', webhookSecret).update('libredesk-ai-tool-v1').digest('hex');
}

export function verifyDeskToolKey(header: string | undefined, webhookSecret: string): boolean {
  if (!header || !webhookSecret) return false;
  const expected = Buffer.from(deskToolKey(webhookSecret));
  const provided = Buffer.from(header.trim());
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

export function verifyLibredeskSignature(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`);
  const provided = Buffer.from(header.trim());
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}
