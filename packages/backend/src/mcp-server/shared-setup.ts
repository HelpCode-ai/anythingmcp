import { Injectable } from '@nestjs/common';

/**
 * Connector setup through the shared `/mcp` endpoint.
 *
 * The shared endpoint serves a fixed list of eight tools (it is what the
 * Claude directory reviewed). Setting up connectors from a chat is offered
 * BEHIND those tools, as a virtual "AnythingMCP Setup" connector whose tools
 * are found with anythingmcp_search_tools and run with run_read_tool /
 * run_write_tool, exactly like a workspace's own tools.
 *
 * The implementation lives with the adapters (catalog, import, licence), which
 * already depend on this module; it registers itself here at start-up so this
 * module does not have to import them back.
 */
export interface SetupContext {
  userId: string;
  /** Workspace the connection reaches (the grant's, else the active one). */
  organizationId: string;
  /** Servers the connection is granted, so a new connector lands where it is visible. */
  serverIds: string[];
  /** Dashboard base URL for links handed to the user. */
  dashboardBase: string;
}

export interface SetupCallResult {
  body: unknown;
  isError?: boolean;
}

export interface SharedSetupProvider {
  /** Whether this caller may install connectors in that workspace (ADMIN or EDITOR). */
  canSetUp(ctx: SetupContext): Promise<boolean>;
  find(ctx: SetupContext, args: { query?: string; limit?: number }): Promise<SetupCallResult>;
  install(
    ctx: SetupContext,
    args: { adapter?: string; settings?: Record<string, unknown> },
  ): Promise<SetupCallResult>;
  status(ctx: SetupContext): Promise<SetupCallResult>;
}

@Injectable()
export class SharedSetupRegistry {
  private provider: SharedSetupProvider | null = null;

  register(provider: SharedSetupProvider): void {
    this.provider = provider;
  }

  get(): SharedSetupProvider | null {
    return this.provider;
  }
}
