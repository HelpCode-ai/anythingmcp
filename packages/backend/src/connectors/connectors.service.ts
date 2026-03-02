import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma.service';
import { Connector, ConnectorType, AuthType } from '../generated/prisma/client';
import { RestEngine } from './engines/rest.engine';
import { SoapEngine } from './engines/soap.engine';
import { GraphqlEngine } from './engines/graphql.engine';
import { encrypt, decrypt } from '../common/crypto/encryption.util';

@Injectable()
export class ConnectorsService {
  private readonly logger = new Logger(ConnectorsService.name);
  private readonly encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly restEngine: RestEngine,
    private readonly soapEngine: SoapEngine,
    private readonly graphqlEngine: GraphqlEngine,
  ) {
    this.encryptionKey =
      this.configService.get<string>('ENCRYPTION_KEY') ||
      'default-dev-key-change-in-prod!!';
  }

  async findAllByUser(userId: string): Promise<Connector[]> {
    return this.prisma.connector.findMany({
      where: { userId },
      include: { tools: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(id: string, userId: string): Promise<Connector> {
    const connector = await this.prisma.connector.findFirst({
      where: { id, userId },
      include: { tools: true, resources: true, prompts: true },
    });
    if (!connector) {
      throw new NotFoundException(`Connector ${id} not found`);
    }
    return connector;
  }

  async findByIdInternal(id: string): Promise<Connector> {
    const connector = await this.prisma.connector.findUnique({
      where: { id },
      include: { tools: true },
    });
    if (!connector) {
      throw new NotFoundException(`Connector ${id} not found`);
    }
    return connector;
  }

  async create(
    userId: string,
    data: {
      name: string;
      type: ConnectorType;
      baseUrl: string;
      authType?: AuthType;
      authConfig?: Record<string, unknown>;
      specUrl?: string;
      headers?: Record<string, string>;
      config?: Record<string, unknown>;
      envVars?: Record<string, string>;
    },
  ): Promise<Connector> {
    const encryptedAuth = data.authConfig
      ? encrypt(JSON.stringify(data.authConfig), this.encryptionKey)
      : null;

    return this.prisma.connector.create({
      data: {
        userId,
        name: data.name,
        type: data.type,
        baseUrl: data.baseUrl,
        authType: data.authType || 'NONE',
        authConfig: encryptedAuth,
        specUrl: data.specUrl,
        headers: data.headers as any,
        config: data.config as any,
        envVars: data.envVars as any,
      },
    });
  }

  async update(
    id: string,
    userId: string,
    data: Partial<{
      name: string;
      baseUrl: string;
      authType: AuthType;
      authConfig: Record<string, unknown>;
      isActive: boolean;
      headers: Record<string, string>;
      config: Record<string, unknown>;
      envVars: Record<string, string>;
    }>,
  ): Promise<Connector> {
    await this.findById(id, userId);

    const updateData: any = { ...data };
    if (data.authConfig) {
      updateData.authConfig = encrypt(
        JSON.stringify(data.authConfig),
        this.encryptionKey,
      );
    }

    return this.prisma.connector.update({
      where: { id },
      data: updateData,
    });
  }

  async remove(id: string, userId: string): Promise<void> {
    await this.findById(id, userId);
    await this.prisma.connector.delete({ where: { id } });
  }

  async testConnection(
    id: string,
    userId: string,
  ): Promise<{ ok: boolean; message: string }> {
    const connector = await this.findById(id, userId);

    try {
      const authConfig = connector.authConfig
        ? JSON.parse(decrypt(connector.authConfig, this.encryptionKey))
        : undefined;

      switch (connector.type) {
        case 'REST':
          await this.restEngine.execute(
            {
              baseUrl: connector.baseUrl,
              authType: connector.authType,
              authConfig,
              headers: connector.headers as Record<string, string>,
            },
            { method: 'GET', path: '/' },
            {},
          );
          break;
        case 'GRAPHQL':
          await this.graphqlEngine.execute(
            {
              baseUrl: connector.baseUrl,
              authType: connector.authType,
              authConfig,
              headers: connector.headers as Record<string, string>,
            },
            { method: 'query', path: '{ __typename }' },
            {},
          );
          break;
        default:
          return {
            ok: true,
            message: `Connection type ${connector.type} — test not yet implemented`,
          };
      }
      return { ok: true, message: 'Connection successful' };
    } catch (error: any) {
      return { ok: false, message: error.message || 'Connection failed' };
    }
  }

  async executeConnectorCall(
    connector: Connector,
    endpointMapping: {
      method: string;
      path: string;
      queryParams?: Record<string, unknown>;
      bodyMapping?: Record<string, unknown>;
      headers?: Record<string, string>;
    },
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const authConfig = connector.authConfig
      ? JSON.parse(decrypt(connector.authConfig, this.encryptionKey))
      : undefined;

    const config = {
      baseUrl: connector.baseUrl,
      authType: connector.authType,
      authConfig,
      headers: connector.headers as Record<string, string>,
      specUrl: connector.specUrl ?? undefined,
    };

    // Inject env vars as parameter defaults
    const envVars = connector.envVars as Record<string, string> | undefined;
    const mergedParams = envVars
      ? { ...params, ...Object.fromEntries(
          Object.entries(envVars).filter(([k]) => params[k] === undefined),
        ) }
      : params;

    switch (connector.type) {
      case 'REST':
        return this.restEngine.execute(config, endpointMapping, mergedParams);
      case 'SOAP':
        return this.soapEngine.execute(config, endpointMapping, mergedParams);
      case 'GRAPHQL':
        return this.graphqlEngine.execute(config, endpointMapping, mergedParams);
      default:
        throw new NotFoundException(
          `Connector type '${connector.type}' not yet implemented`,
        );
    }
  }

  getDecryptedAuthConfig(
    connector: Connector,
  ): Record<string, unknown> | undefined {
    if (!connector.authConfig) return undefined;
    return JSON.parse(decrypt(connector.authConfig, this.encryptionKey));
  }
}
