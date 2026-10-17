import { HttpException, Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { AsyncLocalStorage } from 'node:async_hooks';

/** Identity supplied only by MCP authentication, never by tool arguments. */
export interface CodeboundConnection {
  userId: string;
  email: string;
  organizationId: string;
  authMethod: string;
  apiKeyName?: string;
  oauthClientId?: string;
  pinnedServerId?: string;
  endpointServerId?: string;
}

const server = {
  serverId: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'MCP server ID. Omit on a per-server endpoint. On shared /mcp, first call codebound_list_tools to find server IDs.',
    ),
};
const input = z.record(z.string(), z.unknown());
const script = {
  code: z
    .string()
    .min(1)
    .max(32768)
    .describe(
      'JavaScript function body. Read input, await tools.call(name, args), and return JSON. No imports, fetch, Node APIs or timers. Await connector calls sequentially.',
    ),
  input: input
    .default({})
    .describe('JSON parameters. When saving, these become the defaults.'),
  allowedTools: z
    .array(z.string().min(1).max(200))
    .max(20)
    .describe(
      'Only these connector tool names may be called. Obtain names and schemas with codebound_list_tools. No nested scripts or MCP built-ins.',
    ),
};

export const CODEBOUND_TOOLS = [
  {
    name: 'codebound_list_tools',
    readOnly: true,
    description:
      'Discover connector tools for writing a Codebound script. On shared /mcp without serverId, lists reachable servers. With a server, returns permitted REST read tools and input/output schemas. A null output schema is unknown; inspect a small sample and validate the response fields your script uses.',
    schema: {
      ...server,
      query: z.string().max(200).optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(50).default(20),
    },
  },
  {
    name: 'codebound_run',
    readOnly: true,
    description:
      'Execute AI-written JavaScript near the connectors and return only its final JSON result. Uses the current connection permissions and sandbox: 5 seconds, 20 sequential REST reads, 64 MiB guest memory, 32 KiB result. Does not save the script. Use tools.call only for names from codebound_list_tools.',
    schema: { ...server, ...script },
  },
  {
    name: 'codebound_save_script',
    readOnly: false,
    description:
      'Save a tested workflow for reuse in Codebound. Editors/admins only. Provide scriptId and its reviewed revision to update; omit both to create. Saves source and default input, without granting tool permissions. Obtain the current source/revision with codebound_get_script before editing.',
    schema: {
      ...server,
      ...script,
      name: z.string().trim().min(1).max(120),
      description: z.string().max(2000).default(''),
      scriptId: z.string().min(1).max(100).optional(),
      revision: z.number().int().min(1).optional(),
    },
  },
  {
    name: 'codebound_list_scripts',
    readOnly: true,
    description:
      'List reusable scripts for one reachable MCP server, restricted to this connection and permitted read tools. Returns summaries and revisions, not source. Follow nextOffset even if a page is empty.',
    schema: {
      ...server,
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(50).default(20),
    },
  },
  {
    name: 'codebound_get_script',
    readOnly: true,
    description:
      "Read a saved workflow source, default parameters, allowlist, and revision before reusing or editing it. Limited to this connection's server and current permitted tools.",
    schema: { ...server, scriptId: z.string().min(1).max(100) },
  },
  {
    name: 'codebound_run_saved',
    readOnly: true,
    description:
      'Run a reviewed saved workflow by ID and revision. Source and tool allowlist come from storage; optional input overrides the stored defaults for this run. Reopen after a revision conflict. Saving a script never grants access to its connector tools.',
    schema: {
      ...server,
      scriptId: z.string().min(1).max(100),
      revision: z.number().int().min(1),
      input: input.optional(),
    },
  },
] as const;

export interface CodeboundMcpProvider {
  call(
    connection: CodeboundConnection,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
}

/** Same startup bridge pattern as SharedSetupRegistry, avoiding a module cycle. */
@Injectable()
export class CodeboundRegistry {
  private provider: CodeboundMcpProvider | null = null;
  private readonly current = new AsyncLocalStorage<CodeboundConnection>();
  register(provider: CodeboundMcpProvider) {
    this.provider = provider;
  }
  get(): CodeboundMcpProvider | null {
    const provider = this.provider;
    return provider
      ? {
          call: (connection, name, args) =>
            provider.call(this.current.getStore() ?? connection, name, args),
        }
      : null;
  }
  withConnection<T>(
    connection: CodeboundConnection,
    run: () => Promise<T>,
  ): Promise<T> {
    return this.current.run(connection, run);
  }
}

export const isCodeboundTool = (name: string) =>
  CODEBOUND_TOOLS.some((tool) => tool.name === name);

export function codeboundEntries(
  provider: CodeboundMcpProvider,
  connection: CodeboundConnection,
) {
  return CODEBOUND_TOOLS.map((tool) => {
    const annotations = {
      readOnlyHint: tool.readOnly,
      destructiveHint: !tool.readOnly,
      idempotentHint: false,
      openWorldHint:
        tool.name === 'codebound_run' || tool.name === 'codebound_run_saved',
    };
    const inputSchema = z.toJSONSchema(z.strictObject(tool.schema), {
      target: 'draft-7',
    });
    const call = async (args: Record<string, unknown>) => {
      try {
        const value = await provider.call(connection, tool.name, args);
        const text = JSON.stringify(value);
        if (Buffer.byteLength(text) > 262144)
          throw new HttpException(
            'Result exceeds 256 KiB. Narrow the query or lower the page limit.',
            400,
          );
        return { content: [{ type: 'text' as const, text }] };
      } catch (error) {
        // Only explicit application errors are public. Prisma/transport errors
        // may contain credentials; never serialize raw exceptions or arguments.
        const message =
          error instanceof HttpException
            ? error.message.slice(0, 500)
            : 'Codebound request failed.';
        return {
          isError: true,
          content: [
            { type: 'text' as const, text: JSON.stringify({ error: message }) },
          ],
        };
      }
    };
    return {
      name: tool.name,
      description: tool.description,
      inputSchema,
      annotations,
      call,
      sig: JSON.stringify([
        tool.name,
        inputSchema,
        connection.endpointServerId,
      ]),
      register: (mcpServer: McpServer) =>
        mcpServer.registerTool(
          tool.name,
          {
            description: tool.description,
            inputSchema: tool.schema,
            annotations,
          },
          call,
        ),
    };
  });
}
