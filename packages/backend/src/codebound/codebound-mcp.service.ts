import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { plainToInstance, ClassConstructor } from 'class-transformer';
import { validate } from 'class-validator';
import { z } from 'zod';
import { PrismaService } from '../common/prisma.service';
import { McpConnectionGrantService } from '../mcp-servers/mcp-connection-grant.service';
import {
  CODEBOUND_TOOLS,
  CodeboundConnection,
  CodeboundMcpProvider,
  CodeboundRegistry,
} from '../mcp-server/codebound-tools';
import { CodeboundService, ScriptCaller } from './codebound.service';
import { SavedScriptsService } from './saved-scripts.service';
import { RunScriptDto, SaveScriptDto, UpdateScriptDto } from './codebound.dto';

@Injectable()
export class CodeboundMcpService implements CodeboundMcpProvider, OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly grants: McpConnectionGrantService,
    private readonly runner: CodeboundService,
    private readonly scripts: SavedScriptsService,
    private readonly registry: CodeboundRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  private async reachable(connection: CodeboundConnection, id?: string) {
    if (!connection.userId || !connection.organizationId)
      throw new ForbiddenException(
        'An identified workspace member is required.',
      );
    if (
      id &&
      ((connection.endpointServerId && connection.endpointServerId !== id) ||
        (connection.pinnedServerId && connection.pinnedServerId !== id))
    ) {
      throw new NotFoundException(
        'MCP server is not available on this connection.',
      );
    }
    // Re-resolve grants and membership on every operation and nested call.
    // A revoked grant is never treated as the absence of a grant.
    const grant = await this.grants.resolve(
      connection.oauthClientId,
      connection.userId,
    );
    if (grant?.mode === 'none')
      throw new ForbiddenException('This connection has no workspace access.');
    const organizationIds =
      grant?.mode === 'organization'
        ? [grant.organizationId]
        : grant?.mode === 'servers'
          ? [...new Set(grant.servers.map((server) => server.organizationId))]
          : [connection.organizationId];
    const memberships = await this.prisma.organizationMember.findMany({
      where: {
        userId: connection.userId,
        organizationId: { in: organizationIds },
        deactivatedAt: null,
      },
      select: { organizationId: true, role: true },
    });
    const roles = new Map(
      memberships.map((member) => [member.organizationId, member.role]),
    );
    const filters = [
      id,
      connection.endpointServerId,
      connection.pinnedServerId,
    ].filter((value): value is string => !!value);
    const servers = await this.prisma.mcpServerConfig.findMany({
      where: {
        organizationId: { in: [...roles.keys()] },
        isActive: true,
        AND: [
          ...filters.map((serverId) => ({ id: serverId })),
          ...(grant?.mode === 'servers'
            ? [{ id: { in: grant.servers.map((server) => server.id) } }]
            : []),
        ],
      },
      select: { id: true, name: true, organizationId: true },
      orderBy: { id: 'asc' },
      take: 200,
    });
    return servers.map((server) => ({
      ...server,
      role: roles.get(server.organizationId)!,
    }));
  }

  private async target(connection: CodeboundConnection, requestedId?: string) {
    const id =
      requestedId ?? connection.endpointServerId ?? connection.pinnedServerId;
    if (!id)
      throw new BadRequestException(
        'Choose a serverId from codebound_list_tools first.',
      );
    const server = (await this.reachable(connection, id))[0];
    if (!server)
      throw new NotFoundException(
        'MCP server is not available on this connection.',
      );
    const caller: ScriptCaller = {
      sub: connection.userId,
      email: connection.email,
      organizationId: server.organizationId,
      role: server.role,
      authMethod: connection.authMethod,
      apiKeyName: connection.apiKeyName,
    };
    return { server, caller };
  }

  private async dto<T extends object>(
    type: ClassConstructor<T>,
    value: Record<string, unknown>,
  ): Promise<T> {
    const dto = plainToInstance(type, value);
    if (
      (await validate(dto, { whitelist: true, forbidNonWhitelisted: true }))
        .length
    ) {
      throw new BadRequestException(
        'Invalid script fields. Check names, source, input, allowlist and revision.',
      );
    }
    return dto;
  }

  async call(
    connection: CodeboundConnection,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const definition = CODEBOUND_TOOLS.find((tool) => tool.name === name);
    if (!definition) throw new NotFoundException('Codebound tool not found.');
    const parsed = z.strictObject(definition.schema).safeParse(args);
    if (!parsed.success)
      throw new BadRequestException(
        'Invalid arguments for this Codebound tool.',
      );
    const data = parsed.data as Record<string, unknown>;
    const serverId = data.serverId as string | undefined;
    if (
      name === 'codebound_list_tools' &&
      !serverId &&
      !connection.endpointServerId &&
      !connection.pinnedServerId
    ) {
      const servers = await this.reachable(connection);
      return {
        servers: servers.map(({ id, name }) => ({ id, name })),
        next: 'Choose serverId and call codebound_list_tools again for tool schemas.',
      };
    }
    const { server, caller } = await this.target(connection, serverId);
    const checkConnection = async () => {
      await this.target(connection, server.id);
    };
    const tools = await this.runner.listTools(caller, server.id);
    const permitted = new Set(tools.map((tool) => tool.name));
    const canUse = (allowlist: string[]) =>
      allowlist.every((tool) => permitted.has(tool));
    const requireTools = (allowlist: string[]) => {
      if (!canUse(allowlist))
        throw new ForbiddenException(
          "A script tool is unavailable or outside this connection's permissions.",
        );
    };

    if (name === 'codebound_list_tools') {
      const query = ((data.query as string | undefined) ?? '').toLowerCase();
      const matches = tools.filter((tool) =>
        `${tool.name} ${tool.description}`.toLowerCase().includes(query),
      );
      const offset = data.offset as number;
      const limit = data.limit as number;
      return {
        server: { id: server.id, name: server.name },
        tools: matches.slice(offset, offset + limit),
        nextOffset: offset + limit < matches.length ? offset + limit : null,
      };
    }

    if (name === 'codebound_run') {
      const dto = await this.dto(RunScriptDto, {
        code: data.code,
        input: data.input,
        allowedTools: data.allowedTools,
      });
      requireTools(dto.allowedTools);
      return this.runner.run(
        caller,
        server.id,
        dto,
        undefined,
        checkConnection,
      );
    }

    if (name === 'codebound_list_scripts') {
      const offset = data.offset as number;
      const limit = data.limit as number;
      const candidates = await this.prisma.codeboundScript.findMany({
        where: {
          organizationId: caller.organizationId,
          mcpServerId: server.id,
        },
        select: {
          id: true,
          name: true,
          description: true,
          revision: true,
          updatedAt: true,
          allowedTools: true,
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: offset,
        take: limit,
      });
      return {
        items: candidates
          .filter((script) => canUse(script.allowedTools))
          .map(({ allowedTools: _allowlist, ...summary }) => summary),
        nextOffset: candidates.length === limit ? offset + limit : null,
      };
    }

    if (name === 'codebound_save_script') {
      const values = {
        name: data.name,
        description: data.description,
        mcpServerId: server.id,
        code: data.code,
        input: data.input,
        allowedTools: data.allowedTools,
      };
      requireTools(data.allowedTools as string[]);
      if (data.scriptId) {
        if (!data.revision)
          throw new BadRequestException(
            'Updating requires the reviewed revision from codebound_get_script.',
          );
        const existing = await this.scripts.get(
          caller,
          data.scriptId as string,
          server.id,
        );
        requireTools(existing.allowedTools);
        const dto = await this.dto(UpdateScriptDto, {
          ...values,
          revision: data.revision,
        });
        return this.summary(
          await this.scripts.update(caller, existing.id, dto),
        );
      }
      if (data.revision !== undefined)
        throw new BadRequestException(
          'A revision is only valid when updating a scriptId.',
        );
      return this.summary(
        await this.scripts.create(
          caller,
          await this.dto(SaveScriptDto, values),
        ),
      );
    }

    const saved = await this.scripts.get(
      caller,
      data.scriptId as string,
      server.id,
    );
    requireTools(saved.allowedTools);
    if (name === 'codebound_get_script') return saved;
    return this.scripts.run(
      caller,
      saved.id,
      {
        input: (data.input ?? saved.input) as Record<string, unknown>,
        revision: data.revision as number,
      },
      checkConnection,
      server.id,
    );
  }

  private summary(script: {
    id: string;
    name: string;
    mcpServerId: string;
    revision: number;
  }) {
    // The author already has the source. Do not echo it and all default data
    // back into the model context merely to confirm persistence.
    return {
      saved: true,
      id: script.id,
      name: script.name,
      mcpServerId: script.mcpServerId,
      revision: script.revision,
    };
  }
}
