import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import type {
  IdentityProviderType,
  RoleSyncSource,
  RoleSyncFallback,
  UserRole,
} from '../generated/prisma/client';
import { DeploymentService } from '../common/deployment.service';
import { encrypt, decrypt } from '../common/crypto/encryption.util';
import { getRequiredSecret } from '../common/secrets.util';
import { assertSafeOutboundUrl } from '../common/ssrf.util';
import {
  parseProviderConfig,
  deriveIssuer,
  assertIssuerAllowed,
  ProviderConfigError,
  IssuerNotAllowedError,
} from './provider-config';

export class IdentityProviderError extends Error {}

export interface UpsertProviderInput {
  // Typed from the generated Prisma enum, not `string`: a typo or a new enum
  // value then fails at COMPILE time instead of surfacing as a runtime Prisma
  // error, and the controller's list is derived from the same source.
  type: IdentityProviderType;
  name: string;
  clientId: string;
  /** Omitted on update = keep the stored secret. */
  clientSecret?: string;
  clientSecretExpiresAt?: string | null;
  /** Only used by types with no derivable issuer (OKTA, AUTH0, OIDC). */
  issuer?: string;
  config?: Record<string, unknown>;
  isActive?: boolean;
  jitProvisioning?: boolean;
  jitDefaultRole?: UserRole;
  roleSyncEnabled?: boolean;
  roleSyncSource?: RoleSyncSource;
  roleSyncFallback?: RoleSyncFallback;
  roleSyncDefaultRoleIds?: string[];
  enforceSso?: boolean;
}

/** Shape returned to the API. Never carries the client secret. */
const PUBLIC_SELECT = {
  id: true,
  type: true,
  name: true,
  isActive: true,
  issuer: true,
  clientId: true,
  clientSecretExpiresAt: true,
  initiateId: true,
  jitProvisioning: true,
  jitDefaultRole: true,
  roleSyncEnabled: true,
  roleSyncSource: true,
  roleSyncFallback: true,
  roleSyncDefaultRoleIds: true,
  enforceSso: true,
  lastSuccessfulLoginAt: true,
  config: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class IdentityProvidersService {
  private readonly logger = new Logger(IdentityProvidersService.name);
  private readonly encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly deployment: DeploymentService,
  ) {
    this.encryptionKey = getRequiredSecret(
      'ENCRYPTION_KEY',
      process.env.ENCRYPTION_KEY,
    );
  }

  /**
   * Binds a ciphertext to the row it belongs to. Without it, a client secret
   * blob could be copied into another organization's provider and would still
   * decrypt — the key is instance-wide.
   */
  /**
   * Parses an expiry, refusing anything `new Date()` cannot make sense of.
   *
   * `@IsISO8601({strict:true})` is not enough: validator.js's `strict` checks
   * that the DATE is real (rejecting 2026-02-30), not that the format is the
   * extended one, so compact forms like "20260101" and week dates like
   * "2026-W01-1" pass validation and then reach Prisma as an Invalid Date —
   * a 500 instead of a 400.
   */
  private parseExpiry(value: string): Date {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new IdentityProviderError(
        'clientSecretExpiresAt must be an ISO 8601 date, e.g. 2027-01-31T00:00:00Z',
      );
    }
    return parsed;
  }

  private aadFor(providerId: string, organizationId: string): string {
    return `idp_client_secret:${providerId}:${organizationId}`;
  }

  async findAll(organizationId: string) {
    return this.prisma.identityProvider.findMany({
      where: { organizationId },
      select: { ...PUBLIC_SELECT, _count: { select: { roleMappings: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Always resolve by (id, org) so an id from another workspace 404s. */
  async findByIdForOrg(id: string, organizationId: string) {
    return this.prisma.identityProvider.findFirst({
      where: { id, organizationId },
      select: PUBLIC_SELECT,
    });
  }

  async create(organizationId: string, input: UpsertProviderInput) {
    const { issuer, config } = this.resolveIssuerAndConfig(input);

    if (!input.clientSecret) {
      throw new IdentityProviderError('clientSecret is required');
    }

    // The row must exist before the secret can be bound to its id, so create
    // it without the secret and attach the ciphertext immediately after. Both
    // happen in one transaction, so a provider is never persisted in a
    // half-configured state.
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.identityProvider.create({
        data: {
          organizationId,
          type: input.type,
          name: input.name,
          issuer,
          clientId: input.clientId,
          initiateId: randomBytes(24).toString('base64url'),
          config: config as any,
          isActive: input.isActive ?? true,
          jitProvisioning: input.jitProvisioning ?? false,
          jitDefaultRole: this.cappedJitRole(input.jitDefaultRole),
          roleSyncEnabled: input.roleSyncEnabled ?? false,
          roleSyncSource: input.roleSyncSource ?? 'GROUPS',
          roleSyncFallback: input.roleSyncFallback ?? 'DENY_ALL',
          roleSyncDefaultRoleIds: input.roleSyncDefaultRoleIds ?? [],
          clientSecretExpiresAt: input.clientSecretExpiresAt
            ? this.parseExpiry(input.clientSecretExpiresAt)
            : null,
        },
        select: { id: true },
      });

      const updated = await tx.identityProvider.update({
        where: { id: created.id },
        data: {
          clientSecretEnc: encrypt(
            input.clientSecret!,
            this.encryptionKey,
            this.aadFor(created.id, organizationId),
          ),
        },
        select: PUBLIC_SELECT,
      });
      return updated;
    });
  }

  async update(id: string, organizationId: string, input: UpsertProviderInput) {
    const existing = await this.prisma.identityProvider.findFirst({
      where: { id, organizationId },
      select: { id: true, type: true, config: true },
    });
    if (!existing) return null;

    // The type is fixed after creation: changing it would leave the stored
    // `config` validated against the wrong schema, and the issuer pointing at
    // a host the new type does not permit.
    if (input.type && input.type !== existing.type) {
      throw new IdentityProviderError(
        'Provider type cannot be changed. Create a new provider instead.',
      );
    }

    // SECURITY: fall back to the STORED config when the caller omits it.
    // Every other optional field here is `undefined` when omitted, so Prisma
    // skips it and the stored value survives — `config` was the one field
    // where omission destroyed. For GOOGLE that silently dropped
    // `hostedDomain`, the only thing making Google authoritative for a
    // non-gmail address, so toggling `isActive` off and on would widen sign-in
    // to every Google account on the internet. Same shape for GitHub's
    // `organization` and OIDC's `groupsClaimName`.
    const { issuer, config } = this.resolveIssuerAndConfig({
      ...input,
      type: existing.type,
      config: input.config ?? (existing.config as Record<string, unknown>),
    });

    // Org scope in the WRITE, not only in the check above: `delete()` already
    // does this, and check-then-act is one careless refactor from a
    // cross-tenant write.
    await this.prisma.identityProvider.updateMany({
      where: { id, organizationId },
      data: {
        name: input.name,
        issuer,
        clientId: input.clientId,
        config: config as any,
        isActive: input.isActive,
        jitProvisioning: input.jitProvisioning,
        jitDefaultRole: this.cappedJitRole(input.jitDefaultRole),
        roleSyncEnabled: input.roleSyncEnabled,
        roleSyncSource: input.roleSyncSource,
        roleSyncFallback: input.roleSyncFallback,
        roleSyncDefaultRoleIds: input.roleSyncDefaultRoleIds,
        // `null` clears it; omitting the key keeps the stored value. Without
        // the null branch a stale expiry could never be removed and the
        // renewal reminder would keep reporting a date that no longer applies
        // after a rotation.
        clientSecretExpiresAt:
          input.clientSecretExpiresAt === null
            ? null
            : input.clientSecretExpiresAt
              ? this.parseExpiry(input.clientSecretExpiresAt)
              : undefined,
        // An empty secret means "keep the stored one", so an admin can edit the
        // name or a toggle without re-entering a credential the API never
        // returned to them in the first place.
        ...(input.clientSecret
          ? {
              clientSecretEnc: encrypt(
                input.clientSecret,
                this.encryptionKey,
                this.aadFor(id, organizationId),
              ),
            }
          : {}),
      },
    });

    // `updateMany` cannot `select`, so read the row back through the same
    // org-scoped helper every other read path uses.
    return this.findByIdForOrg(id, organizationId);
  }

  async delete(id: string, organizationId: string): Promise<boolean> {
    const result = await this.prisma.identityProvider.deleteMany({
      where: { id, organizationId },
    });
    return result.count > 0;
  }

  /** Decrypts the stored secret. Only ever called server-side. */
  async getClientSecret(
    id: string,
    organizationId: string,
  ): Promise<string | null> {
    const row = await this.prisma.identityProvider.findFirst({
      where: { id, organizationId },
      select: { clientSecretEnc: true },
    });
    if (!row?.clientSecretEnc) return null;
    return decrypt(
      row.clientSecretEnc,
      this.encryptionKey,
      this.aadFor(id, organizationId),
    );
  }

  /**
   * Fetches the provider's discovery document, proving the issuer is reachable
   * and really is who it claims to be. The equivalent of `POST smtp/test`:
   * misconfiguration should surface here, not at a user's first sign-in.
   */
  async testConnection(
    id: string,
    organizationId: string,
  ): Promise<{ ok: boolean; message: string; details?: Record<string, unknown> }> {
    const provider = await this.findByIdForOrg(id, organizationId);
    if (!provider) return { ok: false, message: 'Provider not found' };

    if (provider.type === 'GITHUB') {
      return {
        ok: true,
        message:
          'GitHub is not an OIDC provider and publishes no discovery document, so there is nothing to probe. Credentials are verified at first sign-in.',
      };
    }

    const discoveryUrl = `${provider.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;

    try {
      // Re-check the host even though it was checked on write: the allowlist
      // may have tightened since, and this is the call that actually leaves
      // the server.
      assertIssuerAllowed(provider.type, provider.issuer, {
        allowArbitraryIssuer: this.deployment.isSelfHosted(),
      });
      // Blocks loopback, link-local (including cloud metadata) and private
      // ranges, resolving DNS so a public name pointing inward is caught too.
      await assertSafeOutboundUrl(discoveryUrl);

      const response = await fetch(discoveryUrl, {
        redirect: 'error', // a redirect could walk us off the allowlisted host
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        return {
          ok: false,
          message: `Discovery document returned HTTP ${response.status}`,
        };
      }

      // Cap the body. `AbortSignal.timeout` bounds wall-clock, not bytes, so a
      // hostile endpoint answering with an endless chunked body would be
      // buffered whole into the heap of a shared, multi-tenant process. A
      // discovery document is a couple of kilobytes.
      const body = await this.readCapped(response, 256 * 1024);
      const doc: any = JSON.parse(body);
      if (doc.issuer !== provider.issuer) {
        return {
          ok: false,
          message: `Issuer mismatch: the document declares '${doc.issuer}' but this provider is configured for '${provider.issuer}'`,
        };
      }

      return {
        ok: true,
        message: 'Discovery document reachable and issuer matches',
        details: {
          authorizationEndpoint: doc.authorization_endpoint,
          tokenEndpoint: doc.token_endpoint,
          jwksUri: doc.jwks_uri,
        },
      };
    } catch (error: any) {
      // The detail stays in the logs. SsrfBlockedError messages embed the
      // RESOLVED address ("resolves to non-public address '10.0.3.7'"), so
      // returning them verbatim would turn this endpoint into an internal DNS
      // and address-range oracle for any workspace admin.
      this.logger.warn(
        `Identity provider test failed for ${id}: ${error?.message}`,
      );
      return {
        ok: false,
        message:
          'Could not reach the provider discovery document. Check the issuer and credentials.',
      };
    }
  }

  /** Reads a response body, refusing anything over `maxBytes`. */
  private async readCapped(response: Response, maxBytes: number) {
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Discovery document exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf-8');
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * JIT provisioning may never mint an ADMIN or EDITOR. Anyone able to
   * authenticate at the external tenant would otherwise arrive with write
   * access — or, as ADMIN, with the power to rewrite the SSO configuration
   * that let them in.
   *
   * Rejected rather than silently downgraded: an admin who asked for EDITOR
   * should learn that it is refused, not discover later that it did not stick.
   */
  private cappedJitRole(role?: UserRole): UserRole | undefined {
    if (role === undefined) return undefined;
    if (role !== 'VIEWER') {
      throw new IdentityProviderError(
        'Just-in-time provisioning can only grant VIEWER. Promote users explicitly after they first sign in.',
      );
    }
    return 'VIEWER';
  }

  private resolveIssuerAndConfig(input: UpsertProviderInput) {
    let config: Record<string, unknown>;
    try {
      config = parseProviderConfig(input.type, input.config);
    } catch (e) {
      if (e instanceof ProviderConfigError) {
        throw new IdentityProviderError(e.message);
      }
      throw e;
    }

    const derived = deriveIssuer(input.type, config);
    const issuer = derived ?? input.issuer;
    if (!issuer) {
      throw new IdentityProviderError(
        `An issuer is required for provider type ${input.type}`,
      );
    }

    try {
      assertIssuerAllowed(input.type, issuer, {
        // A free-form issuer means a server-side fetch to a host the workspace
        // admin picked. Acceptable where they already own the infrastructure;
        // disproportionate in a shared, multi-tenant deployment.
        allowArbitraryIssuer: this.deployment.isSelfHosted(),
      });
    } catch (e) {
      if (e instanceof IssuerNotAllowedError) {
        throw new IdentityProviderError(e.message);
      }
      throw e;
    }

    return { issuer, config };
  }

  // ── Role mappings ─────────────────────────────────────────────────────────

  /**
   * The provider's group/app-role mappings, ordered by label so the admin
   * table is stable across reloads.
   */
  async listRoleMappings(providerId: string, organizationId: string) {
    const provider = await this.prisma.identityProvider.findFirst({
      where: { id: providerId, organizationId },
      select: { id: true },
    });
    if (!provider) return null;
    return this.prisma.identityProviderRoleMapping.findMany({
      where: { providerId },
      select: {
        id: true,
        externalId: true,
        label: true,
        userRole: true,
        mcpRoleIds: true,
      },
      orderBy: [{ label: 'asc' }, { externalId: 'asc' }],
    });
  }

  /**
   * Replaces the whole mapping set in one transaction.
   *
   * Whole-set rather than per-row CRUD on purpose: a half-applied edit to an
   * authorization table is a state nobody can reason about, and the audit
   * event for "these are now the rules" is far easier to read during an
   * investigation than a stream of individual adds and removes.
   */
  async replaceRoleMappings(
    providerId: string,
    organizationId: string,
    mappings: {
      externalId: string;
      label?: string | null;
      userRole?: UserRole | null;
      mcpRoleIds?: string[];
    }[],
  ) {
    const provider = await this.prisma.identityProvider.findFirst({
      where: { id: providerId, organizationId },
      select: { id: true },
    });
    if (!provider) return null;

    const seen = new Set<string>();
    for (const m of mappings) {
      const id = m.externalId?.trim();
      if (!id) {
        throw new IdentityProviderError('Every mapping needs a group or app role id');
      }
      // @@unique([providerId, externalId]) would reject this anyway, but as a
      // P2002 mid-transaction rather than a message naming the duplicate.
      if (seen.has(id)) {
        throw new IdentityProviderError(`Duplicate mapping for "${id}"`);
      }
      seen.add(id);
    }

    // Roles are re-checked against the workspace here rather than only at
    // sync time, so an admin gets a 400 while editing instead of a mapping
    // that silently grants nothing months later.
    const referenced = [...new Set(mappings.flatMap((m) => m.mcpRoleIds ?? []))];
    if (referenced.length > 0) {
      const visible = await this.prisma.role.count({
        where: {
          id: { in: referenced },
          OR: [{ organizationId }, { isSystem: true }],
        },
      });
      if (visible !== referenced.length) {
        throw new IdentityProviderError(
          'One or more MCP roles do not exist in this workspace',
        );
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.identityProviderRoleMapping.deleteMany({ where: { providerId } });
      if (mappings.length > 0) {
        await tx.identityProviderRoleMapping.createMany({
          data: mappings.map((m) => ({
            providerId,
            externalId: m.externalId.trim(),
            label: m.label?.trim() || null,
            userRole: m.userRole ?? null,
            mcpRoleIds: m.mcpRoleIds ?? [],
          })),
        });
      }
    });

    return this.listRoleMappings(providerId, organizationId);
  }

  // ── SSO enforcement ───────────────────────────────────────────────────────

  /**
   * Turns password sign-in off (or back on) for a workspace.
   *
   * Separate from `update()` on purpose. This is the one setting that can lock
   * every human out of a workspace, so it does not travel in the same payload
   * as a display-name change — and enabling it has preconditions that a general
   * update path would have to special-case anyway.
   *
   * Two preconditions, both about having a way back in:
   *
   *  - the provider must have completed a real dashboard sign-in, so the
   *    configuration is known to work rather than merely believed to;
   *  - the admin flipping the switch must hold unused recovery codes, so a
   *    directory that breaks tomorrow is an inconvenience and not an outage.
   *
   * Disabling is ungated: removing a lockout risk never needs permission.
   */
  async setEnforceSso(
    providerId: string,
    organizationId: string,
    enforce: boolean,
    actor: { userId: string; hasRecoveryCodes: boolean },
  ) {
    const provider = await this.prisma.identityProvider.findFirst({
      where: { id: providerId, organizationId },
      select: {
        id: true,
        isActive: true,
        enforceSso: true,
        lastSuccessfulLoginAt: true,
      },
    });
    if (!provider) return null;

    if (enforce) {
      if (!provider.isActive) {
        throw new IdentityProviderError(
          'Activate this provider before requiring single sign-on — an inactive provider cannot be signed in through.',
        );
      }
      if (!provider.lastSuccessfulLoginAt) {
        throw new IdentityProviderError(
          'Sign in through this provider at least once before requiring it. Until that succeeds there is no evidence the configuration works.',
        );
      }
      if (!actor.hasRecoveryCodes) {
        throw new IdentityProviderError(
          'Generate recovery codes for your account first. Without them, a directory outage would leave this workspace with no way in.',
        );
      }
    }

    return this.prisma.identityProvider.update({
      where: { id: providerId },
      data: { enforceSso: enforce },
      select: PUBLIC_SELECT,
    });
  }
}
