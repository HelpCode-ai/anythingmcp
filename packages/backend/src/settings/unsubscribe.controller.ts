import { Controller, Get, HttpCode, Logger, Post, Query, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { PrismaService } from '../common/prisma.service';
import { DeploymentService } from '../common/deployment.service';
import { escapeHtml, renderAuthPage } from '../auth/auth-page';
import { unsubscribeSecret, verifyUnsubscribe } from './unsubscribe-token';

/**
 * One-click unsubscribe from marketing email (onboarding tips, activation
 * nudges, win-back offers), RFC 8058.
 *
 * - POST is the unsubscribe itself: what Gmail, Yahoo and Apple Mail send when
 *   the reader uses their "Unsubscribe" button (`List-Unsubscribe-Post`), and
 *   what the button on the GET page submits.
 * - GET only shows that button. Link scanners and previews fetch every URL in
 *   an email; a GET that unsubscribed would opt people out who never asked.
 *
 * The link is signed for one user (see unsubscribe-token.ts), so it works
 * without signing in and cannot be used for anyone else. Transactional email
 * (codes, password resets, invitations) and the trial-ending notices are not
 * affected.
 */
@ApiExcludeController()
@Controller('api/public/unsubscribe')
export class UnsubscribeController {
  private readonly logger = new Logger(UnsubscribeController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deployment: DeploymentService,
  ) {}

  @Get()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  confirm(@Query('u') userId: string, @Query('t') token: string, @Res() res: Response) {
    const valid = this.valid(userId, token);
    this.html(res, valid ? 200 : 400, valid ? this.confirmCard(userId, token) : this.invalidCard());
  }

  @Post()
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async unsubscribe(@Query('u') userId: string, @Query('t') token: string, @Res() res: Response) {
    if (!this.valid(userId, token)) {
      return this.html(res, 400, this.invalidCard());
    }
    // updateMany: a deleted account is simply nothing to update.
    const { count } = await this.prisma.user.updateMany({
      where: { id: userId },
      data: { emailMarketingOptOut: true },
    });
    if (count > 0) this.logger.log(`Marketing email opt-out via one-click link (user ${userId})`);
    return this.html(
      res,
      200,
      `
    <h1>You are unsubscribed</h1>
    <p class="sub" style="margin-bottom:0">You will no longer receive tips and offers from AnythingMCP. Emails you need for your account, such as sign-in codes, password resets and notices about your plan, still reach you.</p>`,
    );
  }

  private valid(userId: unknown, token: unknown): boolean {
    const secret = unsubscribeSecret();
    return !!secret && verifyUnsubscribe(userId, token, secret);
  }

  private confirmCard(userId: string, token: string): string {
    const action = `/api/public/unsubscribe?u=${encodeURIComponent(userId)}&t=${encodeURIComponent(token)}`;
    return `
    <h1>Unsubscribe from tips and offers?</h1>
    <p class="sub">You will stop receiving onboarding tips and offers from AnythingMCP. Emails you need for your account still reach you.</p>
    <form method="POST" action="${escapeHtml(action)}">
      <input type="hidden" name="List-Unsubscribe" value="One-Click">
      <button type="submit">Unsubscribe</button>
    </form>`;
  }

  private invalidCard(): string {
    return `
    <h1>This link does not work</h1>
    <p class="sub" style="margin-bottom:0">It may have been shortened or changed on its way here. Use the unsubscribe link from the email again, or reply to the email and we will take you off the list.</p>`;
  }

  private html(res: Response, status: number, card: string) {
    res.status(status);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.setHeader('Cache-Control', 'no-store');
    res.send(
      renderAuthPage({
        title: 'Email preferences — AnythingMCP',
        card,
        trust: { cloud: this.deployment.isCloud(), stars: null },
      }),
    );
  }
}
