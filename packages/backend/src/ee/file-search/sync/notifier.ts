// Licensed under the AnythingMCP Commercial License, see packages/backend/src/ee/LICENSE.
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma.service';
import type { EmailService } from '../../../settings/email.service';

/**
 * Tells the workspace's administrators once per pause (#1386) that a File
 * Search sync stopped and why, with a link to the connector's Files tab
 * (Upgrade, Edit selection, Resume). Reuses the connector notice e-mail.
 */
export class PauseNotifier {
  private readonly logger = new Logger(PauseNotifier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService | null,
  ) {}

  async notify(organizationId: string, connectorId: string, connectorName: string, message: string): Promise<boolean> {
    if (!this.email) {
      this.logger.warn(`File Search pause in org ${organizationId} (${connectorId}); no mailer in this process`);
      return false;
    }
    const admins = await this.prisma.organizationMember.findMany({
      where: { organizationId, role: 'ADMIN', deactivatedAt: null },
      select: { user: { select: { email: true, name: true } } },
      take: 10,
    });
    let sent = false;
    for (const a of admins) {
      if (!a.user?.email) continue;
      try {
        sent =
          (await this.email.sendConnectorAuthEmail(
            a.user.email,
            { name: a.user.name ?? null, connectorName, message, connectorPath: `/connectors/${connectorId}?tab=files` },
            organizationId,
          )) || sent;
      } catch (err) {
        this.logger.warn(`pause e-mail failed: ${(err as Error).message}`);
      }
    }
    return sent;
  }
}
