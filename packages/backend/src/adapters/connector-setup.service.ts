import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { AdaptersService } from './adapters.service';
import { describeAdapterEnvVars, needsBrowserAuthorization } from './env-var-meta';
import { LicenseGuardService } from '../license/license-guard.service';
import { SecurityEvents, SecurityEventService } from '../audit/security-event.service';
import { ProductEvents, ProductEventService } from '../audit/product-event.service';
import {
  SetupCallResult,
  SetupContext,
  SharedSetupProvider,
  SharedSetupRegistry,
} from '../mcp-server/shared-setup';
import { isExcludedAdapterSlug } from '../mcp-server/shared-toolset';
import { computeSetupState } from '../connectors/connector-setup-status.util';
import { decrypt } from '../common/crypto/encryption.util';

/** How long a setup link handed to the user stays valid. */
export const SETUP_LINK_TTL_MS = 30 * 60 * 1000;
/** Installs through a chat, per user and hour. A model does not need more. */
const INSTALLS_PER_HOUR = 10;

/**
 * Setting up connectors from an AI client, through the shared `/mcp`
 * endpoint (see shared-setup.ts), and the one-time links that finish what a
 * chat must not handle: secrets and the provider's sign-in.
 *
 * Rules, all enforced here rather than trusted to the model:
 * - catalog adapters only: no URL a prompt injection could point at a server
 *   of its own;
 * - only values that are not secret are accepted from the chat; a secret is
 *   refused with the link to enter it in the dashboard instead;
 * - ADMIN or EDITOR of the workspace, the same rule as the dashboard;
 * - the trial's connector limit, and INSTALLS_PER_HOUR per user;
 * - every install is recorded as a security event.
 */
@Injectable()
export class ConnectorSetupService implements SharedSetupProvider, OnModuleInit {
  private readonly logger = new Logger(ConnectorSetupService.name);
  private readonly installs = new Map<string, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapters: AdaptersService,
    private readonly licenseGuard: LicenseGuardService,
    private readonly registry: SharedSetupRegistry,
    private readonly securityEvents: SecurityEventService,
    private readonly productEvents: ProductEventService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  // ── Who may ───────────────────────────────────────────────────────────

  async canSetUp(ctx: SetupContext): Promise<boolean> {
    if (!ctx.organizationId) return false;
    const member = await this.prisma.organizationMember.findFirst({
      where: { userId: ctx.userId, organizationId: ctx.organizationId, deactivatedAt: null },
      select: { role: true },
    });
    return member?.role === 'ADMIN' || member?.role === 'EDITOR';
  }

  // ── Find ──────────────────────────────────────────────────────────────

  async find(ctx: SetupContext, args: { query?: string; limit?: number }): Promise<SetupCallResult> {
    const words = String(args.query ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 1);
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);
    const installed = new Set(
      (
        await this.prisma.connector.findMany({
          where: { organizationId: ctx.organizationId },
          select: { config: true },
        })
      )
        .map((c) => (c.config as { adapterSlug?: string } | null)?.adapterSlug)
        .filter((s): s is string => !!s),
    );

    const scored = this.adapters
      .listAll()
      .filter((a) => !isExcludedAdapterSlug(a.slug))
      .map((a) => {
        const name = a.name.toLowerCase();
        const text = `${a.slug} ${name} ${a.category} ${a.description}`.toLowerCase();
        let score = 0;
        for (const w of words) {
          if (a.slug === w || name === w) score += 10;
          else if (a.slug.startsWith(w) || name.split(/\s+/).some((n) => n.startsWith(w))) score += 5;
          else if (text.includes(w)) score += 1;
        }
        return { a, score: words.length ? score : (a.priority ?? 0) };
      })
      .filter((x) => !words.length || x.score > 0)
      .sort((x, y) => y.score - x.score || (y.a.priority ?? 0) - (x.a.priority ?? 0))
      .slice(0, limit);

    const usage = await this.licenseGuard.getUsage(ctx.userId, ctx.organizationId).catch(() => null);
    return {
      body: {
        results: scored.map(({ a }) => {
          const full = this.adapters.describe(a.slug);
          const vars = full.envVars.filter((v) => !v.advanced);
          return {
            adapter: a.slug,
            name: a.name,
            description: a.description,
            alreadyInstalled: installed.has(a.slug),
            setup:
              full.setupKind === 'none'
                ? 'Nothing to enter: installs and works right away.'
                : full.setupKind === 'oauth_browser'
                  ? 'Needs the user\'s own app keys and a sign-in at the provider, done on a page AnythingMCP links to.'
                  : 'Needs credentials the user enters on a page AnythingMCP links to.',
            settingsYouMayPass: vars
              .filter((v) => !v.secret)
              .map((v) => ({ name: v.name, label: v.label, required: v.required, help: v.help, example: v.example })),
            enteredByTheUserOnTheLinkedPage: vars.filter((v) => v.secret).map((v) => v.label),
          };
        }),
        ...(usage?.connectors?.max != null
          ? { connectorsLeftOnThisPlan: Math.max(0, usage.connectors.max - usage.connectors.current) }
          : {}),
        next: 'Confirm the choice with the user, then call setup_install_connector with the adapter id (and any settings listed above). Never ask for passwords, API keys or tokens in the chat.',
      },
    };
  }

  // ── Install ───────────────────────────────────────────────────────────

  async install(
    ctx: SetupContext,
    args: { adapter?: string; settings?: Record<string, unknown> },
  ): Promise<SetupCallResult> {
    const slug = String(args.adapter ?? '').trim();
    let definition: ReturnType<AdaptersService['describe']>;
    try {
      if (!slug || isExcludedAdapterSlug(slug)) throw new Error('unknown');
      definition = this.adapters.describe(slug);
    } catch {
      return { isError: true, body: { error: `No catalog connector '${slug}'. Use setup_find_connectors to get its id.` } };
    }

    const descriptors = new Map(describeAdapterEnvVars(definition).map((d) => [d.name, d]));
    const settings: Record<string, string> = {};
    for (const [name, value] of Object.entries(args.settings ?? {})) {
      const d = descriptors.get(name);
      if (!d) {
        return { isError: true, body: { error: `'${name}' is not a setting of ${definition.name}. Settings: ${[...descriptors.keys()].join(', ') || 'none'}.` } };
      }
      if (d.secret) {
        return {
          isError: true,
          body: {
            error: `'${d.label}' is a secret and is never taken from the chat. Install without it; the user enters it on the page linked in the answer.`,
          },
        };
      }
      if (value !== undefined && value !== null && String(value).trim() !== '') settings[name] = String(value).trim();
    }

    if (!this.takeInstallSlot(ctx.userId)) {
      return { isError: true, body: { error: `At most ${INSTALLS_PER_HOUR} connectors an hour can be installed from a chat. Try again later or use the dashboard.` } };
    }
    try {
      await this.licenseGuard.checkCanCreateConnector(ctx.userId, ctx.organizationId);
    } catch (err: any) {
      return { isError: true, body: await this.planLimitAnswer(ctx, String(err?.message ?? err)) };
    }

    let imported: Awaited<ReturnType<AdaptersService['importAdapter']>>;
    try {
      imported = await this.adapters.importAdapter(slug, ctx.userId, ctx.organizationId, settings);
    } catch (err: any) {
      return { isError: true, body: { error: String(err?.message ?? err) } };
    }
    await this.attachToGrantedServers(ctx, imported.connectorId);
    await this.securityEvents.log({
      event: SecurityEvents.CONNECTOR_INSTALLED_VIA_MCP,
      actorType: 'USER',
      actorUserId: ctx.userId,
      organizationId: ctx.organizationId,
      metadata: { adapter: slug, connectorId: imported.connectorId, settings: Object.keys(settings) },
    });
    await this.productEvents.log({
      event: ProductEvents.SETUP_COMPLETED,
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      metadata: { adapterSlug: slug, via: 'mcp' },
    });

    const state = await this.connectorState(imported.connectorId);
    if (state.status === 'ready') {
      return {
        body: {
          installed: definition.name,
          status: 'ready',
          tools: definition.tools.length,
          ...(imported.probe ? { firstCall: imported.probe.ok ? 'worked' : imported.probe.message } : {}),
          next: 'Its tools are available now: find them with anythingmcp_search_tools.',
        },
      };
    }
    const link = await this.createLink(ctx, imported.connectorId);
    return {
      body: {
        installed: definition.name,
        status: state.status,
        whatTheUserDoes:
          state.status === 'needs_authorization'
            ? `Open the link, then sign in to ${definition.name} and approve. It takes a minute.`
            : `Open the link and enter ${state.missing.map((m) => descriptors.get(m)?.label ?? m).join(', ')}${
                needsBrowserAuthorization(definition)
                  ? `, then sign in to ${definition.name} and approve`
                  : ''
              }.`,
        finishSetupUrl: link,
        linkValidFor: '30 minutes, for this user only',
        next: 'Give the user the link. When they say they are done, call setup_get_status.',
      },
    };
  }

  /**
   * The plan's connector limit stopped an install. Billing is mentioned here
   * and only here: the answer is the reason the request failed, with the one
   * page that lifts the limit. An admin on the free trial gets the card-trial
   * offer (nothing charged before the trial ends); other admins the licence
   * page; members are told who can do it.
   */
  private async planLimitAnswer(ctx: SetupContext, reason: string): Promise<Record<string, unknown>> {
    const member = await this.prisma.organizationMember
      .findFirst({
        where: { userId: ctx.userId, organizationId: ctx.organizationId, deactivatedAt: null },
        select: { role: true },
      })
      .catch(() => null);
    if (member?.role !== 'ADMIN') {
      return { error: reason, whatTheUserCanDo: 'Ask a workspace administrator to upgrade the plan, or remove a connector they no longer need.' };
    }
    const usage = await this.licenseGuard.getUsage(ctx.userId, ctx.organizationId).catch(() => null);
    const onTrial = usage?.plan === 'trial';
    return {
      error: reason,
      whatTheUserCanDo: onTrial
        ? 'Add a card to continue the trial on the full plan (nothing is charged before the trial ends), or remove a connector.'
        : 'Choose a plan with more connectors, or remove a connector.',
      upgradeUrl: `${ctx.dashboardBase}${onTrial ? '/start-trial' : '/settings/license'}`,
    };
  }

  // ── Status ────────────────────────────────────────────────────────────

  async status(ctx: SetupContext): Promise<SetupCallResult> {
    const rows = await this.prisma.connector.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, name: true, authType: true, authConfig: true, baseUrl: true, headers: true, envVars: true, config: true, createdAt: true },
    });
    const out = [];
    for (const r of rows) {
      const state = this.stateOf(r);
      out.push({
        name: r.name,
        status: state.status,
        ...(state.status !== 'ready' ? { finishSetupUrl: await this.createLink(ctx, r.id) } : {}),
      });
    }
    return {
      body: {
        connectors: out,
        ...(out.length === 0 ? { hint: 'No connectors yet: use setup_find_connectors.' } : {}),
      },
    };
  }

  // ── Links ─────────────────────────────────────────────────────────────

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** A fresh one-time link to finish this connector, for this user. */
  async createLink(ctx: Pick<SetupContext, 'userId' | 'organizationId' | 'dashboardBase'>, connectorId: string): Promise<string> {
    const token = randomBytes(24).toString('base64url');
    await this.prisma.connectorSetupLink.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => undefined);
    await this.prisma.connectorSetupLink.create({
      data: {
        tokenHash: this.hash(token),
        connectorId,
        userId: ctx.userId,
        organizationId: ctx.organizationId,
        expiresAt: new Date(Date.now() + SETUP_LINK_TTL_MS),
      },
    });
    return `${ctx.dashboardBase}/s/${token}`;
  }

  /**
   * Open a link: valid, unused, not expired, and opened by the user it was
   * made for. Marks it used and returns where the dashboard should go.
   */
  async resolveLink(token: string, userId: string): Promise<{ redirect: string } | { error: string }> {
    const row = await this.prisma.connectorSetupLink.findUnique({ where: { tokenHash: this.hash(String(token || '')) } });
    if (!row || row.expiresAt.getTime() < Date.now()) {
      return { error: 'This link has expired. Ask your AI client for a new one, or open the connector in the dashboard.' };
    }
    if (row.userId !== userId) {
      return { error: 'This link was made for another account. Sign in as that account.' };
    }
    if (row.usedAt) {
      return { error: 'This link was already used. Ask your AI client for a new one, or open the connector in the dashboard.' };
    }
    await this.prisma.connectorSetupLink.update({ where: { id: row.id }, data: { usedAt: new Date() } });
    const connector = await this.prisma.connector.findFirst({
      where: { id: row.connectorId, organizationId: row.organizationId },
      select: { id: true, config: true },
    });
    if (!connector) return { error: 'This connector no longer exists.' };
    const slug = (connector.config as { adapterSlug?: string } | null)?.adapterSlug;
    return {
      redirect: slug
        ? `/connectors/setup/${encodeURIComponent(slug)}?connector=${encodeURIComponent(connector.id)}&from=claude`
        : `/connectors/${encodeURIComponent(connector.id)}`,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private takeInstallSlot(userId: string, now = Date.now()): boolean {
    const recent = (this.installs.get(userId) ?? []).filter((t) => now - t < 60 * 60 * 1000);
    if (recent.length >= INSTALLS_PER_HOUR) {
      this.installs.set(userId, recent);
      return false;
    }
    recent.push(now);
    this.installs.set(userId, recent);
    return true;
  }

  /**
   * importAdapter put the connector on the user's own server. The connection
   * may be granted a different one (a teammate's, a picked one): put it there
   * too, or the chat that installed it would not see it.
   */
  private async attachToGrantedServers(ctx: SetupContext, connectorId: string): Promise<void> {
    if (ctx.serverIds.length === 0) return;
    const servers = await this.prisma.mcpServerConfig.findMany({
      where: { id: { in: ctx.serverIds }, organizationId: ctx.organizationId, isActive: true },
      select: { id: true },
    });
    for (const s of servers) {
      await this.prisma.mcpServerConnector
        .create({ data: { mcpServerId: s.id, connectorId } })
        .catch(() => undefined); // already there
    }
  }

  private async connectorState(connectorId: string) {
    const row = await this.prisma.connector.findUnique({
      where: { id: connectorId },
      select: { authType: true, authConfig: true, baseUrl: true, headers: true, envVars: true, config: true },
    });
    return row ? this.stateOf(row) : { status: 'needs_input' as const, missing: [] as string[] };
  }

  private stateOf(row: {
    authType: string;
    authConfig: string | null;
    baseUrl: string;
    headers: unknown;
    envVars: unknown;
    config: unknown;
  }) {
    let authConfig: unknown;
    try {
      authConfig = row.authConfig ? JSON.parse(decrypt(row.authConfig, process.env.ENCRYPTION_KEY || '')) : undefined;
    } catch {
      authConfig = undefined;
    }
    return computeSetupState({
      authType: row.authType,
      authConfig,
      baseUrl: row.baseUrl,
      headers: row.headers,
      envVars: row.envVars,
      config: row.config,
    });
  }
}
