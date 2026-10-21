import { ArgumentsHost, Catch, ExceptionFilter, ForbiddenException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { McpServer, isLegacyRequest } from '@modelcontextprotocol/server';
import {
  NodeStreamableHTTPServerTransport,
  toNodeHandler,
  toWebRequest,
} from '@modelcontextprotocol/node';
import { APP_VERSION } from '../common/app-version';
import { createQuietMcpHandler } from '../mcp-server/mcp-handler.util';

/**
 * What an AI client gets from /mcp while its user has not verified their
 * email address (cloud only, see EmailVerifiedGuard).
 *
 * WHY. The guard answered a plain HTTP 403. MCP clients treat that as a
 * failed connection and show neither the person nor the model why: on
 * 21 Oct 2026, 13 people who had connected Claude without verifying were
 * refused 438 times in under six hours, one of them 80 times, with nothing
 * telling them what was missing.
 *
 * The request is still refused: the guard throws before any controller runs,
 * and nothing of the workspace is read. This filter only shapes the refusal
 * as MCP: a server with no tools of the user's, whose instructions and only
 * tool carry the notice, so the client connects and the model can tell the
 * person what to do. Nothing here sends an email: a new code comes from
 * signing in, as before, so the rate of verification emails is unchanged.
 */

/** Name of the one tool served to an unverified user. */
export const VERIFY_EMAIL_TOOL = 'anythingmcp_verify_email';

/** `jo***@example.com`: enough for the person to recognise, no more. */
export function maskEmail(email: string | null | undefined): string | undefined {
  if (typeof email !== 'string') return undefined;
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return undefined;
  const local = email.slice(0, at);
  const keep = local.length > 2 ? 2 : 1;
  return `${local.slice(0, keep)}***${email.slice(at)}`;
}

/** The text shown to the person and the model. */
export function emailVerificationNotice(dashboardUrl: string, email?: string | null): string {
  const base = dashboardUrl.replace(/\/+$/, '');
  const masked = maskEmail(email);
  return (
    'Your AnythingMCP account cannot be used yet: its email address has not been verified, ' +
    'so no tools are available. ' +
    `We sent a verification email${masked ? ` to ${masked}` : ''} when you signed up: open the link ` +
    'in it (or enter its code), then try again. ' +
    `No email, or the code expired? Sign in at ${base}/login and a new code is sent; check the spam ` +
    'folder too. Nothing needs to change in your AI client.'
  );
}

/** Thrown by EmailVerifiedGuard on /mcp; a 403 with the notice wherever this filter does not apply. */
export class McpEmailVerificationRequiredException extends ForbiddenException {
  constructor(readonly notice: string) {
    super(notice);
  }
}

/** A tool name worth answering under (what MCP clients send; anything else gets "not found"). */
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * The server an unverified user is answered from: the notice, and nothing of
 * theirs. `calledTool` is the tool the request calls, if any: it answers with
 * the notice too, so a client that still knows a tool from earlier gets the
 * explanation rather than "tool not found". It is never listed.
 */
export function emailVerificationServer(notice: string, calledTool?: string): McpServer {
  const server = new McpServer(
    { name: 'AnythingMCP', version: APP_VERSION },
    { capabilities: { tools: {} }, instructions: notice },
  );
  const answer = async () => ({ content: [{ type: 'text' as const, text: notice }], isError: true });
  server.registerTool(
    VERIFY_EMAIL_TOOL,
    {
      description:
        'The AnythingMCP account behind this connection has not verified its email address, so its ' +
        'tools are unavailable. Call this to get the steps, and pass them on to the user.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    answer,
  );
  if (calledTool && calledTool !== VERIFY_EMAIL_TOOL && TOOL_NAME.test(calledTool)) {
    server.registerTool(calledTool, { description: notice }, answer);
  }
  return server;
}

/** The tool a `tools/call` request names. */
function calledToolOf(body: unknown): string | undefined {
  const b = body as { method?: unknown; params?: { name?: unknown } };
  return b?.method === 'tools/call' && typeof b.params?.name === 'string' ? b.params.name : undefined;
}

/** A single JSON-RPC message other than a subscriptions/listen stream. */
function isServableRequest(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const method = (body as { method?: unknown }).method;
  // A listen stream would stay open for minutes and has nothing to deliver.
  return typeof method === 'string' && method !== 'subscriptions/listen';
}

@Catch(McpEmailVerificationRequiredException)
export class McpEmailVerificationFilter implements ExceptionFilter {
  private readonly logger = new Logger(McpEmailVerificationFilter.name);

  catch(exception: McpEmailVerificationRequiredException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    if (res.headersSent) return;

    const body = (req as { body?: unknown }).body;
    if (req.method === 'POST' && isServableRequest(body)) {
      void this.serve(req, res, body, exception.notice).catch((err) => {
        this.logger.warn(`Could not serve the email verification notice: ${err?.message ?? err}`);
        this.refuse(res, exception.notice);
      });
      return;
    }
    this.refuse(res, exception.notice);
  }

  private refuse(res: Response, notice: string): void {
    if (res.headersSent) return;
    res.status(403).json({ jsonrpc: '2.0', error: { code: -32001, message: notice }, id: null });
  }

  private async isLegacy(req: Request, body: unknown): Promise<boolean> {
    try {
      return await isLegacyRequest(await toWebRequest(req, body), body);
    } catch {
      return false;
    }
  }

  /**
   * Same framing as the MCP endpoint (McpEndpointController.serveStateless):
   * the handler for 2026-07-28 traffic, and single-shot JSON for 2025-era
   * requests when JSON responses are enabled, which the handler's own
   * fallback cannot produce.
   */
  private async serve(req: Request, res: Response, body: unknown, notice: string): Promise<void> {
    const json = process.env.MCP_STREAMABLE_JSON_RESPONSE === 'true';
    const build = () => emailVerificationServer(notice, calledToolOf(body));
    if (json && (await this.isLegacy(req, body))) {
      const server = build();
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } finally {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      }
      return;
    }
    const handler = createQuietMcpHandler(build, {
      legacy: 'stateless',
      responseMode: json ? 'json' : 'sse',
    });
    try {
      await toNodeHandler(handler)(req, res, body);
    } finally {
      await handler.close().catch(() => undefined);
    }
  }
}
