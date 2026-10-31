import { Injectable, Logger, Optional } from '@nestjs/common';
import { AxiosError } from 'axios';
import { ToolRegistry } from './tool-registry';
import { CodeExecutorService } from './code-executor.service';
import {
  isCodeMethod,
  parseCodeToolMapping,
  buildCodeBridge,
  type CodeBridgeDeps,
  type BridgeResolvedTool,
} from './code-tool.util';
import { deriveToolAnnotations } from './tool-annotations';
import { RestEngine } from '../connectors/engines/rest.engine';
import { GraphqlEngine } from '../connectors/engines/graphql.engine';
import { SoapEngine } from '../connectors/engines/soap.engine';
import { McpClientEngine } from '../connectors/engines/mcp-client.engine';
import { DatabaseEngine } from '../connectors/engines/database.engine';
import { AuditService } from '../audit/audit.service';
import { RedisService } from '../common/redis.service';
import { LicenseGuardService } from '../license/license-guard.service';
import { DeploymentService } from '../common/deployment.service';
import { PrismaService } from '../common/prisma.service';
import {
  interpolateConnectorConfig,
  interpolateDeep,
} from '../common/env-interpolation.util';
import { assertNoUnresolvedPlaceholders } from '../common/unresolved-placeholders.util';
import { assertAbsoluteBaseUrl } from '../common/base-url-variable.util';
import {
  CALLER_CONTEXT_PREFIX,
  buildCallerContextVars,
  usesCallerContext,
} from '../common/caller-context.util';
import { applyResponseTransform, type TransformOutcome } from '../connectors/response-transform.util';
import {
  attachResponseMeta,
  type ResponseMeta,
} from '../connectors/engines/response-headers.util';
import { KgService } from '../knowledge-graph/kg.service';
import type { ResponseMapping } from '../connectors/engines/engine-types';
import type { RegisteredTool } from './tool-registry';
import { deriveErrorHint, hostFromAxiosConfig, hostFromUrl } from './error-hints';
import { processGauges } from '../common/process-vitals';
import { recordToolCall } from '../common/metrics';
import { applySchemaDefaults } from '../common/schema-defaults.util';
import { renderStaticResponse } from '../connectors/static-response.util';
import { ODataEngine, isODataBuiltinMethod } from '../connectors/engines/odata.engine';
import { EmailEngine } from '../connectors/engines/email.engine';
import { connectorPageUrl } from '../common/url.util';
import { hashContent } from '../adapters/catalog-fingerprint';
import { UserCredentialsService } from '../connectors/user-credentials.service';
import { connectorErrorWhen } from '../connectors/error-when.util';
import {
  isBinaryBody,
  readBinaryConfig,
  renderBinaryBody,
  withoutBinaryData,
  type BinaryContent,
} from '../connectors/binary-response.util';

/**
 * The content of a tool result: one text item, then the images taken out of
 * the response by `responseMapping.images`, or the file a binary response
 * carried (binary-response.util.ts). None for every other tool. The text
 * comes first so whatever reads `content[0].text` keeps working.
 */
export type ToolResultContent = [
  { type: 'text'; text: string },
  ...(
    | { type: 'image'; data: string; mimeType: string }
    | { type: 'resource'; resource: { uri: string; mimeType: string; blob: string } }
  )[],
];
/** Invocation context shared by the code-tool and inline-code paths. */
interface CodeExecContext {
  userId?: string;
  userEmail?: string;
  organizationId?: string;
  authMethod?: string;
  apiKeyName?: string;
  mcpServerId?: string;
  mcpServerName?: string;
  connectorIds?: string[];
  intent?: string;
  learnable?: boolean;
  allowedToolIds?: string[] | null;
  inCodeRun?: boolean;
}

import { ResponseBodyError } from '../connectors/engines/response-error.util';
import { connectorSecretValues } from '../connectors/connector-secrets.util';
import { redactSecretsDeep } from '../common/secret-literals.util';
import { withTokenRenewal } from '../connectors/engines/bearer-token-renewal.service';
import {
  ResponseTooLargeError,
  fitsResponseLimit,
  toolMaxResponseBytes,
} from '../common/response-size-limit';

/**
 * ToolExecutor — executes dynamically registered MCP tools.
 *
 * Each tool is mapped to a connector engine (REST, GraphQL, SOAP, etc.)
 * and executed with caching, audit logging, and env interpolation.
 */
@Injectable()
export class DynamicMcpTools {
  private readonly logger = new Logger(DynamicMcpTools.name);

  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly auditService: AuditService,
    private readonly redisService: RedisService,
    private readonly licenseGuard: LicenseGuardService,
    private readonly deployment: DeploymentService,
    private readonly prisma: PrismaService,
    private readonly restEngine: RestEngine,
    private readonly graphqlEngine: GraphqlEngine,
    private readonly soapEngine: SoapEngine,
    private readonly mcpClientEngine: McpClientEngine,
    private readonly databaseEngine: DatabaseEngine,
    private readonly kgService: KgService,
    @Optional() private readonly odataEngine?: ODataEngine,
    @Optional() private readonly userCredentials?: UserCredentialsService,
    @Optional() private readonly emailEngine?: EmailEngine,
    @Optional() private readonly codeExecutor?: CodeExecutorService,
  ) {}

  /**
   * Decide whether this tool call should be routed through the
   * proxy / web-unblocker, and return the proxy URL when it should.
   *
   * Rules:
   *  - No CONNECTOR_PROXY_URL env  → never proxy (request goes direct,
   *    even if the tool opted in — graceful degradation).
   *  - Tool must opt in (mcp_tools.use_proxy = true).
   *  - Cloud only: the workspace must be under its hourly proxy cap.
   *    The license/trial gate is already enforced at the top of
   *    executeTool (checkLicenseActive throws), so reaching here in
   *    cloud means the workspace is licensed/trialing.
   *  - Over the cap → throw (choice B: explicit error to the caller).
   *
   * Self-hosted installs get no rate limit and no license gate.
   */
  private async resolveProxy(
    tool: RegisteredTool,
    organizationId?: string,
  ): Promise<string | null> {
    const proxyUrl = process.env.CONNECTOR_PROXY_URL;
    if (!proxyUrl) return null; // env absent → direct request
    if (tool.useProxy !== true) return null; // tool didn't opt in

    if (this.deployment.isCloud() && organizationId) {
      const limit = await this.getProxyLimit(organizationId);
      const key = `proxy_rl:${organizationId}`;
      const count = await this.redisService.incr(key);
      if (count === 1) {
        await this.redisService.expire(key, 3600);
      }
      if (count > limit) {
        const ttl = await this.redisService.ttl(key);
        const mins = ttl > 0 ? Math.ceil(ttl / 60) : 60;
        throw new Error(
          `Proxy quota exceeded: this workspace is limited to ${limit} ` +
            `proxy/unblocker tool calls per hour. Try again in ~${mins} minute(s), ` +
            `or run this tool without the proxy.`,
        );
      }
    }

    return proxyUrl;
  }

  /**
   * Effective hourly proxy cap for a workspace:
   * organizations.proxy_rate_limit (DB, admin-only) ?? PROXY_RATE_LIMIT_DEFAULT
   * env ?? 100. There is intentionally no API to change the per-workspace
   * value — only a service admin via the database.
   */
  /**
   * One line per tool call, with the two numbers the 20 Sep incident lacked.
   *
   * The afternoon the backend exhausted its heap, the run that died had 24
   * tool calls that took over 20 seconds — several near two minutes — while
   * the run that stayed healthy had none. The audit log records duration but
   * lives in Postgres; the log is what an operator reads at 2 a.m. Response
   * size is here because a 118-second call that returns 40 MB and one that
   * returns 4 KB are different problems.
   *
   * WARN above 20 s or 1 MB so the outliers are greppable without a threshold
   * in someone's head.
   */
  private logToolCall(
    tool: RegisteredTool,
    context: { organizationId?: string; mcpServerId?: string; authMethod?: string } | undefined,
    durationMs: number,
    status: 'SUCCESS' | 'ERROR',
    renderedText?: string,
    upstreamStatus?: number,
  ): void {
    const resultBytes = renderedText ? Buffer.byteLength(renderedText) : 0;
    recordToolCall({
      connectorType: tool.connectorType,
      status: status === 'SUCCESS' ? 'success' : 'error',
      durationMs,
      upstreamStatus,
      connectorId: tool.connectorId,
      tool: tool.name,
    });
    const line = {
      msg: 'tool_call',
      toolName: tool.name,
      connectorId: tool.connectorId,
      connectorType: tool.connectorType,
      organizationId: context?.organizationId,
      mcpServerId: context?.mcpServerId,
      authMethod: context?.authMethod,
      durationMs,
      resultBytes,
      status,
      upstreamStatus,
    };
    if (durationMs > 20_000 || resultBytes > 1_048_576) {
      this.logger.warn({ ...line, slow: durationMs > 20_000, large: resultBytes > 1_048_576 });
    } else {
      this.logger.log(line);
    }
  }

  /**
   * Values of the connector's secret variables (by name, by the slot the
   * adapter uses them in, or by their shape), as `connector-secrets.util`
   * decides which ones the dashboard withholds. Short values are skipped:
   * replacing a 3-character string everywhere in a response would mangle it.
   */
  private connectorSecretValues(tool: RegisteredTool): string[] {
    if (!tool.connectorConfig) return [];
    return connectorSecretValues({
      envVars: tool.connectorConfig.envVars,
      config: tool.connectorConfig.config,
      headers: tool.connectorConfig.headers,
    });
  }

  private async getProxyLimit(organizationId: string): Promise<number> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { proxyRateLimit: true },
    });
    if (org?.proxyRateLimit != null && org.proxyRateLimit >= 0) {
      return org.proxyRateLimit;
    }
    const envDefault = parseInt(process.env.PROXY_RATE_LIMIT_DEFAULT || '', 10);
    return Number.isFinite(envDefault) && envDefault >= 0 ? envDefault : 100;
  }

  /**
   * Execute a tool by name with the given parameters.
   * Handles caching, audit logging, env interpolation, and engine dispatch.
   */
  async executeTool(
    toolName: string,
    params: Record<string, unknown>,
    context?: {
      userId?: string;
      userEmail?: string;
      organizationId?: string;
      authMethod?: string;
      apiKeyName?: string;
      mcpServerId?: string;
      mcpServerName?: string;
      connectorIds?: string[];
      intent?: string;
      /** The caller contributes to skill learning (stamped on the log row). */
      learnable?: boolean;
      /**
       * The caller's allowed tool ids in this org (null = unrestricted), as the
       * controllers already resolve via RolesService. A code tool in `invoker`
       * mode re-checks this before every inner call; when it is undefined for an
       * identified user the code tool fails closed (denies inner calls) rather
       * than guess. Plain tool calls ignore it (their role is gated upstream).
       */
      allowedToolIds?: string[] | null;
      /** Set on calls made from inside a code run, so a code tool cannot be
       *  reached from within another (no recursion). */
      inCodeRun?: boolean;
    },
  ): Promise<{
    content: ToolResultContent;
    isError?: boolean;
    /**
     * The result as an object, before it was serialized into `content[0].text`.
     * Lets the MCP endpoint build structuredContent without re-parsing the text
     * — which silently produced `{}` for any tool with a followUp hint.
     */
    structured?: unknown;
  }> {
    // Check license before executing tool (cloud mode only)
    try {
      await this.licenseGuard.checkLicenseActive(context?.organizationId);
    } catch (err: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: err.message || 'This workspace\'s license is not active. Ask a workspace administrator to renew it.',
            }),
          },
        ],
        isError: true,
      };
    }

    // Resolve the tool in the ONE scope this caller is entitled to, and never
    // widen when that scope has no match.
    //
    // This used to try `getTool(toolName, context?.connectorIds)` first and
    // fall back to the organization only `if (!tool)`. On the global /mcp
    // endpoint `connectorIds` is undefined, and `getTool` with no connector
    // filter returns `candidates[0]` — whichever connector registered that
    // name FIRST, in ANY organization. The fallback then never ran, because a
    // tool had already been found. So a caller whose own workspace had a tool
    // of the same name executed somebody else's connector, with that tenant's
    // stored credentials and base URL. 610 tool names are shared across more
    // than one organization on the cloud instance today; one is shared by 76.
    //
    // The scopes are mutually exclusive, in decreasing specificity:
    //   - connectorIds — invoked through /mcp/:serverId, or by an API key
    //     pinned to a server. Only that server's connectors, never wider.
    //   - organizationId — any JWT on the global /mcp. Only the caller's org.
    //   - neither — an instance-level static credential on a single-tenant
    //     self-hosted box, where "any tool" is the correct answer.
    let tool: RegisteredTool | undefined;
    if (context?.connectorIds) {
      tool = this.toolRegistry.getTool(toolName, context.connectorIds);
    } else if (context?.organizationId) {
      tool = this.toolRegistry.getToolForOrg(toolName, context.organizationId);
    } else {
      tool = this.toolRegistry.getTool(toolName);
    }
    if (!tool) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: `Tool '${toolName}' not found.`,
            }),
          },
        ],
        isError: true,
      };
    }

    // Code tools run a stored program in the out-of-process runner instead of
    // calling one upstream endpoint. Handled before the cache and the engine
    // dispatch: a run is never cached, and its authority is enforced by the
    // bridge, not the engine. A code tool is refused from inside another code
    // run so there is no recursion to bound.
    if (isCodeMethod(tool.endpointMapping)) {
      if (context?.inCodeRun) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `'${toolName}' is a code tool and cannot be called from within a code run.` }) }],
          isError: true,
        };
      }
      return this.executeCodeTool(tool, params, context);
    }

    // Check response cache. The cache holds the *raw* upstream response, so
    // editing a tool's response mapping takes effect immediately instead of
    // after up to cacheTtl seconds.
    const responseMapping = tool.responseMapping as ResponseMapping | undefined;
    // A connector with per-user credentials answers each user with what that
    // user's account may see: one user's cached answer is never another's,
    // and a call without a user is not answered from the cache at all.
    const perUser = tool.connectorConfig.credentialScope === 'USER';
    const cacheScope = perUser && context?.userId ? `user:${context.userId}` : undefined;
    const cacheTtl = perUser && !cacheScope ? undefined : responseMapping?.cacheTtl;
    if (cacheTtl && cacheTtl > 0) {
      const cacheKey = this.buildCacheKey(tool, params, cacheScope);
      const cached = await this.redisService.get(cacheKey);
      if (cached) {
        try {
          const raw = JSON.parse(cached);
          this.logger.debug(`Cache hit for tool ${toolName}`);
          // Entries written with response meta are wrapped; older ones are
          // the bare body. Both must keep rendering.
          if (raw && typeof raw === 'object' && raw.__amcpEnvelope === 1) {
            return this.renderResult(
              raw.body,
              responseMapping,
              toolName,
              raw.meta,
              tool.endpointMapping?.queryParams,
            ).result;
          }
          return this.renderResult(raw, responseMapping, toolName).result;
        } catch {
          // Unreadable entry — fall through and re-execute.
          this.logger.warn(`Discarding unparsable cache entry for tool ${toolName}`);
        }
      }
    }

    const startTime = Date.now();
    let usedProxy = false;
    // The connector's credentials, as filled into the URL, headers and auth.
    // An error message or an echoing API can quote them back (a URL with the
    // bot token in its path); they never reach the client or the log.
    const secretValues = this.connectorSecretValues(tool);

    try {
      const envVars = tool.connectorConfig.envVars || {};

      // Reserved {{amcp.*}} caller-context vars are merged AFTER the
      // workspace's own env vars, so a connector variable can never shadow
      // (i.e. spoof) the authenticated identity.
      const interpolationVars = {
        ...envVars,
        ...buildCallerContextVars(context),
      };

      // Interpolate {{VAR}} patterns in config and endpoint mapping
      const {
        config: interpolatedConfig,
        endpointMapping: interpolatedMapping,
      } = interpolateConnectorConfig(
        {
          baseUrl: tool.connectorConfig.baseUrl,
          headers: tool.connectorConfig.headers,
        },
        tool.endpointMapping,
        interpolationVars,
        { reservedPrefix: CALLER_CONTEXT_PREFIX },
      );

      // Decide proxy routing (env present + tool opted in + cloud rate-limit).
      // Throws on over-quota (choice B). Returns null → direct request.
      const proxyUrl = await this.resolveProxy(tool, context?.organizationId);
      usedProxy = proxyUrl != null;

      // authConfig carries {{VAR}} placeholders too, and until now nothing
      // resolved them at call time: they were substituted once, at import, from
      // whatever the install form was given. A workspace that installed the
      // connector first and filled its credentials afterwards therefore kept
      // sending the placeholder text forever. Interpolating here makes the two
      // paths agree.
      let connectorAuthConfig: Record<string, unknown> | undefined = tool.connectorConfig.authConfig
        ? interpolateDeep(
            JSON.parse(tool.connectorConfig.authConfig),
            interpolationVars,
            { reservedPrefix: CALLER_CONTEXT_PREFIX },
          )
        : undefined;
      // Per-user credentials: the caller's own sign-in, keyed on its own in
      // the engines (token cache, refresh lock, refused memo). Throws, with
      // nothing sent, when there is no caller, licence or sign-in.
      let credentialKey: string | undefined;
      if (perUser) {
        if (!this.userCredentials) {
          throw new Error('Per-user sign-in is not available on this server. No request was sent to the API.');
        }
        const resolved = await this.userCredentials.resolveForCall({
          connectorId: tool.connectorId,
          connectorName: tool.connectorName ?? tool.name,
          organizationId: tool.organizationId,
          userId: context?.userId,
          connectorAuthConfig,
        });
        connectorAuthConfig = resolved.authConfig;
        credentialKey = resolved.credentialKey;
        // The user's tokens are masked like the connector's own secrets.
        for (const field of ['accessToken', 'refreshToken'] as const) {
          const value = resolved.authConfig[field];
          if (typeof value === 'string' && value) secretValues.push(value);
        }
      }
      const authConfig = withTokenRenewal(
        tool.connectorConfig.authType,
        connectorAuthConfig,
        tool.connectorConfig.config,
        envVars,
      );

      const engineConfig = {
        baseUrl: interpolatedConfig.baseUrl,
        authType: tool.connectorConfig.authType,
        authConfig,
        headers: interpolatedConfig.headers,
        specUrl: (tool.connectorConfig as any).specUrl,
        // The engines key the OAuth2 token cache, the refresh lock and the
        // saving of a renewed token on the connector id. Without it every
        // call parsed a fresh authConfig, so nothing was cached, a renewed
        // token was never saved, and the next renewal sent the refresh token
        // the provider had already rotated: Cloudinary (5-minute tokens)
        // answered invalid_grant a few minutes after each authorization.
        // Credentials that depend on the caller ({{amcp.*}}) differ per call,
        // so they stay unkeyed.
        connectorId: credentialKey ??
          (usesCallerContext(tool.connectorConfig.authConfig) ? undefined : tool.connectorId),
        errorWhen: connectorErrorWhen(tool.connectorConfig.config),
        // Masked in the engines' log lines (a bot token in the URL path).
        logSecrets: secretValues,
        ...(proxyUrl ? { proxyUrl } : {}),
      };

      // An OAuth connector nobody has authorized carries a placeholder where
      // the refresh token goes. Say what to do about it, rather than naming
      // a variable the user is not supposed to fill in by hand.
      if (tool.setupStatus === 'needs_authorization') {
        const page = connectorPageUrl(tool.connectorId);
        throw new Error(
          'OAuth2: this connector has not been authorized yet. No request was sent to the API. ' +
            `Open the connector in AnythingMCP${page ? ` (${page})` : ''} and click Authorize with Provider.`,
        );
      }

      // Nothing left to substitute it with: fail here, with the variable names,
      // rather than let the vendor answer something that reads like our bug.
      assertNoUnresolvedPlaceholders(
        {
          baseUrl: engineConfig.baseUrl,
          path: interpolatedMapping.path,
          queryParams: interpolatedMapping.queryParams,
          headers: engineConfig.headers,
          authConfig,
          body: {
            template: interpolatedMapping.bodyTemplate,
            mapping: interpolatedMapping.bodyMapping,
            headers: interpolatedMapping.headers,
          },
        },
        `the connector behind ${tool.name}`,
        connectorPageUrl(tool.connectorId),
      );
      // A base URL without https:// (a variable typed as `shop.example.com`
      // on an older install) would otherwise fail in the SSRF guard as
      // "invalid URL", naming neither the variable nor the fix.
      assertAbsoluteBaseUrl(
        {
          baseUrl: engineConfig.baseUrl,
          connectorType: tool.connectorType,
          template: tool.connectorConfig.baseUrl,
          envVars,
        },
        `the connector behind ${tool.name}`,
      );

      // Inject env vars as parameter defaults (env var values fill in params
      // that match by name, so they don't need to be provided by the caller)
      const paramsWithEnv = this.injectEnvVars(params, envVars);

      // Apply JSON Schema defaults for missing params
      const mergedParams = this.applyDefaults(tool.parameters, paramsWithEnv);

      processGauges.inc('toolCallsInFlight');
      let engineOut: Awaited<ReturnType<DynamicMcpTools['executeWithEngine']>>;
      try {
        engineOut = await this.executeWithEngine(
          tool.connectorType,
          engineConfig,
          interpolatedMapping,
          mergedParams,
          {
            connectorConfig: tool.connectorConfig.config,
            // OData settings may carry {{VAR}} (an adapter's SAP client).
            odataSettings: interpolateDeep(
              (tool.connectorConfig.config as { odata?: unknown } | undefined)?.odata,
              envVars,
            ),
            // Email settings too: a catalog install keeps {{EMAIL_IMAP_HOST}}.
            emailSettings: interpolateDeep(
              (tool.connectorConfig.config as { email?: unknown } | undefined)?.email,
              envVars,
            ),
          },
        );
      } finally {
        processGauges.dec('toolCallsInFlight');
      }
      const { body: upstreamResult, meta } = engineOut;
      if (
        tool.connectorType === 'MCP' &&
        typeof upstreamResult === 'object' &&
        upstreamResult !== null &&
        'isError' in upstreamResult &&
        upstreamResult.isError === true &&
        'content' in upstreamResult &&
        Array.isArray(upstreamResult.content)
      ) {
        const safeText = redactSecretsDeep(
          upstreamResult.content
            .filter((item) => item?.type === 'text' && typeof item.text === 'string')
            .map((item) => item.text)
            .join('\n'),
          secretValues,
        );
        const errorResult: { content: ToolResultContent; isError: true } = {
          content: [{ type: 'text', text: safeText }],
          isError: true,
        };
        const durationMs = Date.now() - startTime;
        await this.auditService.logInvocation({
          toolId: tool.id,
          userId: context?.userId,
          userEmail: context?.userEmail,
          mcpServerId: context?.mcpServerId,
          organizationId: context?.organizationId,
          connectorId: tool.connectorId,
          usedProxy,
          intent: context?.intent,
          learnable: context?.learnable ?? false,
          input: params,
          output: errorResult,
          status: 'ERROR',
          durationMs,
          error: this.formatStoredError({
            error: 'MCP tool returned isError: true',
            responseBody: safeText,
          }),
          clientInfo: context ? JSON.stringify({
            authMethod: context.authMethod,
            apiKeyName: context.apiKeyName,
            userEmail: context.userEmail,
            mcpServerName: context.mcpServerName,
          }) : undefined,
        });
        this.logToolCall(tool, context, durationMs, 'ERROR');
        return errorResult;
      }
      // An API that echoes the request (a URL with the bot token in it) must
      // not hand the connector's own credentials to the client, the cache or
      // the log. Only those values are replaced, and the response is copied
      // only when it mentions one. An all-digit value (a PIN, a numeric key)
      // is left alone here: it would also match inside the response's own
      // ids and amounts and corrupt them. Errors still redact it.
      const result = redactSecretsDeep(
        upstreamResult,
        secretValues.filter((value) => !/^\d+$/.test(value)),
        { patterns: false },
      );

      const durationMs = Date.now() - startTime;

      // Rendered before the log row, so a result over the size limit is
      // logged as the error the client gets.
      const { result: rendered, tooLarge } = this.renderResult(
        result,
        responseMapping,
        toolName,
        meta,
        tool.endpointMapping?.queryParams,
      );

      await this.auditService.logInvocation({
        toolId: tool.id,
        userId: context?.userId,
        userEmail: context?.userEmail,
        mcpServerId: context?.mcpServerId,
        organizationId: context?.organizationId,
        connectorId: tool.connectorId,
        usedProxy,
        intent: context?.intent,
        learnable: context?.learnable ?? false,
        input: params,
        // A file's bytes stay out of the call log: only what it was. An
        // oversized result is not stored either: like an upstream body over
        // the limit, the row keeps the error, and the excerpt would cost one
        // more serialization of the whole payload.
        output: tooLarge
          ? undefined
          : (withoutBinaryData(result) as Record<string, unknown>),
        status: tooLarge ? 'ERROR' : 'SUCCESS',
        durationMs,
        error: tooLarge ? this.formatStoredError({ error: tooLarge.message }) : undefined,
        clientInfo: context ? JSON.stringify({
          authMethod: context.authMethod,
          apiKeyName: context.apiKeyName,
          userEmail: context.userEmail,
          mcpServerName: context.mcpServerName,
        }) : undefined,
      });

      if (tooLarge) {
        // Nothing to learn from or cache: every read would fail the same way.
        this.logToolCall(tool, context, durationMs, 'ERROR');
        return rendered;
      }

      // Grow the knowledge graph from this real call (debounced, fire-and-forget).
      void this.kgService.scheduleObservationalIngest(context?.organizationId);

      // Cache the raw response if cacheTtl is set (shaping happens on read).
      if (cacheTtl && cacheTtl > 0) {
        const cacheKey = this.buildCacheKey(tool, params, cacheScope);
        // The audit log above got the bare body; the cache needs the headers
        // too, or a cached page would come back without its next cursor.
        const serialized = JSON.stringify(
          meta ? { __amcpEnvelope: 1, body: result, meta } : result,
        );
        if (serialized !== undefined) {
          await this.redisService.set(cacheKey, serialized, cacheTtl);
          this.logger.debug(
            `Cached response for tool ${toolName} (TTL: ${cacheTtl}s)`,
          );
        }
      }

      this.logToolCall(tool, context, durationMs, 'SUCCESS', textOf(rendered.content));
      return rendered;
    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      const errorDetail = redactSecretsDeep(this.extractErrorDetail(error), secretValues);
      this.logToolCall(
        tool,
        context,
        durationMs,
        'ERROR',
        undefined,
        typeof errorDetail.status === 'number' ? errorDetail.status : undefined,
      );

      // One actionable line for the client, on top of the vendor's own body.
      // Keyed on the upstream host so hand-built tools get the same help as
      // catalog ones; see error-hints.ts for why this exists.
      // The engines attach their own hint when they know more than the
      // response says (a refresh token refused 7 days after a Google
      // authorization, a Meta session that was logged out).
      const engineHint = typeof error?.hint === 'string' && error.hint ? error.hint : undefined;
      const hint = engineHint ?? deriveErrorHint({
        host:
          hostFromAxiosConfig(error?.config) ??
          hostFromUrl(tool.connectorConfig?.baseUrl),
        status: typeof errorDetail.status === 'number' ? errorDetail.status : undefined,
        message: typeof error?.message === 'string' ? error.message : undefined,
        body: errorDetail.responseBody,
      });
      if (hint) errorDetail.hint = hint;

      await this.auditService.logInvocation({
        toolId: tool.id,
        userId: context?.userId,
        userEmail: context?.userEmail,
        mcpServerId: context?.mcpServerId,
        organizationId: context?.organizationId,
        connectorId: tool.connectorId,
        usedProxy,
        intent: context?.intent,
        learnable: context?.learnable ?? false,
        input: params,
        status: 'ERROR',
        durationMs,
        error: this.formatStoredError(errorDetail),
        clientInfo: context ? JSON.stringify({
          authMethod: context.authMethod,
          apiKeyName: context.apiKeyName,
          userEmail: context.userEmail,
          mcpServerName: context.mcpServerName,
        }) : undefined,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(errorDetail, null, 2),
          },
        ],
        isError: true,
      };
    }
  }

  /**
   * Turn a raw engine result into the MCP tool result.
   *
   * Two opt-in per-tool behaviours live here, in this order:
   *
   *  1. `responseMapping.transform` — response shaping. Upstream endpoints
   *     routinely return far more than the tool needs (a Datto RMM device
   *     carries up to 300 UDF fields when the tool wants five), and every extra
   *     byte is billed to the agent's context and exposed to a third-party
   *     model. A tool without a transform takes the identity path and its
   *     output is byte-identical to before this existed.
   *
   *  2. `responseMapping.followUp` — a workflow hint appended to the result so
   *     the calling agent sees, mid-workflow, what it should do next. Drives
   *     multi-step tool chains far more reliably than a pre-call description.
   *
   * A broken mapping must never break a working tool, so a transform error
   * falls back to the raw response and only warns — unless the operator set
   * `fallbackToRaw: false`, which is an explicit "I'd rather see the error".
   *
   * The text is held to `TOOL_MAX_RESPONSE_BYTES`, the limit the engines
   * already apply to the upstream body, for every connector type. A text over
   * it is written again as compact JSON; if that is still over, the result is
   * the `TOOL_RESPONSE_TOO_LARGE` error instead (`tooLarge` is set), so no
   * text, structuredContent, image or file of that call reaches the client.
   */
  private renderResult(
    raw: unknown,
    responseMapping: ResponseMapping | undefined,
    toolName: string,
    meta?: ResponseMeta,
    queryParams?: Record<string, unknown>,
  ): {
    result: {
      content: ToolResultContent;
      isError?: boolean;
      structured?: unknown;
    };
    tooLarge?: ResponseTooLargeError;
  } {
    // A file (image, PDF, …): described in the text and attached after it.
    // A response mapping has nothing to shape in raw bytes, so it is skipped.
    let binaryContent: BinaryContent[] = [];
    const binary = isBinaryBody(raw);
    if (isBinaryBody(raw)) {
      const rendered = renderBinaryBody(raw, readBinaryConfig(responseMapping), toolName);
      raw = rendered.value;
      binaryContent = rendered.content;
    }
    const outcome: TransformOutcome = binary
      ? { value: raw, applied: false }
      : applyResponseTransform(raw, responseMapping);

    if (outcome.error) {
      if (outcome.fatal) {
        return {
          result: {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  { error: `Response mapping failed: ${outcome.error}` },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          },
        };
      }
      this.logger.warn(
        `Response mapping for tool ${toolName} failed (${outcome.error}) — returning the raw response.`,
      );
    }

    // Response headers the tool opted into ride along with the (shaped)
    // body, after the transform so a `select` cannot drop them by accident.
    const value = meta
      ? attachResponseMeta(outcome.value, meta, queryParams)
      : outcome.value;

    const hint = responseMapping?.followUp
      ? `\n\n---\nWORKFLOW HINT (guidance for the assistant, not part of the API response): ${responseMapping.followUp}`
      : '';
    let resultText = (JSON.stringify(value, null, 2) ?? 'null') + hint;

    const limitBytes = toolMaxResponseBytes();
    if (!fitsResponseLimit(resultText, limitBytes)) {
      // Indentation can make up much of a large text. Only an object or an
      // array has any: anything else would serialize to the same text again.
      const prettyChars = resultText.length;
      if (value !== null && typeof value === 'object') {
        resultText = (JSON.stringify(value) ?? 'null') + hint;
      }
      if (!fitsResponseLimit(resultText, limitBytes)) {
        const tooLarge = new ResponseTooLargeError(limitBytes, { source: 'result' });
        this.logger.warn({
          msg: 'tool_result_too_large',
          toolName,
          limitBytes,
          // Characters, a lower bound of the bytes: measuring them would walk
          // the whole text once more just for this line.
          renderedChars: prettyChars,
          compactChars: resultText.length,
        });
        return {
          result: {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: tooLarge.message, code: tooLarge.code }, null, 2),
              },
            ],
            isError: true,
          },
          tooLarge,
        };
      }
    }

    // `responseMapping.images`: the pictures follow the text, which keeps a
    // placeholder for each. Text stays first, so whatever reads content[0]
    // (the call log, older clients) still finds the JSON there.
    const images = (outcome.images ?? []).map((img) => ({
      type: 'image' as const,
      data: img.data,
      mimeType: img.mimeType,
    }));

    return {
      result: {
        content: [{ type: 'text' as const, text: resultText }, ...images, ...binaryContent],
        structured: value,
      },
    };
  }

  private buildCacheKey(
    tool: RegisteredTool,
    params: Record<string, unknown>,
    scope?: string,
  ): string {
    // Keys sorted at every depth: a nested filter is part of the request.
    const paramsHash = hashContent(params);
    // v3: keyed by the tool's id, not its name. Two connectors (in one org or
    // in two) can expose a tool with the same name, and one connector's
    // answer must never be served for the other. v2 keys simply expire.
    return `tool_cache:v3:${tool.id}:${scope ? `${scope}:` : ''}${paramsHash}`;
  }

  /**
   * Inject connector env vars into params. If an env var key matches a
   * parameter name and the caller didn't provide a value, use the env var.
   */
  private injectEnvVars(
    params: Record<string, unknown>,
    envVars: Record<string, string>,
  ): Record<string, unknown> {
    if (!envVars || Object.keys(envVars).length === 0) return params;

    const result = { ...params };
    for (const [key, value] of Object.entries(envVars)) {
      if (result[key] === undefined) {
        result[key] = value;
      }
    }
    return result;
  }

  private applyDefaults(
    schema: Record<string, unknown>,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    return applySchemaDefaults(schema, params);
  }


  /**
   * Build the string persisted in the tool_invocations.error column. Beyond the
   * HTTP status line, it folds in the upstream API response body — that body
   * carries the actual cause (e.g. weclapp "unknown property: customerName",
   * Odds API "Missing eventId", Graph API "code 190 invalid token") which the
   * bare axios message ("Request failed with status code 400") hides. Keeping it
   * in the audit log makes failures diagnosable without re-running the call.
   */
  private formatStoredError(detail: Record<string, unknown>): string {
    const parts: string[] = [];
    const head = detail.status
      ? `${detail.status} ${detail.statusText || ''}`.trim()
      : '';
    if (head) parts.push(head);
    if (detail.error) parts.push(String(detail.error));

    if (detail.responseBody !== undefined && detail.responseBody !== null) {
      let body =
        typeof detail.responseBody === 'string'
          ? detail.responseBody
          : JSON.stringify(detail.responseBody);
      if (body.length > 600) body = `${body.slice(0, 600)}…`;
      if (body && body !== '{}' && body !== '""' && body !== '[]') {
        parts.push(`body=${body}`);
      }
    }

    return parts.length > 0 ? parts.join(': ') : String(detail.error ?? 'Unknown error');
  }

  /**
   * Extract rich error details from different error types so that the AI
   * client receives enough context to understand the failure and retry.
   */
  private extractErrorDetail(error: any): Record<string, unknown> {
    if (error instanceof AxiosError && error.response) {
      const res = error.response;

      // Pick only headers useful for the AI to decide on retries
      const relevantHeaders: Record<string, string> = {};
      const headerKeys = [
        'retry-after',
        'x-ratelimit-limit',
        'x-ratelimit-remaining',
        'x-ratelimit-reset',
        'www-authenticate',
        'content-type',
      ];
      for (const key of headerKeys) {
        const value = res.headers?.[key];
        if (value) relevantHeaders[key] = String(value);
      }

      const detail: Record<string, unknown> = {
        error: error.message,
        status: res.status,
        statusText: res.statusText,
      };

      // Include the API response body (the most useful part for the AI)
      if (res.data !== undefined && res.data !== null && res.data !== '') {
        detail.responseBody = res.data;
      }

      if (Object.keys(relevantHeaders).length > 0) {
        detail.responseHeaders = relevantHeaders;
      }

      return detail;
    }

    // AxiosError without a response (network error, timeout, DNS failure)
    if (error instanceof AxiosError) {
      return {
        error: error.message,
        code: error.code, // e.g. ECONNREFUSED, ECONNABORTED, ETIMEDOUT
      };
    }

    // SOAP errors enriched by SoapEngine
    if (error.soapDetail) {
      return error.soapDetail as Record<string, unknown>;
    }

    // A 200 whose body the connector's errorWhen rules read as an error: the
    // body is what the model needs, as with an HTTP error.
    if (error instanceof ResponseBodyError) {
      return { error: error.message, responseBody: error.responseBody };
    }

    // Generic errors (database, etc.)
    const detail: Record<string, unknown> = { error: error.message };
    if (error.code) detail.code = error.code;
    return detail;
  }

  /**
   * Execute a saved code tool: run its stored program in the out-of-process
   * code-runner, giving it a bridge scoped to the tool's `uses`, the caller's
   * role (in `invoker` mode) and its read/write setting. Every inner tool call
   * goes back through `executeTool` (so licence, tenant scope and audit apply to
   * each), with `inCodeRun` set so no code tool can be reached recursively.
   */
  private async executeCodeTool(
    tool: RegisteredTool,
    params: Record<string, unknown>,
    context?: CodeExecContext,
  ): Promise<{ content: ToolResultContent; isError?: boolean; structured?: unknown }> {
    const startTime = Date.now();
    const spec = parseCodeToolMapping(tool.endpointMapping);
    const fail = (message: string, name = 'Error'): { content: ToolResultContent; isError: true } => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ error: message, name }, null, 2) }],
      isError: true,
    });

    if (!spec) return fail('This tool is not a valid code tool.');
    if (!this.codeExecutor || !this.codeExecutor.isConfigured()) {
      return fail('Code mode is not available on this instance (no code-runner configured).', 'Unavailable');
    }

    // Per-server master switch. Code mode is off by default; a code tool reached
    // through a server whose codeMode is 'off' does not run. Calls without a
    // server (an instance-level operator credential on a single-tenant box)
    // have no switch to consult and are allowed, like every other tool there.
    if (context?.mcpServerId) {
      const server = await this.prisma.mcpServerConfig.findUnique({
        where: { id: context.mcpServerId },
        select: { codeMode: true },
      });
      if (!server || server.codeMode === 'off') {
        return fail('Code mode is turned off for this MCP server.', 'CodeModeOff');
      }
    }

    // The connectors this code tool may reach, and the caller's role scope.
    const usesConnectorIds = spec.uses.map((u) => u.connectorId);
    // `invoker` mode must know the caller's allowed tool ids. null = unrestricted
    // (ADMIN/operator). Unknown for an identified user → fail closed (deny inner
    // calls) rather than guess; definer mode does not use it.
    const allowedToolIds: string[] | null =
      context?.allowedToolIds !== undefined
        ? context.allowedToolIds
        : context?.userId
          ? []
          : null;

    const deps = this.codeBridgeDeps(usesConnectorIds, allowedToolIds, context);
    const bridge = buildCodeBridge(spec, deps);
    // The program receives its tool arguments as `args` via a wrapper the runner
    // does not add, so expose them through a declared variable: prepend a const.
    const program = `const args = ${JSON.stringify(params ?? {})};\n${spec.code}`;

    const result = await this.codeExecutor.run({ code: program, bridge });
    const durationMs = Date.now() - startTime;

    // One code_runs row for the run itself (retention/quotas); the inner tool
    // calls keep their own tool_invocations rows. Best-effort: a failed audit
    // write must never fail the run. Uses the tool's own org, always present.
    void this.prisma.codeRun
      .create({
        data: {
          organizationId: tool.organizationId,
          userId: context?.userId,
          mcpServerId: context?.mcpServerId,
          toolId: tool.id,
          source: 'tool',
          status: result.ok ? 'SUCCESS' : 'ERROR',
          durationMs,
          toolCallCount: result.calls.length,
          error: result.ok ? undefined : (result.error?.message ?? 'code run failed').slice(0, 2000),
        },
      })
      .catch((e) => this.logger.warn(`code_runs audit write failed: ${e?.message ?? e}`));

    // One audit row for the code tool itself; each inner call logged its own.
    await this.auditService.logInvocation({
      toolId: tool.id,
      userId: context?.userId,
      userEmail: context?.userEmail,
      mcpServerId: context?.mcpServerId,
      organizationId: context?.organizationId,
      connectorId: tool.connectorId,
      usedProxy: false,
      intent: context?.intent,
      learnable: context?.learnable ?? false,
      input: params,
      output: result.ok ? ({ value: result.value } as Record<string, unknown>) : undefined,
      status: result.ok ? 'SUCCESS' : 'ERROR',
      durationMs,
      error: result.ok ? undefined : this.formatStoredError({ error: result.error?.message ?? 'code run failed' }),
      clientInfo: context
        ? JSON.stringify({
            authMethod: context.authMethod,
            apiKeyName: context.apiKeyName,
            userEmail: context.userEmail,
            mcpServerName: context.mcpServerName,
            codeRun: true,
            toolCalls: result.calls.length,
          })
        : undefined,
    });
    this.logToolCall(tool, context, durationMs, result.ok ? 'SUCCESS' : 'ERROR');
    return this.codeResultToContent(result);
  }

  /**
   * Run an inline code program (the generic `code_execute` tool): a program the
   * model wrote on the spot, read-only, with the caller's own permissions, over
   * the connectors reachable on this server. Unlike a saved code tool there is
   * no McpTool, so only a `code_runs` row is written (source `inline`); the
   * inner tool calls still log their own `tool_invocations`. Exposure is gated
   * by the caller (server codeMode `inline` + the role's `inlineCode`
   * capability); this method enforces read-only and invoker rights.
   */
  /** Whether a code-runner is configured, so code mode can run at all. */
  codeModeAvailable(): boolean {
    return !!this.codeExecutor?.isConfigured();
  }

  async executeInlineCode(
    code: string,
    context: CodeExecContext,
    opts: { connectorIds: string[]; allowedToolIds: string[] | null },
  ): Promise<{ content: ToolResultContent; isError?: boolean; structured?: unknown }> {
    const startTime = Date.now();
    const fail = (message: string, name = 'Error'): { content: ToolResultContent; isError: true } => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ error: message, name }, null, 2) }],
      isError: true,
    });
    if (typeof code !== 'string' || !code.trim()) return fail('No code was provided to run.');
    if (!this.codeExecutor || !this.codeExecutor.isConfigured()) {
      return fail('Code mode is not available on this instance (no code-runner configured).', 'Unavailable');
    }

    // Inline code is always read-only, invoker rights, over exactly the
    // connectors the caller can reach on this server.
    const spec = {
      code,
      uses: opts.connectorIds.map((connectorId) => ({ connectorId })),
      runAs: 'invoker' as const,
      allowWrites: false,
    };
    const deps = this.codeBridgeDeps(opts.connectorIds, opts.allowedToolIds, context);
    const bridge = buildCodeBridge(spec, deps);
    const program = `const args = {};\n${code}`;

    const result = await this.codeExecutor.run({ code: program, bridge });
    const durationMs = Date.now() - startTime;

    if (context.organizationId) {
      void this.prisma.codeRun
        .create({
          data: {
            organizationId: context.organizationId,
            userId: context.userId,
            mcpServerId: context.mcpServerId,
            toolId: null,
            source: 'inline',
            status: result.ok ? 'SUCCESS' : 'ERROR',
            durationMs,
            toolCallCount: result.calls.length,
            error: result.ok ? undefined : (result.error?.message ?? 'code run failed').slice(0, 2000),
          },
        })
        .catch((e) => this.logger.warn(`code_runs audit write failed: ${e?.message ?? e}`));
    }

    return this.codeResultToContent(result);
  }

  /**
   * The CodeBridgeDeps shared by saved code tools and inline code: resolve a
   * tool within the allowed connectors, run it back through executeTool (so
   * licence, tenant scope and audit apply, with inCodeRun set), and search /
   * describe over the same set. The access rules (uses, read/write, role) are
   * applied by buildCodeBridge around these, per the spec.
   */
  private codeBridgeDeps(
    usesConnectorIds: string[],
    allowedToolIds: string[] | null,
    context?: CodeExecContext,
  ): CodeBridgeDeps {
    const toBridgeTool = (t: RegisteredTool): BridgeResolvedTool => ({
      id: t.id,
      name: t.name,
      connectorId: t.connectorId,
      readOnly:
        deriveToolAnnotations({
          name: t.name,
          connectorType: t.connectorType,
          endpointMapping: t.endpointMapping as { method?: string; path?: string },
          connectorConfig: { config: t.connectorConfig?.config ?? null },
          annotations: t.annotations,
        }).readOnlyHint === true,
      isCode: isCodeMethod(t.endpointMapping),
    });

    return {
      resolveTool: (name) => {
        const resolved = this.toolRegistry.getTool(name, usesConnectorIds);
        return resolved ? toBridgeTool(resolved) : undefined;
      },
      allowedToolIds,
      runTool: async (name, args, connectorId) => {
        const r = await this.executeTool(name, args, {
          ...context,
          connectorIds: [connectorId],
          allowedToolIds,
          inCodeRun: true,
        });
        if (r.isError) {
          throw new Error(textOf(r.content) ?? `Tool '${name}' failed.`);
        }
        if (r.structured !== undefined) return r.structured;
        const text = textOf(r.content);
        try {
          return text ? JSON.parse(text) : null;
        } catch {
          return text ?? null;
        }
      },
      search: async (query) => {
        const q = query.toLowerCase().trim();
        const seen = new Set<string>();
        const out: { tool: string; description: string; readOnly: boolean }[] = [];
        for (const connectorId of usesConnectorIds) {
          for (const t of this.toolRegistry.getAllTools()) {
            if (t.connectorId !== connectorId || isCodeMethod(t.endpointMapping)) continue;
            if (seen.has(t.name)) continue;
            const hay = `${t.name} ${t.description ?? ''}`.toLowerCase();
            if (q && !hay.includes(q)) continue;
            seen.add(t.name);
            out.push({ tool: t.name, description: t.description ?? '', readOnly: toBridgeTool(t).readOnly });
            if (out.length >= 50) return out;
          }
        }
        return out;
      },
      describe: async (name) => {
        const resolved = this.toolRegistry.getTool(name, usesConnectorIds);
        if (!resolved) return null;
        return {
          name: resolved.name,
          description: resolved.description ?? '',
          inputSchema: resolved.parameters ?? {},
          readOnly: toBridgeTool(resolved).readOnly,
        };
      },
    };
  }

  /** Turn a code-run result into a tool result (shared by tool and inline runs). */
  private codeResultToContent(result: {
    ok: boolean;
    value?: unknown;
    error?: { name: string; message: string };
    logs: { level: string; message: string }[];
  }): { content: ToolResultContent; isError?: boolean; structured?: unknown } {
    if (result.ok) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.value ?? null, null, 2) }],
        structured: result.value,
      };
    }
    // A refused tool call surfaces as the access error the bridge threw.
    const name = result.error?.name === 'CodeToolAccessError' ? 'AccessDenied' : result.error?.name ?? 'Error';
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            { error: result.error?.message ?? 'code run failed', name, logs: result.logs.slice(-20) },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  private async executeWithEngine(
    connectorType: string,
    config: any,
    endpointMapping: any,
    params: Record<string, unknown>,
    extra?: { connectorConfig?: Record<string, unknown>; odataSettings?: unknown; emailSettings?: unknown },
  ): Promise<{ body: unknown; meta?: ResponseMeta }> {
    // Static response tools — return text immediately without engine dispatch.
    //
    // The `method` alone decides this, not `method && staticResponse`. With the
    // old `&&`, a static tool whose staticResponse was missing fell through to
    // the engine below, which built a URL from an endpointMapping that has no
    // `path` and died with "Cannot read properties of undefined (reading
    // 'replace')" — a message naming neither the tool nor the real problem.
    // api-football's af_analysis_playbook spent six weeks failing that way.
    if (endpointMapping.method === 'static') {
      return { body: { text: renderStaticResponse(endpointMapping, params) } };
    }

    // OData built-ins (`odata_*`) run on ODATA connectors and on REST
    // connectors that carry `config.odata`; the ODATA type sends its plain
    // HTTP tools through the same engine for sap-client and V2 unwrapping.
    if (
      connectorType === 'ODATA' ||
      (connectorType === 'REST' && isODataBuiltinMethod(endpointMapping.method))
    ) {
      if (!this.odataEngine) throw new Error('The OData engine is not available.');
      return {
        body: await this.odataEngine.execute(
          config,
          endpointMapping,
          params,
          extra?.odataSettings ?? (extra?.connectorConfig as any)?.odata,
        ),
      };
    }

    switch (connectorType) {
      case 'REST': {
        // Only a tool that asked for headers pays for them; every other REST
        // call stays on the body-only path it always had.
        const wanted = endpointMapping.exposeHeaders;
        if (Array.isArray(wanted) && wanted.length > 0) {
          const out = await this.restEngine.executeWithMeta(
            config,
            endpointMapping,
            params,
          );
          return { body: out.body, meta: { headers: out.headers } };
        }
        return {
          body: await this.restEngine.execute(config, endpointMapping, params),
        };
      }
      case 'GRAPHQL':
        return {
          body: await this.graphqlEngine.execute(config, endpointMapping, params),
        };
      case 'SOAP':
        return {
          body: await this.soapEngine.execute(config, endpointMapping, params),
        };
      case 'MCP':
        return {
          body: await this.mcpClientEngine.execute(config, endpointMapping, params),
        };
      case 'EMAIL': {
        if (!this.emailEngine) throw new Error('The email engine is not available.');
        return {
          body: await this.emailEngine.execute(
            { authConfig: config.authConfig, baseUrl: config.baseUrl },
            endpointMapping,
            params,
            extra?.emailSettings ?? (extra?.connectorConfig as { email?: unknown } | undefined)?.email,
          ),
        };
      }
      case 'DATABASE': {
        const connectorConfig = extra?.connectorConfig as any;
        const readOnly = connectorConfig?.readOnly !== false;
        return {
          body: await this.databaseEngine.execute(config, endpointMapping, params, {
            readOnly,
            deniedTables: connectorConfig?.deniedTables,
          }),
        };
      }
      default:
        throw new Error(`Unsupported connector type: ${connectorType}`);
    }
  }
}

/** The text of a tool result, which is always its first item. */
function textOf(content: ToolResultContent | undefined): string | undefined {
  return content?.[0]?.text;
}
