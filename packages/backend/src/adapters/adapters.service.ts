import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { McpServerService } from '../mcp-server/mcp-server.service';
import { encrypt } from '../common/crypto/encryption.util';
import { ConfigService } from '@nestjs/config';
import { listAdapters, getAdapter, AdapterMeta, AdapterDefinition } from './catalog';
import { hashInstructions } from './catalog-fingerprint';
import { getRequiredSecret } from '../common/secrets.util';

@Injectable()
export class AdaptersService {
  private readonly logger = new Logger(AdaptersService.name);
  private readonly encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mcpServer: McpServerService,
    private readonly configService: ConfigService,
  ) {
    this.encryptionKey = getRequiredSecret(
      'ENCRYPTION_KEY',
      this.configService.get<string>('ENCRYPTION_KEY'),
    );
  }

  listAll(): AdapterMeta[] {
    return listAdapters();
  }

  getBySlug(slug: string): AdapterDefinition {
    const adapter = getAdapter(slug);
    if (!adapter) {
      throw new NotFoundException(`Adapter "${slug}" not found`);
    }
    return adapter;
  }

  async importAdapter(
    slug: string,
    userId: string,
    organizationId: string,
    credentials?: Record<string, string>,
  ): Promise<{ connectorId: string; toolsCreated: number }> {
    const adapter = this.getBySlug(slug);

    // Credentials arrive from the UI verbatim — a stray leading/trailing
    // space (easy to pick up when pasting) would otherwise be encrypted into
    // authConfig and break auth downstream (e.g. Basic Auth 401s that are
    // invisible in the UI because the displayed env var looks correct).
    if (credentials) {
      // Rebuild via Object.fromEntries (no dynamic user-keyed property write)
      // so a pasted leading/trailing space in a credential can't survive into
      // the encrypted authConfig and break auth.
      credentials = Object.fromEntries(
        Object.entries(credentials).map(([k, v]) => [
          k,
          typeof v === 'string' ? v.trim() : v,
        ]),
      ) as Record<string, string>;
    }

    // Resolve {{VAR}} placeholders in authConfig with provided credentials
    const resolvedAuthConfig = adapter.connector.authConfig
      ? this.resolveTemplate(adapter.connector.authConfig, credentials)
      : null;

    const encryptedAuth = resolvedAuthConfig
      ? encrypt(JSON.stringify(resolvedAuthConfig), this.encryptionKey)
      : null;

    // Resolve {{VAR}} placeholders in baseUrl (e.g. weclapp tenant)
    const resolvedBaseUrl = this.resolveString(adapter.connector.baseUrl, credentials);

    // Resolve {{VAR}} placeholders in static connector headers (e.g. Harvest
    // requires a per-tenant Harvest-Account-Id header on every call).
    const adapterHeaders = (adapter.connector as { headers?: Record<string, string> }).headers;
    const resolvedHeaders = adapterHeaders
      ? (this.resolveTemplate(adapterHeaders, credentials) as Record<string, string>)
      : null;

    // Persist the import credentials as envVars so the engine can use them
    // for runtime $varname substitution inside tool bodies/queries/paths.
    // (authConfig has its own {{VAR}} substitution; envVars covers everything
    // outside auth/baseUrl.)
    const envVarsToPersist = credentials && Object.keys(credentials).length > 0
      ? (credentials as Record<string, unknown>)
      : null;

    const connector = await this.prisma.connector.create({
      data: {
        userId,
        organizationId,
        name: adapter.connector.name,
        type: adapter.connector.type as any,
        baseUrl: resolvedBaseUrl,
        isActive: true,
        authType: (adapter.connector.authType as any) || 'NONE',
        authConfig: encryptedAuth,
        headers: resolvedHeaders as any,
        envVars: envVarsToPersist as any,
        instructions: adapter.instructions || null,
        // Persist the source adapter slug (brand-logo resolution survives a
        // rename) plus the catalog version + instructions baseline at install
        // time, so the catalog re-sync feature can later detect that the
        // catalog has moved on and whether the user has edited instructions.
        config: {
          adapterSlug: slug,
          adapterVersion: adapter.version,
          instructionsBaseline: hashInstructions(adapter.instructions),
        },
      },
    });

    let toolsCreated = 0;

    for (const tool of adapter.tools) {
      try {
        await this.prisma.mcpTool.create({
          data: {
            connectorId: connector.id,
            name: tool.name,
            description: tool.description,
            isEnabled: true,
            // Seed the proxy preference from the adapter spec (default off).
            useProxy: tool.useProxy === true,
            parameters: tool.parameters as any,
            endpointMapping: tool.endpointMapping as any,
            responseMapping: tool.responseMapping as any,
            outputSchema: ((tool as any).outputSchema ?? null) as any,
          },
        });
        toolsCreated++;
      } catch (err: any) {
        if (err.code !== 'P2002') {
          this.logger.warn(`Failed to create tool ${tool.name}: ${err.message}`);
        }
      }
    }

    await this.mcpServer.reloadConnectorTools(connector.id);

    this.logger.log(
      `Imported adapter "${slug}" as connector ${connector.id} with ${toolsCreated} tools`,
    );

    return { connectorId: connector.id, toolsCreated };
  }

  /** Replace {{VAR}} placeholders in a string with credential values */
  private resolveString(
    str: string,
    credentials?: Record<string, string>,
  ): string {
    if (!credentials) return str;
    return str.replace(/\{\{(\w+)\}\}/g, (_, key) => credentials[key] || `{{${key}}}`);
  }

  /** Deep-replace {{VAR}} placeholders in an object/value */
  private resolveTemplate(
    obj: unknown,
    credentials?: Record<string, string>,
  ): unknown {
    if (!credentials) return obj;
    if (typeof obj === 'string') return this.resolveString(obj, credentials);
    if (Array.isArray(obj)) return obj.map((v) => this.resolveTemplate(v, credentials));
    if (obj && typeof obj === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        result[k] = this.resolveTemplate(v, credentials);
      }
      return result;
    }
    return obj;
  }
}
