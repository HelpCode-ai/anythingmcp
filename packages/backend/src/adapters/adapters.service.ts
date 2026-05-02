import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { McpServerService } from '../mcp-server/mcp-server.service';
import { encrypt } from '../common/crypto/encryption.util';
import { ConfigService } from '@nestjs/config';
import { listAdapters, getAdapter, AdapterMeta, AdapterDefinition } from './catalog';
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

    // Resolve {{VAR}} placeholders in authConfig with provided credentials
    const resolvedAuthConfig = adapter.connector.authConfig
      ? this.resolveTemplate(adapter.connector.authConfig, credentials)
      : null;

    const encryptedAuth = resolvedAuthConfig
      ? encrypt(JSON.stringify(resolvedAuthConfig), this.encryptionKey)
      : null;

    // Resolve {{VAR}} placeholders in baseUrl (e.g. weclapp tenant)
    const resolvedBaseUrl = this.resolveString(adapter.connector.baseUrl, credentials);

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
        instructions: adapter.instructions || null,
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
            parameters: tool.parameters as any,
            endpointMapping: tool.endpointMapping as any,
            responseMapping: tool.responseMapping as any,
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
