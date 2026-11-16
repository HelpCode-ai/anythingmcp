import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { createHmac, randomInt } from 'node:crypto';
import { PrismaService } from '../../common/prisma.service';
import { decrypt, encrypt } from '../../common/crypto/encryption.util';
import { getRequiredSecret } from '../../common/secrets.util';
import { assertSafeOutboundUrl } from '../../common/ssrf.util';
import { outboundAxiosOptions } from '../../common/outbound-http';
import { connectorPageUrl } from '../../common/url.util';
import { ConnectorAuthStatusService, credentialRef } from './connector-auth-status.service';
import { ResponseBodyError } from './response-error.util';
import { decryptSheinSecretKey, SheinSecretError } from './shein-secret.util';

/**
 * Shop keys of the SHEIN Open Platform (open.sheincorp.com).
 *
 * WHY. SHEIN signs every seller call with two values of the shop, its
 * `openKeyId` and its `secretKey` (the "Signature Rules" page: HMAC-SHA256
 * over `openKeyId&timestamp&path`, keyed with `secretKey` + 5 random
 * characters; the REST engine already signs that way, see the comment above
 * applyHmacSignature). A seller does not copy those values anywhere: SHEIN's
 * "Store Authorization Application Manual" has the app send the seller to
 * `https://openapi-sem.sheincorp.com/#/empower?appid=…&redirectUrl=<Base64 of
 * the callback URL>&state=…`; after the seller approves, SHEIN sends the
 * browser back to the callback with `appid`, `tempToken` (valid 10 minutes)
 * and `state`, and the app exchanges the tempToken at
 * `POST /open-api/auth/get-by-token`, signed with the APP's id and secret
 * (header `x-lt-appid` instead of `x-lt-openKeyId`). The answer carries the
 * shop's `openKeyId` and its `secretKey` encrypted with the app secret
 * (decryptSheinSecretKey). SHEIN documents no lifetime for them and no
 * refresh. The `authorization_change_notice` webhook lists how an
 * authorization ends: the seller unbinds the app or resets the key, the shop
 * is closed, SHEIN resets the key or unbinds the app, or the authorization
 * expires on its own. Calls then fail, with `openapi00004` ("The user [...]
 * has expired": authorize again) or a signature error, until the seller
 * authorizes again.
 *
 * A connector opts in with `authType: "HMAC"` and `authConfig.tokenProvider:
 * "shein"`. Nothing else uses this service. Where SHEIN lives is adapter
 * configuration:
 *
 *   authConfig.shein.appId         the app's App ID (x-lt-appid, `appid`)
 *   authConfig.shein.appSecret     the app's App Secret (signs get-by-token,
 *                                  decrypts the shop's secretKey)
 *   authConfig.shein.authorizeUrl  https URL of the seller authorize page,
 *                                  hash route included (`…/#/empower`)
 *   authConfig.shein.tokenBaseUrl  https URL the token path is appended to
 *                                  (the API host of the app's type)
 *   authConfig.shein.tokenPath     `/open-api/auth/get-by-token`
 *
 * The adapter's `signature` block names the shop's values as `${openKeyId}`
 * and `${secretKey}` (in `secret`, `template` and `extraHeaders`); before
 * each call the provider fills them in, in memory, from the stored
 * authorization. Stored on the connector, in its encrypted authConfig:
 * openKeyId, secretKey (decrypted), supplierId, supplierBusinessMode,
 * authorizedAt.
 *
 * Never logs a key, the app secret, a tempToken or a signature.
 */

export const SHEIN_TOKEN_PROVIDER = 'shein';

/** Where SHEIN sends the seller back: register `<SERVER_URL>` + this as the app's redirect URL. */
export const SHEIN_CALLBACK_PATH = '/api/shein-auth/callback';

/** The placeholders an adapter's signature block uses for the shop's keys. */
export const SHEIN_OPEN_KEY_ID_VAR = '${openKeyId}';
export const SHEIN_SECRET_KEY_VAR = '${secretKey}';

/** SHEIN's code for a shop key it no longer accepts: "The user [...] has expired". */
export const SHEIN_KEY_EXPIRED_CODE = 'openapi00004';
/** SHEIN's code for a refused signature (also what a changed or revoked secretKey gives). */
export const SHEIN_SIGNATURE_CODE = 'openapi00001';

const HTTP_TIMEOUT_MS = 10_000;
/** SHEIN: "5 random characters" in front of the signature. */
const NONCE_LENGTH = 5;
const NONCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** The random characters of one signature (A-Z a-z 0-9). */
export function sheinNonce(length = NONCE_LENGTH): string {
  let out = '';
  for (let i = 0; i < length; i++) out += NONCE_ALPHABET[randomInt(NONCE_ALPHABET.length)];
  return out;
}

/** Whether a connector's auth gets the shop's keys from SHEIN's store authorization. */
export function isSheinAuth(authType: string | undefined, authConfig: unknown): boolean {
  return (
    authType === 'HMAC' &&
    !!authConfig &&
    typeof authConfig === 'object' &&
    (authConfig as { tokenProvider?: unknown }).tokenProvider === SHEIN_TOKEN_PROVIDER
  );
}

const usable = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && !/\{\{/.test(v);

/** Whether a SHEIN connector still needs the seller to authorize it (no stored shop keys). */
export function sheinNeedsAuthorization(authType: string | undefined, authConfig: unknown): boolean {
  if (!isSheinAuth(authType, authConfig)) return false;
  const ac = authConfig as Record<string, unknown>;
  return !usable(ac.openKeyId) || !usable(ac.secretKey);
}

/**
 * SHEIN's signature (Signature Rules): HMAC-SHA256 over
 * `id&timestamp&path` (the path without the query), keyed with the secret
 * followed by `nonce`; the lower-case hex digest is Base64-encoded as text
 * and the nonce goes in front. `id` is the shop's openKeyId for a seller
 * call, the app's App ID for get-by-token.
 */
export function sheinSignature(id: string, secret: string, path: string, timestamp: string, nonce: string): string {
  const hex = createHmac('sha256', secret + nonce).update(`${id}&${timestamp}&${path}`, 'utf8').digest('hex');
  return nonce + Buffer.from(hex, 'utf8').toString('base64');
}

/** What the service needs to authorize a shop for one connector. */
export interface SheinApp {
  appId: string;
  appSecret: string;
  /** e.g. https://openapi-sem.sheincorp.com/#/empower */
  authorizeUrl: string;
  /** e.g. https://openapi.sheincorp.com */
  tokenBaseUrl: string;
  tokenPath: string;
}

function httpsUrl(v: string): boolean {
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The app settings of a SHEIN connector from its resolved authConfig
 * (variables substituted). Undefined when one is missing, still a `{{VAR}}`,
 * or not an https URL / a path.
 */
export function sheinAppFrom(authConfig: Record<string, unknown> | undefined): SheinApp | undefined {
  if (!authConfig) return undefined;
  const shein = (authConfig.shein ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => (v === undefined || v === null ? '' : String(v).trim());
  const appId = text(shein.appId);
  const appSecret = text(shein.appSecret);
  const authorizeUrl = text(shein.authorizeUrl);
  const tokenBaseUrl = text(shein.tokenBaseUrl).replace(/\/+$/, '');
  const tokenPath = text(shein.tokenPath);
  if (![appId, appSecret, authorizeUrl, tokenBaseUrl, tokenPath].every(usable)) return undefined;
  if (!httpsUrl(authorizeUrl) || !httpsUrl(tokenBaseUrl)) return undefined;
  if (!tokenPath.startsWith('/')) return undefined;
  return { appId, appSecret, authorizeUrl, tokenBaseUrl, tokenPath };
}

/**
 * The link a seller opens to authorize the app, as SHEIN's manual builds it:
 * the authorize page (a hash route, so the parameters follow the fragment),
 * then `appid`, `redirectUrl` (the callback URL in standard Base64, as the
 * manual's `btoa` and Java `Base64.getEncoder()` examples send it) and
 * `state`.
 */
export function buildSheinAuthorizationUrl(app: SheinApp, redirectUri: string, state: string): string {
  const redirect = Buffer.from(redirectUri, 'utf8').toString('base64');
  const sep = app.authorizeUrl.includes('?') ? '&' : '?';
  return (
    `${app.authorizeUrl}${sep}appid=${encodeURIComponent(app.appId)}` +
    `&redirectUrl=${redirect}&state=${encodeURIComponent(state)}`
  );
}

/** A SHEIN answer that is an error: HTTP 4xx/5xx, or a `code` other than "0". */
export function sheinError(err: unknown): { status?: number; code?: string; message?: string } | undefined {
  const res = (err as { response?: { status?: unknown; data?: unknown } })?.response;
  const data = (res?.data ?? (err as { responseBody?: unknown })?.responseBody) as Record<string, unknown> | undefined;
  const status = typeof res?.status === 'number' ? res.status : (err as { status?: unknown })?.status;
  if (!data || typeof data !== 'object') {
    return typeof status === 'number' ? { status } : undefined;
  }
  const rawCode = data.code;
  const code =
    (typeof rawCode === 'string' || typeof rawCode === 'number') && String(rawCode).trim() !== '' && String(rawCode) !== '0'
      ? String(rawCode).slice(0, 80)
      : undefined;
  const msg = data.msg ?? data.message;
  return {
    status: typeof status === 'number' ? status : undefined,
    code,
    message: typeof msg === 'string' && msg ? msg.slice(0, 200) : undefined,
  };
}

/** A SHEIN failure in words safe to log and to show: status, SHEIN's code and message. */
export function describeSheinError(err: unknown): string {
  const e = sheinError(err);
  if (e && (e.status !== undefined || e.code)) {
    return [e.status !== undefined ? `HTTP ${e.status}` : undefined, e.code, e.message].filter(Boolean).join(': ');
  }
  // The decryption's own words never carry either value (shein-secret.util.ts).
  if (err instanceof SheinSecretError) return err.message;
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string') return code;
  const msg = (err as { message?: unknown })?.message;
  return typeof msg === 'string' && !/token|secret|signature/i.test(msg) ? msg.slice(0, 200) : 'network error';
}

/**
 * Whether a refused seller call says that SHEIN no longer accepts the shop's
 * key: `openapi00004` ("The user [...] has expired; authorize again"), in a
 * 2xx answer (an `errorWhen` rule) or the body of an HTTP error.
 */
export function isSheinKeyExpired(err: unknown): boolean {
  const body =
    err instanceof ResponseBodyError
      ? err.responseBody
      : (err as { response?: { data?: unknown } })?.response?.data;
  if (!body || typeof body !== 'object') return false;
  return String((body as { code?: unknown }).code ?? '') === SHEIN_KEY_EXPIRED_CODE;
}

/** Whether a refused seller call is SHEIN's `openapi00001` about the signature itself. */
export function isSheinSignatureRefused(err: unknown): boolean {
  const body =
    err instanceof ResponseBodyError
      ? err.responseBody
      : (err as { response?: { data?: unknown } })?.response?.data;
  if (!body || typeof body !== 'object') return false;
  if (String((body as { code?: unknown }).code ?? '') !== SHEIN_SIGNATURE_CODE) return false;
  // The same code also covers an expired timestamp and malformed headers,
  // which a new authorization does not fix.
  const msg = String((body as { msg?: unknown }).msg ?? '');
  return !/timestamp|header/i.test(msg);
}

/**
 * The connector's authConfig with the shop's keys filled into the signature
 * block: `${openKeyId}` and `${secretKey}` in `signature.secret`,
 * `signature.template` and the values of `signature.extraHeaders`, one pass
 * each so a filled value is never read as a placeholder again. A copy; the
 * stored authConfig is not changed.
 */
export function withSheinKeys(
  authConfig: Record<string, unknown>,
  keys: { openKeyId: string; secretKey: string },
): Record<string, unknown> {
  const fill = (v: unknown) =>
    typeof v === 'string'
      ? v.replace(/\$\{(openKeyId|secretKey)\}/g, (_m, name: string) => (name === 'openKeyId' ? keys.openKeyId : keys.secretKey))
      : v;
  const sig = (authConfig.signature ?? {}) as Record<string, unknown>;
  const extra =
    sig.extraHeaders && typeof sig.extraHeaders === 'object' && !Array.isArray(sig.extraHeaders)
      ? Object.fromEntries(Object.entries(sig.extraHeaders as Record<string, unknown>).map(([k, v]) => [k, fill(v)]))
      : sig.extraHeaders;
  return {
    ...authConfig,
    signature: {
      ...sig,
      secret: fill(sig.secret),
      template: fill(sig.template),
      ...(extra !== undefined ? { extraHeaders: extra } : {}),
    },
  };
}

type Config = { authType: string; authConfig?: Record<string, unknown>; connectorId?: string; baseUrl?: string };

function unauthorized(message: string, hint?: string): Error & { status: number; hint?: string } {
  const err = new Error(message) as Error & { status: number; hint?: string };
  err.status = 401;
  if (hint) err.hint = hint;
  return err;
}

function authorizeAgainHint(connectorId: string | undefined, reason: string): string {
  const page = connectorPageUrl(connectorId);
  return (
    `SHEIN ${reason}. Retrying will not help: the seller has to authorize the app again. Open the connector in ` +
    `AnythingMCP${page ? ` (${page})` : ''} and click Authorize with Provider, signed in to SHEIN with the shop's main account.`
  );
}

@Injectable()
export class SheinTokenService {
  private readonly logger = new Logger(SheinTokenService.name);
  private readonly encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @Optional() private readonly authStatus?: ConnectorAuthStatusService,
  ) {
    this.encryptionKey = getRequiredSecret('ENCRYPTION_KEY', this.configService.get<string>('ENCRYPTION_KEY'));
  }

  /**
   * The config a seller call signs with: the stored openKeyId and secretKey
   * filled into the signature block. Throws (status 401, nothing sent) while
   * the seller has not authorized the app.
   */
  signingConfig<T extends Config>(config: T): T {
    const ac = config.authConfig ?? {};
    const openKeyId = usable(ac.openKeyId) ? ac.openKeyId.trim() : '';
    const secretKey = usable(ac.secretKey) ? ac.secretKey.trim() : '';
    if (!openKeyId || !secretKey) {
      const page = connectorPageUrl(config.connectorId);
      throw unauthorized(
        'The SHEIN shop has not authorized this connector yet. No request was sent to SHEIN. ' +
          `Open the connector in AnythingMCP${page ? ` (${page})` : ''} and click Authorize with Provider.`,
      );
    }
    return { ...config, authConfig: withSheinKeys(ac, { openKeyId, secretKey }) };
  }

  /**
   * A seller call SHEIN refused. `openapi00004` (the shop's key has expired
   * or was ended): the connector is marked as needing a new authorization,
   * with one email to the owner. A signature refusal may be the same thing
   * (the seller re-authorized elsewhere or reset the key), or a clock or
   * configuration problem, so it only gets the hint. Returns the hint for the
   * error, or undefined when the refusal is about something else.
   */
  async onRejected(config: Config, err: unknown): Promise<string | undefined> {
    if (isSheinKeyExpired(err)) {
      const message = authorizeAgainHint(
        config.connectorId,
        'no longer accepts this shop key (openapi00004: the authorization expired, was unbound by the seller, or the key was reset)',
      );
      if (config.connectorId) {
        const openKeyId = config.authConfig?.openKeyId;
        await this.authStatus?.mark(config.connectorId, {
          status: 'needs_reauth',
          code: 'shein_key_expired',
          message,
          ref: credentialRef(typeof openKeyId === 'string' ? openKeyId : ''),
        });
      }
      return message;
    }
    if (isSheinSignatureRefused(err)) {
      return (
        'SHEIN refused the signature (openapi00001). AnythingMCP signs exactly as SHEIN documents it, so this usually ' +
        "means the shop's key changed: the seller unbound or authorized the app again elsewhere, or reset the key in " +
        'the seller backend. Click Authorize with Provider on the connector to fetch the current key.'
      );
    }
    return undefined;
  }

  /**
   * Exchange the tempToken SHEIN sent back after the seller approved the
   * app, decrypt the shop's secretKey with the app secret and store both on
   * the connector. Throws with SHEIN's answer when it refuses.
   */
  async exchangeTempToken(input: { connectorId: string; app: SheinApp; tempToken: string }): Promise<{ supplierId?: string }> {
    const { app } = input;
    const url = `${app.tokenBaseUrl}${app.tokenPath}`;
    await assertSafeOutboundUrl(url);
    const timestamp = String(Date.now());
    const res = await axios.post(
      url,
      { tempToken: input.tempToken },
      {
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          Accept: 'application/json',
          language: 'en',
          'x-lt-appid': app.appId,
          'x-lt-timestamp': timestamp,
          'x-lt-signature': sheinSignature(app.appId, app.appSecret, new URL(url).pathname, timestamp, sheinNonce()),
        },
        timeout: HTTP_TIMEOUT_MS,
        ...outboundAxiosOptions({ credentialsInBody: true, credentialHeaders: ['x-lt-signature', 'x-lt-appid'] }),
      },
    );
    const data = res.data as Record<string, unknown> | undefined;
    const e = sheinError({ response: { status: res.status, data } });
    if (e?.code) {
      const err = new Error(`SHEIN refused the token request (${e.code})`) as Error & { response: { status: number; data: unknown } };
      err.response = { status: res.status, data };
      throw err;
    }
    const info = (data?.info ?? {}) as Record<string, unknown>;
    const openKeyId = typeof info.openKeyId === 'string' ? info.openKeyId.trim() : '';
    const encrypted = typeof info.secretKey === 'string' ? info.secretKey : '';
    if (!openKeyId || !encrypted) throw new Error('the SHEIN answer carried no openKeyId and secretKey');
    if (typeof info.appid === 'string' && info.appid && info.appid !== app.appId) {
      throw new Error('the SHEIN answer is for another app id');
    }
    const secretKey = decryptSheinSecretKey(encrypted, app.appSecret);
    const supplierId =
      typeof info.supplierId === 'number' || typeof info.supplierId === 'string' ? String(info.supplierId) : undefined;
    const now = Date.now();
    const saved = await this.persist(input.connectorId, {
      openKeyId,
      secretKey,
      supplierId,
      supplierBusinessMode: typeof info.supplierBusinessMode === 'string' && info.supplierBusinessMode ? info.supplierBusinessMode : undefined,
      authorizedAt: new Date(now).toISOString(),
    });
    if (!saved) throw new Error('the SHEIN shop keys could not be stored');
    await this.authStatus?.clear(input.connectorId);
    this.logger.log(`Connector ${input.connectorId}: SHEIN shop authorized`);
    return { supplierId };
  }

  /** Merge fields into the stored (encrypted) authConfig. False when the write failed. */
  private async persist(connectorId: string, patch: Record<string, unknown>): Promise<boolean> {
    try {
      const row = await this.prisma.connector.findUnique({ where: { id: connectorId }, select: { authConfig: true } });
      if (!row) return false;
      const current = row.authConfig ? JSON.parse(decrypt(row.authConfig, this.encryptionKey)) : {};
      await this.prisma.connector.update({
        where: { id: connectorId },
        data: { authConfig: encrypt(JSON.stringify({ ...current, ...patch }), this.encryptionKey) },
      });
      return true;
    } catch (err: any) {
      this.logger.warn(`Connector ${connectorId}: could not store the SHEIN shop keys (${err?.message ?? err})`);
      return false;
    }
  }
}
