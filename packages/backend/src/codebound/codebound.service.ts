import {
  BadRequestException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import { RolesService } from '../roles/roles.service';
import { DynamicMcpTools } from '../mcp-server/dynamic-mcp-tools';
import {
  isListable,
  RegisteredTool,
  ToolRegistry,
} from '../mcp-server/tool-registry';
import { deriveToolAnnotations } from '../mcp-server/tool-annotations';
import {
  jsonSchemaToZodShape,
  stripEnvVarParams,
} from '../mcp-server/tool-schema.util';
import { LicenseGuardService } from '../license/license-guard.service';
import { SecurityEventService } from '../audit/security-event.service';
import { RunScriptDto } from './codebound.dto';
import { RUN_TIMEOUT_MS, runSandbox, ScriptError } from './sandbox';

export interface ScriptCaller {
  sub: string;
  email: string;
  organizationId: string;
  role?: string;
}

@Injectable()
export class CodeboundService {
  private readonly activeOrganizations = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly roles: RolesService,
    private readonly registry: ToolRegistry,
    private readonly executor: DynamicMcpTools,
    private readonly license: LicenseGuardService,
    private readonly securityEvents: SecurityEventService,
  ) {}

  private async toolsFor(
    caller: ScriptCaller,
    serverId: string,
  ): Promise<RegisteredTool[]> {
    // Tenant filtering happens in the query, before resolving any connectors.
    const server = await this.prisma.mcpServerConfig.findFirst({
      where: {
        id: serverId,
        organizationId: caller.organizationId,
        isActive: true,
      },
      select: {
        connectors: {
          where: {
            connector: {
              organizationId: caller.organizationId,
              isActive: true,
            },
          },
          select: { connectorId: true },
        },
      },
    });
    if (!server) throw new NotFoundException('Active MCP server not found.');
    const allowedIds = await this.roles.getAllowedToolIds(
      caller.sub,
      caller.organizationId,
    );
    const connectorIds = new Set(
      server.connectors.map((entry) => entry.connectorId),
    );
    return this.registry.getAllTools().filter(
      (tool) =>
        tool.organizationId === caller.organizationId &&
        connectorIds.has(tool.connectorId) &&
        (allowedIds === null || allowedIds.includes(tool.id)) &&
        isListable(tool) &&
        // First milestone: only REST reads/static responses. Hints alone are
        // advisory, so also check the actual configured transport and method.
        tool.connectorType === 'REST' &&
        ['GET', 'HEAD', 'static'].includes(tool.endpointMapping.method) &&
        deriveToolAnnotations(tool).readOnlyHint === true,
    );
  }

  async listTools(caller: ScriptCaller, serverId: string) {
    const tools = await this.toolsFor(caller, serverId);
    return tools
      .filter(
        (tool, index) =>
          tools.findIndex((entry) => entry.name === tool.name) === index,
      )
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: stripEnvVarParams(
          tool.parameters,
          tool.connectorConfig.envVars,
        ),
        outputSchema: tool.outputSchema ?? null,
      }));
  }

  async run(
    caller: ScriptCaller,
    serverId: string,
    dto: RunScriptDto,
    savedScript?: { id: string; revision: number },
  ) {
    // Per-process backpressure, also bounding uninterruptible upstream reads.
    if (
      this.activeOrganizations.has(caller.organizationId) ||
      this.activeOrganizations.size >= 4
    ) {
      throw new HttpException('Script runner is busy. Try again shortly.', 429);
    }
    this.activeOrganizations.add(caller.organizationId);
    let runningCalls = 0;
    let scriptFinished = false;
    const release = () => {
      if (scriptFinished && runningCalls === 0)
        this.activeOrganizations.delete(caller.organizationId);
    };
    const runId = randomUUID();
    const started = Date.now();
    let status = 'ERROR';
    let calls = 0;
    try {
      await this.license.checkLicenseActive(caller.organizationId);
      await this.toolsFor(caller, serverId);
      const allowlist = new Set(dto.allowedTools);
      const output = await runSandbox(
        dto.code,
        dto.input,
        async (name, args) => {
          runningCalls++;
          try {
            if (!allowlist.has(name))
              throw new ScriptError("Tool is not in this run's allowlist.");
            // Recheck current assignments and permissions for EVERY nested call.
            const tool = (await this.toolsFor(caller, serverId)).find(
              (entry) => entry.name === name,
            );
            if (!tool)
              throw new ScriptError('Tool is unavailable or access is denied.');
            if (scriptFinished || Date.now() >= started + RUN_TIMEOUT_MS)
              throw new ScriptError('Script time limit exceeded.');
            const schema = stripEnvVarParams(
              tool.parameters,
              tool.connectorConfig.envVars,
            );
            const parsed = z
              .object(jsonSchemaToZodShape(schema))
              .safeParse(args);
            if (!parsed.success)
              throw new ScriptError(
                'Tool arguments do not match its input schema.',
              );
            calls++;
            const result = await this.executor.executeTool(name, parsed.data, {
              userId: caller.sub,
              userEmail: caller.email,
              organizationId: caller.organizationId,
              authMethod: 'jwt',
              mcpServerId: serverId,
              connectorIds: [tool.connectorId],
              // Always audit script reads and avoid shared response cache entries.
              skipCache: true,
              intent: `Codebound run ${runId}`,
            });
            if (result.isError)
              throw new ScriptError(
                'Connector call failed. Check the tool invocation log.',
              );
            if (result.structured !== undefined) return result.structured;
            try {
              return JSON.parse(result.content[0].text);
            } catch {
              throw new ScriptError('Connector did not return JSON data.');
            }
          } finally {
            runningCalls--;
            release();
          }
        },
      );
      status = 'SUCCESS';
      return { runId, ...output, durationMs: Date.now() - started };
    } catch (error) {
      if (error instanceof ScriptError)
        throw new BadRequestException(error.message);
      throw error;
    } finally {
      scriptFinished = true;
      release();
      // Record metadata only: neither source, inputs, intermediate data, nor
      // results belong in the parent security event.
      await this.securityEvents.log({
        event: 'CODEBOUND_RUN',
        actorType: 'USER',
        actorUserId: caller.sub,
        organizationId: caller.organizationId,
        metadata: {
          runId,
          serverId,
          status,
          calls,
          durationMs: Date.now() - started,
          ...(savedScript
            ? { savedScriptId: savedScript.id, revision: savedScript.revision }
            : {}),
        },
      });
    }
  }
}
