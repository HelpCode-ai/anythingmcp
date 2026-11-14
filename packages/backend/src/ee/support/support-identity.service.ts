import { Injectable, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../common/prisma.service';
import { DeploymentService } from '../../common/deployment.service';
import { LicenseService } from '../../license/license.service';
import { instanceHost, supportChatConfig } from './support-config';
import { compactError } from './support-redact';
import { getAdapter } from '../../adapters/catalog';
import { isMachineGrant } from '../../connectors/oauth-grant.util';
import { findUnresolvedPlaceholders } from '../../common/unresolved-placeholders.util';

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
const MAX_NAMES = 15;
const ISSUES_MAX_CHARS = 900;
const LINKS_MAX_CHARS = 1500;
const MAX_SERVERS = 5;

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

    const [org, license, connectors, servers] = await Promise.all([
      this.prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } }),
      this.license.getCurrentLicense(organizationId).catch(() => null),
      this.prisma.connector.findMany({
        where: { organizationId },
        select: {
          id: true,
          name: true,
          isActive: true,
          authStatus: true,
          authStatusMessage: true,
          config: true,
          type: true,
          authType: true,
          envVars: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.mcpServerConfig.findMany({
        where: { organizationId, isActive: true },
        select: { id: true, name: true },
        orderBy: { createdAt: 'asc' },
        take: MAX_SERVERS + 1,
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
    if (connectors.length) attrs.connector_names = connectorNames(connectors);
    // The desk's assistant reads these: a customer asking where to put a
    // token gets the page of the connector they already have, not the
    // generic setup page, which would add a second one.
    const links = connectorLinks(connectors, process.env.FRONTEND_URL);
    if (links) attrs.connector_links = links;
    // The URL an AI client (Claude, ChatGPT, Cursor) is pointed at. Without
    // it the assistant offered a connector setup page as the server URL.
    const serverUrls = mcpServerUrls(servers, process.env.SERVER_URL);
    if (serverUrls) attrs.mcp_server_urls = serverUrls;
    attrs.connector_issues = await this.connectorIssues(organizationId, connectors);
    // "never" with connectors installed is the most common blocker: no AI
    // client is connected to the workspace's MCP server yet.
    attrs.last_tool_call = await this.lastToolCall(organizationId);
    return attrs;
  }

  /** Day of the workspace's latest successful tool call, or "never". */
  private async lastToolCall(organizationId: string): Promise<string> {
    const last = await this.prisma.toolInvocation.findFirst({
      where: { organizationId, status: 'SUCCESS' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return last?.createdAt instanceof Date ? last.createdAt.toISOString().slice(0, 10) : 'never';
  }

  /**
   * One line per connector that needs attention: an auth problem, or calls
   * that failed in the last 24 hours with the latest error (redacted).
   */
  private async connectorIssues(
    organizationId: string,
    connectors: Array<
      { id: string; name: string; authStatus: string | null; authStatusMessage: string | null } & AppKeysInput
    >,
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
      const missingKeys = missingOAuthAppKeys(c);
      if (missingKeys.length) {
        parts.push(`app keys not saved: ${missingKeys.join(', ')} (Authorize cannot start)`);
      }
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

export interface AppKeysInput {
  type?: string | null;
  authType?: string | null;
  config?: unknown;
  /** Decrypted by the Prisma extension; only presence is looked at. */
  envVars?: unknown;
}

/**
 * The labels of a catalog OAuth2 connector's app keys that are still empty
 * (Etsy: "Keystring", "Shared Secret"). Without them "Authorize with
 * Provider" cannot start, and the customer sees nothing happen on the
 * connector page (desk #290, Nov 2026). Looks at the catalog adapter's
 * client id/secret placeholders and whether the connector's variables fill
 * them; values are never returned. MCP bridges register a client on their
 * own and machine grants have no browser step, so both are left out.
 */
export function missingOAuthAppKeys(connector: AppKeysInput): string[] {
  if (connector.authType !== 'OAUTH2' || connector.type === 'MCP') return [];
  const slug = (connector.config as { adapterSlug?: unknown } | null | undefined)?.adapterSlug;
  if (typeof slug !== 'string' || !slug) return [];
  const adapter = getAdapter(slug);
  const auth = adapter?.connector.authConfig;
  if (!adapter || adapter.connector.type === 'MCP' || !auth || isMachineGrant(auth.grant)) return [];
  const names = findUnresolvedPlaceholders([auth.clientId, auth.clientSecret]);
  const vars = (connector.envVars && typeof connector.envVars === 'object' ? connector.envVars : {}) as Record<
    string,
    unknown
  >;
  return names
    .filter((name) => {
      const value = vars[name];
      if (value === undefined || value === null) return true;
      const text = String(value).trim();
      return text === '' || findUnresolvedPlaceholders(text).length > 0 || /^PASTE_/i.test(text);
    })
    .map((name) => (adapter.envVarMeta?.[name]?.label || name).slice(0, 40));
}

/** The installed connectors' names, bounded. */
export function connectorNames(connectors: Array<{ name: string }>): string {
  const names = connectors.slice(0, MAX_NAMES).map((c) => c.name.slice(0, 60));
  const more = connectors.length - names.length;
  return names.join(', ') + (more > 0 ? ` and ${more} more` : '');
}

/**
 * "Name: URL" per installed connector, bounded. A catalog connector links to
 * its guided setup for that connector (credentials, provider sign-in); one
 * made by hand to its connector page. Empty without a dashboard URL.
 */
export function connectorLinks(
  connectors: Array<{ id: string; name: string; config?: unknown }>,
  frontendUrl: string | undefined,
): string {
  const base = (frontendUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) return '';
  const lines: string[] = [];
  let length = 0;
  for (const c of connectors.slice(0, MAX_NAMES)) {
    const slug = (c.config as { adapterSlug?: unknown } | null | undefined)?.adapterSlug;
    const id = encodeURIComponent(c.id);
    const url =
      typeof slug === 'string' && slug
        ? `${base}/connectors/setup/${encodeURIComponent(slug)}?connector=${id}`
        : `${base}/connectors/${id}`;
    const line = `${c.name.slice(0, 60)}: ${url}`;
    if (length + line.length + 3 > LINKS_MAX_CHARS) break;
    lines.push(line);
    length += line.length + 3;
  }
  return lines.join(' | ');
}

export function splitName(name: string | null | undefined, email: string): { first: string; last: string } {
  const clean = (name || '').trim().replace(/\s+/g, ' ');
  if (clean) {
    const [first, ...rest] = clean.split(' ');
    return { first: first.slice(0, 128), last: rest.join(' ').slice(0, 128) };
  }
  return { first: (email.split('@')[0] || 'User').slice(0, 128), last: '' };
}

/**
 * "Name: URL" per active MCP server of the workspace, bounded: the address
 * an AI client connects to (<SERVER_URL>/mcp/<id>). Empty without a public
 * server URL.
 */
export function mcpServerUrls(servers: Array<{ id: string; name: string }>, serverUrl: string | undefined): string {
  const base = (serverUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) return '';
  const lines = servers
    .slice(0, MAX_SERVERS)
    .map((s) => `${s.name.slice(0, 60)}: ${base}/mcp/${encodeURIComponent(s.id)}`);
  const more = servers.length - lines.length;
  return lines.join(' | ') + (more > 0 ? ' and more on the MCP Servers page' : '');
}
