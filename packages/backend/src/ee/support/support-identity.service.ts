import { Injectable, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../common/prisma.service';
import { DeploymentService } from '../../common/deployment.service';
import { LicenseService } from '../../license/license.service';
import { instanceHost, supportChatConfig } from './support-config';
import { compactError } from './support-redact';

/** Contact attributes shown to agents and read by the triage. All strings. */
export type SupportContactAttributes = Record<string, string>;

export interface SupportWidgetSession {
  baseUrl: string;
  inboxId: string;
  userJwt: string;
}

const CONTEXT_TTL_MS = 5 * 60_000;
const CONTEXT_CACHE_MAX = 5_000;
const JWT_TTL_SECONDS = 60 * 60;
const ERROR_WINDOW_MS = 24 * 60 * 60_000;
const MAX_ISSUES = 5;
const ISSUES_MAX_CHARS = 900;

/**
 * Builds the signed identity the Libredesk widget exchanges for a verified
 * contact, carrying a snapshot of the workspace (plan, trial end, connectors
 * that are failing) so agents and the triage see it without asking.
 *
 * Organization-scoped: every query filters by the caller's organizationId.
 */
@Injectable()
export class SupportIdentityService {
  private readonly jwt = new JwtService();
  private readonly cache = new Map<string, { at: number; attrs: SupportContactAttributes }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly deployment: DeploymentService,
    private readonly license: LicenseService,
  ) {}

  async widgetSession(userId: string, organizationId: string | null): Promise<SupportWidgetSession> {
    const cfg = supportChatConfig();
    if (!cfg) throw new NotFoundException();

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true },
    });
    if (!user) throw new NotFoundException();

    const attrs = await this.contactAttributes(userId, organizationId);
    const { first, last } = splitName(user.name, user.email);
    const userJwt = this.jwt.sign(
      {
        // Unique per instance: the same person may exist on Cloud and on a
        // dedicated instance, and those are different accounts.
        external_user_id: `${instanceHost()}:${user.id}`.slice(0, 128),
        email: user.email.slice(0, 254),
        first_name: first,
        ...(last ? { last_name: last } : {}),
        contact_custom_attributes: attrs,
      },
      { secret: cfg.secret, algorithm: 'HS256', expiresIn: JWT_TTL_SECONDS },
    );
    return { baseUrl: cfg.baseUrl, inboxId: cfg.inboxId, userJwt };
  }

  /** Cached for a few minutes: the widget asks on every full page load. */
  async contactAttributes(userId: string, organizationId: string | null): Promise<SupportContactAttributes> {
    const key = `${organizationId ?? ''}:${userId}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CONTEXT_TTL_MS) return hit.attrs;

    const attrs = await this.buildAttributes(userId, organizationId);
    if (this.cache.size >= CONTEXT_CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { at: Date.now(), attrs });
    return attrs;
  }

  private async buildAttributes(userId: string, organizationId: string | null): Promise<SupportContactAttributes> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, createdAt: true, emailVerified: true },
    });
    const attrs: SupportContactAttributes = {
      instance: instanceHost(),
      deployment: this.deployment.isCloud() ? 'cloud' : 'dedicated',
      role: user?.role ?? '',
      signed_up_at: user?.createdAt ? user.createdAt.toISOString().slice(0, 10) : '',
    };
    if (user && !user.emailVerified) attrs.email_verified = 'no';
    if (!organizationId) return attrs;

    const [org, license, connectors] = await Promise.all([
      this.prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } }),
      this.license.getCurrentLicense(organizationId).catch(() => null),
      this.prisma.connector.findMany({
        where: { organizationId },
        select: { id: true, name: true, isActive: true, authStatus: true, authStatusMessage: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    attrs.organization_id = organizationId;
    attrs.organization_name = org?.name ?? '';
    attrs.plan = license?.plan ?? 'none';
    attrs.license_status = license?.status ?? '';
    if (license?.plan === 'trial' && license.expiresAt) {
      attrs.trial_ends_at = new Date(license.expiresAt).toISOString().slice(0, 10);
    }

    const inactive = connectors.filter((c) => !c.isActive).length;
    attrs.connectors = inactive ? `${connectors.length} (${inactive} inactive)` : String(connectors.length);
    attrs.connector_issues = await this.connectorIssues(organizationId, connectors);
    return attrs;
  }

  /**
   * One line per connector that needs attention: an auth problem, or calls
   * that failed in the last 24 hours with the latest error (redacted).
   */
  private async connectorIssues(
    organizationId: string,
    connectors: Array<{ id: string; name: string; authStatus: string | null; authStatusMessage: string | null }>,
  ): Promise<string> {
    if (connectors.length === 0) return '';
    const since = new Date(Date.now() - ERROR_WINDOW_MS);
    const failing = await this.prisma.toolInvocation.groupBy({
      by: ['connectorId'],
      where: { organizationId, status: { in: ['ERROR', 'TIMEOUT'] }, createdAt: { gte: since } },
      _count: { _all: true },
    });
    const errorCount = new Map<string, number>();
    for (const row of failing) if (row.connectorId) errorCount.set(row.connectorId, row._count._all);

    const lines: string[] = [];
    for (const c of connectors) {
      if (lines.length >= MAX_ISSUES) break;
      const parts: string[] = [];
      if (c.authStatus) {
        parts.push(`auth ${c.authStatus}${c.authStatusMessage ? ` (${compactError(c.authStatusMessage, 80)})` : ''}`);
      }
      const errors = errorCount.get(c.id);
      if (errors) {
        const last = await this.prisma.toolInvocation.findFirst({
          where: { organizationId, connectorId: c.id, status: { in: ['ERROR', 'TIMEOUT'] }, createdAt: { gte: since } },
          orderBy: { createdAt: 'desc' },
          select: { error: true, tool: { select: { name: true } } },
        });
        const tool = last?.tool?.name ? `${last.tool.name}: ` : '';
        parts.push(`${errors} failed calls/24h${last?.error ? `, last ${tool}${compactError(last.error)}` : ''}`);
      }
      if (parts.length) lines.push(`${c.name}: ${parts.join('; ')}`);
    }
    const text = lines.join(' | ');
    return text.length > ISSUES_MAX_CHARS ? `${text.slice(0, ISSUES_MAX_CHARS - 1)}…` : text;
  }
}

export function splitName(name: string | null | undefined, email: string): { first: string; last: string } {
  const clean = (name || '').trim().replace(/\s+/g, ' ');
  if (clean) {
    const [first, ...rest] = clean.split(' ');
    return { first: first.slice(0, 128), last: rest.join(' ').slice(0, 128) };
  }
  return { first: (email.split('@')[0] || 'User').slice(0, 128), last: '' };
}
