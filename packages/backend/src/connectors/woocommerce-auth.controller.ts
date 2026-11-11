import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  GoneException,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  OnApplicationShutdown,
  Optional,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches, MaxLength, validateSync } from 'class-validator';
import { json, type RequestHandler } from 'express';
import type { Connector } from '../generated/prisma/client';
import { ConnectorsService } from './connectors.service';
import { McpOAuthService, isLocalOnlyHost, type PendingOAuthFlow } from './mcp-oauth.service';
import { McpServerService } from '../mcp-server/mcp-server.service';
import { getRequiredSecret } from '../common/secrets.util';
import { SsrfBlockedError, assertSafeOutboundUrl } from '../common/ssrf.util';
import { outboundRequest } from '../common/outbound-http';
import { writeConnectorEnvVars } from './connector-env-write.util';

/**
 * WooCommerce "Connect with one click": the merchant approves a REST API key
 * on their own shop (`/wc-auth/v1/authorize`) instead of creating one and
 * pasting it. Off unless WOOCOMMERCE_ONE_CLICK=true, and offered only when
 * SERVER_URL is a public https address, because the shop posts the key to
 * this server.
 *
 *   1. POST /api/woocommerce/connectors/:id/authorize (signed in, owner or
 *      admin, never a VIEWER): stores a pending attempt (the same hashed,
 *      encrypted, single-use store the OAuth flows use, 15 minutes) and
 *      returns the shop's authorize link. Its `user_id` is the attempt state.
 *   2. The merchant signs in to WordPress and clicks Approve. WooCommerce
 *      creates the key and POSTs it, server to server, to
 *      POST /api/woocommerce/callback (unauthenticated). The attempt is taken
 *      (once), the key's shape checked, and the answer is 200 right away:
 *      WooCommerce deletes the key when that POST fails, and it waits for the
 *      answer before it sends the merchant back. The key is then tried on the
 *      shop address stored with the attempt (GET orders, through the SSRF
 *      guard) and, only when the shop accepts it, written through the same
 *      path as PUT /api/connectors/:id/env-vars, on the connector and
 *      workspace of the attempt.
 *   3. WooCommerce sends the browser back to the setup page, which polls
 *      GET /api/woocommerce/connectors/:id/one-click-status for the outcome.
 *
 * A forged callback needs the single-use state, and the key is only kept
 * when it works on the shop the user entered, so the worst a forger can do is
 * attach a working key of that same shop. The body is never logged.
 */

export const WOOCOMMERCE_ONE_CLICK_ENV = 'WOOCOMMERCE_ONE_CLICK';
export const WOOCOMMERCE_CALLBACK_PATH = '/api/woocommerce/callback';
/** WooCommerce posts five short fields; anything bigger is not it. */
export const WOOCOMMERCE_CALLBACK_MAX_BYTES = 4096;
const WOOCOMMERCE_SLUG = 'woocommerce';
const KEY_VAR = 'WOOCOMMERCE_CONSUMER_KEY';
const SECRET_VAR = 'WOOCOMMERCE_CONSUMER_SECRET';
const URL_VAR = 'WOOCOMMERCE_URL';
const CONSUMER_KEY_RE = /^ck_[a-f0-9]{40}$/;
const CONSUMER_SECRET_RE = /^cs_[a-f0-9]{40}$/;
/** McpOAuthService.generateState(): 16 random bytes, hex. */
const STATE_RE = /^[a-f0-9]{32}$/;
const VERIFY_TIMEOUT_MS = 15_000;
const EXPIRED_MESSAGE = 'This connection expired or was already used. Start it again from the setup page.';

export type WooCommerceScope = 'read' | 'read_write';

/**
 * Whether the one-click key may be used. `enabled`: the operator turned it on.
 * `available`: also, the shop can reach our callback (SERVER_URL is https and
 * not a local or private address; WooCommerce refuses those).
 */
export function wooCommerceOneClick(config: { get(key: string): unknown }): { enabled: boolean; available: boolean } {
  const enabled = String(config.get(WOOCOMMERCE_ONE_CLICK_ENV) ?? '').trim().toLowerCase() === 'true';
  let publicHttps = false;
  try {
    const server = new URL(String(config.get('SERVER_URL') ?? ''));
    publicHttps = server.protocol === 'https:' && !isLocalOnlyHost(server.hostname);
  } catch {
    publicHttps = false;
  }
  return { enabled, available: enabled && publicHttps };
}

/**
 * The shop root the key must work on: an https address without query,
 * fragment, login or a WordPress path after it, and no trailing slash.
 * Null for anything else.
 */
export function wooCommerceShopUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
  if (isLocalOnlyHost(url.hostname)) return null;
  const path = url.pathname.replace(/\/+$/, '');
  if (/\/(wp-json|wp-admin|wp-login\.php|wc-auth)(\/|$)/i.test(path)) return null;
  return `${url.origin}${path}`;
}

/**
 * The body parser of the callback route, mounted before the global one
 * (main.ts): JSON whatever the content type says, at most
 * WOOCOMMERCE_CALLBACK_MAX_BYTES (larger is answered 413 unread).
 */
export function wooCommerceCallbackBodyParser(): RequestHandler {
  return json({ limit: WOOCOMMERCE_CALLBACK_MAX_BYTES, type: () => true });
}

export type WooCommerceKeyCheck =
  | { ok: true }
  | {
      ok: false;
      kind: 'auth_failed' | 'blocked' | 'not_found' | 'unreachable' | 'upstream_error' | 'unexpected';
      status?: number;
      message: string;
    };

export interface WooCommerceVerifyDeps {
  assertSafe: (url: string) => Promise<void>;
  request: typeof outboundRequest;
}

/** Injection token to replace how keys are tried (tests); unset, the SSRF-guarded client is used. */
export const WOOCOMMERCE_VERIFY_DEPS = 'WOOCOMMERCE_VERIFY_DEPS';

const defaultVerifyDeps: WooCommerceVerifyDeps = {
  assertSafe: (url) => assertSafeOutboundUrl(url),
  request: outboundRequest,
};

/**
 * Try a key on the shop: one order id, with the key in the query string as the
 * adapter sends it. No redirect is followed: the key must work on the address
 * the connector will call. Messages never quote the key.
 */
export async function verifyWooCommerceKey(
  shopUrl: string,
  consumerKey: string,
  consumerSecret: string,
  deps: WooCommerceVerifyDeps = defaultVerifyDeps,
): Promise<WooCommerceKeyCheck> {
  const url = `${shopUrl}/wp-json/wc/v3/orders`;
  try {
    await deps.assertSafe(url);
  } catch {
    return {
      ok: false,
      kind: 'blocked',
      message: 'AnythingMCP may not connect to this shop address (it points to a private or local network).',
    };
  }
  let res: { status: number; data: unknown };
  try {
    res = await deps.request(
      {
        method: 'GET',
        url,
        params: { per_page: 1, _fields: 'id', consumer_key: consumerKey, consumer_secret: consumerSecret },
        headers: { Accept: 'application/json' },
        timeout: VERIFY_TIMEOUT_MS,
        maxRedirects: 0,
        validateStatus: () => true,
      },
      { maxRedirects: 0 },
    );
  } catch (err: any) {
    if (err instanceof SsrfBlockedError) {
      return {
        ok: false,
        kind: 'blocked',
        message: 'AnythingMCP may not connect to this shop address (it points to a private or local network).',
      };
    }
    const code = String(err?.code ?? '');
    const message =
      code === 'ENOTFOUND' || code === 'EAI_AGAIN'
        ? 'No site answers at this shop address. Check the spelling in the first step.'
        : code === 'ECONNABORTED' || code === 'ETIMEDOUT'
          ? 'The shop did not answer in time. Try again in a minute.'
          : /CERT|SSL|TLS|SELF_SIGNED/i.test(code)
            ? "The shop's https certificate is not valid. WooCommerce keys need a valid certificate; most hosts issue a free one (Let's Encrypt)."
            : 'The shop could not be reached. Check the address and try again.';
    return { ok: false, kind: 'unreachable', message };
  }
  const { status, data } = res;
  if (status >= 200 && status < 300) {
    if (Array.isArray(data)) return { ok: true };
    return {
      ok: false,
      kind: 'unexpected',
      status,
      message:
        'The shop answered, but not with WooCommerce data. A security plugin or a cache may be in the way of /wp-json/wc/.',
    };
  }
  if (status >= 300 && status < 400) {
    return {
      ok: false,
      kind: 'unexpected',
      status,
      message:
        `The shop sent the request to another address (HTTP ${status}). Use the address WordPress shows under ` +
        'Settings → General → Site Address, then connect again.',
    };
  }
  const wcCode = data && typeof data === 'object' ? String((data as { code?: unknown }).code ?? '') : '';
  if (status === 401) {
    return {
      ok: false,
      kind: 'auth_failed',
      status,
      message:
        wcCode === 'woocommerce_rest_cannot_view'
          ? 'The key was created, but its WordPress user may not see orders. Connect again while signed in to ' +
            'WordPress as an administrator or shop manager.'
          : 'WooCommerce did not accept the new key. Connect again; if it keeps failing, use the steps to paste a key.',
    };
  }
  if (status === 403) {
    return {
      ok: false,
      kind: 'auth_failed',
      status,
      message:
        "The site's firewall refused the call (Cloudflare, Wordfence, Sucuri or the host). Allow requests to " +
        '/wp-json/wc/ from the address of your AnythingMCP server, then connect again.',
    };
  }
  if (status === 404) {
    return {
      ok: false,
      kind: 'not_found',
      status,
      message:
        'No WooCommerce REST API at this address. Check the shop address, and that permalinks are not set to Plain ' +
        '(Settings → Permalinks).',
    };
  }
  return {
    ok: false,
    kind: status >= 500 ? 'upstream_error' : 'unexpected',
    status,
    message: `The shop answered with an error (HTTP ${status}). Check WooCommerce → Status → Logs and try again.`,
  };
}

export class WooCommerceAuthorizeDto {
  @ApiPropertyOptional({
    enum: ['read', 'read_write'],
    default: 'read',
    description: 'What the key may do: `read` (recommended to start) or `read_write`.',
  })
  @IsOptional()
  @IsIn(['read', 'read_write'])
  scope?: WooCommerceScope;

  @ApiPropertyOptional({ description: 'The assistant the setup was opened from (setup page `from=`), kept on the way back.' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9_-]{1,32}$/)
  from?: string;
}

/** What WooCommerce posts to the callback. Other fields are ignored. */
export class WooCommerceCallbackDto {
  @IsString()
  @Matches(STATE_RE)
  user_id!: string;

  @IsString()
  @MaxLength(200)
  consumer_key!: string;

  @IsString()
  @MaxLength(200)
  consumer_secret!: string;

  @IsOptional()
  @IsIn(['read', 'write', 'read_write'])
  key_permissions?: string;
}

export type WooCommerceOneClickStatus =
  | { status: 'working' | 'ready' | 'unknown' }
  | { status: 'failed'; message: string }
  | { status: 'pending' };

/** The record that tells the setup page how a callback ended, next to the attempt. */
function outcomeKey(state: string): string {
  return `woocommerce-outcome:${state}`;
}

@ApiTags('WooCommerce')
@Controller('api/woocommerce')
export class WooCommerceAuthController implements OnApplicationShutdown {
  private readonly logger = new Logger(WooCommerceAuthController.name);
  private readonly encryptionKey: string;
  private readonly verifyDeps: WooCommerceVerifyDeps;
  /** Callbacks answered and still being checked and stored. */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly connectorsService: ConnectorsService,
    private readonly oauthFlows: McpOAuthService,
    private readonly mcpServer: McpServerService,
    private readonly configService: ConfigService,
    @Optional() @Inject(WOOCOMMERCE_VERIFY_DEPS) verifyDeps?: WooCommerceVerifyDeps,
  ) {
    this.verifyDeps = verifyDeps ?? defaultVerifyDeps;
    this.encryptionKey = getRequiredSecret('ENCRYPTION_KEY', this.configService.get<string>('ENCRYPTION_KEY'));
  }

  private gate() {
    return wooCommerceOneClick(this.configService);
  }

  private serverUrl(): string {
    return String(this.configService.get<string>('SERVER_URL') || '').replace(/\/+$/, '');
  }

  private frontendUrl(): string {
    return (this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000').replace(/\/+$/, '');
  }

  /** Resolves once every answered callback has been checked and stored (tests, shutdown). */
  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.race([this.whenIdle(), new Promise((r) => setTimeout(r, VERIFY_TIMEOUT_MS + 5_000).unref())]);
  }

  @Get('one-click')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Whether the setup page may offer "Connect with one click" for WooCommerce',
    description:
      'True only when the server turned it on (WOOCOMMERCE_ONE_CLICK=true) and SERVER_URL is a public https ' +
      'address the shop can post the key to.',
  })
  oneClick(): { available: boolean } {
    return { available: this.gate().available };
  }

  @Post('connectors/:id/authorize')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Start a WooCommerce one-click key for a connector',
    description:
      "Returns the shop's /wc-auth/v1/authorize link, where the merchant approves a REST API key for AnythingMCP. " +
      'The connector must be a WooCommerce one with its shop address saved. Dashboard session only; the connector ' +
      'owner or an admin, never a VIEWER. 404 when the server does not offer one-click keys.',
  })
  async authorize(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: WooCommerceAuthorizeDto,
  ): Promise<{ authorizationUrl: string }> {
    if (!this.gate().available) throw new NotFoundException();
    const connector = await this.connectorsService.findById(id);
    if (connector.organizationId !== req.user?.organizationId) throw new ForbiddenException('Resource not found');
    if (req.user.role === 'VIEWER') throw new ForbiddenException('Viewers cannot modify connectors');
    if (connector.userId !== req.user.sub && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('Only the connector owner or an admin can modify this connector');
    }
    if ((connector.config as { adapterSlug?: unknown } | null)?.adapterSlug !== WOOCOMMERCE_SLUG) {
      throw new BadRequestException('This connector is not a WooCommerce connector.');
    }
    const envVars = (connector.envVars as Record<string, string> | null) ?? {};
    const shopUrl = wooCommerceShopUrl(envVars[URL_VAR]);
    if (!shopUrl) {
      throw new BadRequestException("Save the shop's https:// address first, then connect.");
    }
    const scope: WooCommerceScope = body?.scope === 'read_write' ? 'read_write' : 'read';
    const state = this.oauthFlows.generateState();
    const callbackUrl = `${this.serverUrl()}${WOOCOMMERCE_CALLBACK_PATH}`;
    await this.oauthFlows.storePendingFlow(state, {
      provider: 'woocommerce',
      connectorId: connector.id,
      userId: req.user.sub,
      redirectUri: callbackUrl,
      clientId: 'AnythingMCP',
      tokenUrl: `${shopUrl}/wc-auth/v1/authorize`,
      woocommerce: { organizationId: connector.organizationId, shopUrl, scope },
      createdAt: Date.now(),
    });
    const back = new URLSearchParams({ connector: connector.id, wc: 'done', ...(body?.from ? { from: body.from } : {}) });
    const query = new URLSearchParams({
      app_name: 'AnythingMCP',
      scope,
      user_id: state,
      return_url: `${this.frontendUrl()}/connectors/setup/${WOOCOMMERCE_SLUG}?${back.toString()}`,
      callback_url: callbackUrl,
    });
    return { authorizationUrl: `${shopUrl}/wc-auth/v1/authorize?${query.toString()}` };
  }

  // Called by WooCommerce, server to server; not an API to drive by hand.
  @Post('callback')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiExcludeEndpoint()
  async callback(@Req() req: { body?: unknown }): Promise<{ ok: true }> {
    if (!this.gate().enabled) throw new NotFoundException();
    // Validated here rather than by the global pipe, which refuses unknown
    // fields: a field WooCommerce adds one day must not make it delete the key.
    const body = plainToInstance(WooCommerceCallbackDto, req.body && typeof req.body === 'object' ? req.body : {});
    if (validateSync(body, { whitelist: false, forbidUnknownValues: false }).length > 0) {
      throw new BadRequestException('Not a WooCommerce key callback.');
    }
    const state = body.user_id;
    const record = await this.oauthFlows.takePendingFlow(state);
    const flow = record?.flow;
    if (!flow || flow.provider !== 'woocommerce' || !flow.woocommerce) {
      this.logger.warn('Refused a WooCommerce key callback: unknown, expired or used attempt');
      throw new GoneException(EXPIRED_MESSAGE);
    }
    if (!CONSUMER_KEY_RE.test(body.consumer_key) || !CONSUMER_SECRET_RE.test(body.consumer_secret)) {
      this.logger.warn(`Refused a WooCommerce key callback for connector ${flow.connectorId}: malformed key`);
      await this.recordOutcome(state, flow, 'failed', 'The shop sent a key AnythingMCP cannot use. Connect again.');
      throw new BadRequestException('Not a WooCommerce key.');
    }
    await this.recordOutcome(state, flow, 'working');
    const work = this.finish(state, flow, body.consumer_key, body.consumer_secret).finally(() => this.inFlight.delete(work));
    this.inFlight.add(work);
    return { ok: true };
  }

  @Get('connectors/:id/one-click-status')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'How a WooCommerce one-click key ended',
    description:
      '`state` is the `user_id` WooCommerce adds to the return address. `pending`: the shop has not sent the key ' +
      'yet; `working`: it is being checked; `ready`: stored and working; `failed`: not stored, with the reason; ' +
      '`unknown`: no such attempt (expired, or started by someone else). Dashboard session only.',
  })
  async oneClickStatus(
    @Req() req: any,
    @Param('id') id: string,
    @Query('state') rawState: unknown,
  ): Promise<WooCommerceOneClickStatus> {
    if (!this.gate().enabled) throw new NotFoundException();
    const connector = await this.connectorsService.findById(id);
    if (connector.organizationId !== req.user?.organizationId) throw new ForbiddenException('Resource not found');
    const state = typeof rawState === 'string' && STATE_RE.test(rawState) ? rawState : '';
    if (!state) return { status: 'unknown' };
    const mine = (flow: PendingOAuthFlow | undefined) =>
      !!flow && flow.connectorId === id && flow.userId === req.user.sub && !!flow.woocommerce;
    const outcome = (await this.oauthFlows.getPendingFlow(outcomeKey(state)))?.flow;
    if (outcome?.provider === 'woocommerce-outcome' && mine(outcome)) {
      const said = outcome.woocommerce!;
      if (said.outcome === 'failed') return { status: 'failed', message: said.message || 'The key was not stored.' };
      return { status: said.outcome === 'ready' ? 'ready' : 'working' };
    }
    const pending = (await this.oauthFlows.getPendingFlow(state))?.flow;
    if (pending?.provider === 'woocommerce' && mine(pending)) return { status: 'pending' };
    return { status: 'unknown' };
  }

  private async recordOutcome(
    state: string,
    flow: PendingOAuthFlow,
    outcome: 'working' | 'ready' | 'failed',
    message?: string,
  ): Promise<void> {
    try {
      await this.oauthFlows.deletePendingFlow(outcomeKey(state));
      await this.oauthFlows.storePendingFlow(outcomeKey(state), {
        ...flow,
        provider: 'woocommerce-outcome',
        woocommerce: {
          ...flow.woocommerce!,
          ...(outcome === 'working' ? {} : { outcome }),
          ...(message ? { message } : {}),
        },
        createdAt: Date.now(),
      });
    } catch (err: any) {
      // The setup page then waits and reports a timeout; the key itself is unaffected.
      this.logger.warn(`Could not record the WooCommerce key outcome of connector ${flow.connectorId}: ${err?.name}`);
    }
  }

  /** Check the key on the shop, then store it on the attempt's connector. Never throws. */
  private async finish(state: string, flow: PendingOAuthFlow, consumerKey: string, consumerSecret: string): Promise<void> {
    const woo = flow.woocommerce!;
    const fail = async (message: string, why: string) => {
      this.logger.warn(`WooCommerce one-click key not stored for connector ${flow.connectorId}: ${why}`);
      await this.recordOutcome(state, flow, 'failed', message);
    };
    try {
      const check = await verifyWooCommerceKey(woo.shopUrl, consumerKey, consumerSecret, this.verifyDeps);
      if (!check.ok) {
        await fail(
          `${check.message} The key WooCommerce created for AnythingMCP was not used: you can revoke it under ` +
            'WooCommerce → Settings → Advanced → REST API.',
          `${check.kind}${check.status ? ` ${check.status}` : ''}`,
        );
        return;
      }
      let connector: Connector;
      try {
        connector = await this.connectorsService.findByIdInternal(flow.connectorId);
      } catch {
        await fail('The connector was deleted while connecting.', 'connector gone');
        return;
      }
      if (connector.organizationId !== woo.organizationId) {
        await fail('The connector is no longer in the workspace that started the connection.', 'workspace changed');
        return;
      }
      if ((connector.config as { adapterSlug?: unknown } | null)?.adapterSlug !== WOOCOMMERCE_SLUG) {
        await fail('This connector is not a WooCommerce connector.', 'not a WooCommerce connector');
        return;
      }
      const stored = (connector.envVars as Record<string, string> | null) ?? {};
      if (wooCommerceShopUrl(stored[URL_VAR]) !== woo.shopUrl) {
        await fail('The shop address changed while connecting. Connect again.', 'shop address changed');
        return;
      }
      await writeConnectorEnvVars(
        { connectorsService: this.connectorsService, mcpServer: this.mcpServer, encryptionKey: this.encryptionKey },
        connector,
        { ...stored, [KEY_VAR]: consumerKey, [SECRET_VAR]: consumerSecret },
      );
      this.logger.log(`WooCommerce one-click key (${woo.scope}) stored for connector ${flow.connectorId}`);
      await this.recordOutcome(state, flow, 'ready');
    } catch (err: any) {
      // A name only: an error's message could quote what was sent.
      await fail('The key could not be stored. Connect again.', `error ${err?.name || 'unknown'}`);
    }
  }
}
