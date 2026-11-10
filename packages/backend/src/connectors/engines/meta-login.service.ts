import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { metaGraphError } from './bearer-token-renewal.service';
import { META_LOGIN_GRAPH_VERSION, MetaLoginApp, MetaLoginFlavour, cleanMetaCode } from './meta-login.util';

const HTTP_TIMEOUT_MS = 15_000;
const FB_GRAPH = `https://graph.facebook.com/${META_LOGIN_GRAPH_VERSION}`;
const IG_GRAPH = `https://graph.instagram.com/${META_LOGIN_GRAPH_VERSION}`;

/** An Instagram professional account the signed-in user can use. */
export interface MetaInstagramAccount {
  /** The Instagram professional account id (1784… on Facebook Login). */
  id: string;
  username?: string;
  /** The Facebook Page it is linked to (Facebook Login only). */
  pageName?: string;
}

export interface MetaLoginResult {
  /** The long-lived token to store. */
  token: string;
  /** ms epoch; null when Meta says it does not expire. */
  expiresAt: number | null;
  /** The accounts the token can act for. */
  accounts: MetaInstagramAccount[];
}

/**
 * A failed call to Meta while completing a login, in words safe to show and
 * log: status and Meta's own error, never the request (which carries the
 * code, the app secret or a token).
 */
export class MetaLoginError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MetaLoginError';
  }
}

function describe(err: unknown): MetaLoginError {
  if (err instanceof MetaLoginError) return err;
  const status = (err as { response?: { status?: unknown } })?.response?.status;
  const data = (err as { response?: { data?: unknown } })?.response?.data as
    | { error_message?: unknown; error_type?: unknown }
    | undefined;
  const graph = metaGraphError(err);
  // api.instagram.com answers with error_type / error_message instead of Graph's error object.
  const said =
    graph?.message ??
    (data && typeof data.error_message === 'string' ? data.error_message.slice(0, 200) : undefined);
  if (typeof status === 'number') {
    const code = graph?.code !== undefined ? ` (code ${graph.code}${graph.subcode ? `/${graph.subcode}` : ''})` : '';
    return new MetaLoginError(`HTTP ${status}${code}${said ? `: ${said}` : ''}`, status);
  }
  const e = err as { code?: unknown };
  return new MetaLoginError(typeof e?.code === 'string' ? e.code : 'network error');
}

function expiryOf(expiresIn: unknown): number | null {
  const seconds = Number(expiresIn);
  return Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : null;
}

/**
 * The provider calls of the Meta login: code → long-lived token → the
 * Instagram accounts it can use. Holds no state; storing is the
 * controller's job. Never logs a code, token or secret.
 */
@Injectable()
export class MetaLoginService {
  private readonly logger = new Logger(MetaLoginService.name);

  /** Exchange an authorization code and find the accounts the token can use. */
  async exchangeCode(input: {
    flavour: MetaLoginFlavour;
    app: MetaLoginApp;
    code: string;
    redirectUri: string;
  }): Promise<MetaLoginResult> {
    const code = cleanMetaCode(input.code);
    try {
      return input.flavour === 'instagram'
        ? await this.instagramLogin(input.app, code, input.redirectUri)
        : await this.facebookLogin(input.app, code, input.redirectUri);
    } catch (err) {
      throw describe(err);
    }
  }

  /** The Instagram accounts a Facebook User token reaches through its Pages. */
  async facebookAccounts(token: string): Promise<MetaInstagramAccount[]> {
    try {
      return await this.listFacebookAccounts(token);
    } catch (err) {
      throw describe(err);
    }
  }

  // ── Facebook Login ─────────────────────────────────────────────────────

  private async facebookLogin(app: MetaLoginApp, code: string, redirectUri: string): Promise<MetaLoginResult> {
    const short = await axios.get(`${FB_GRAPH}/oauth/access_token`, {
      params: { client_id: app.appId, client_secret: app.appSecret, redirect_uri: redirectUri, code },
      timeout: HTTP_TIMEOUT_MS,
    });
    const shortToken = short.data?.access_token;
    if (typeof shortToken !== 'string' || !shortToken) {
      throw new MetaLoginError('Facebook answered without an access token');
    }
    // A code gives a token for an hour or two; a long-lived one lasts about 60 days.
    const long = await axios.get(`${FB_GRAPH}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: app.appId,
        client_secret: app.appSecret,
        fb_exchange_token: shortToken,
      },
      timeout: HTTP_TIMEOUT_MS,
    });
    const token = long.data?.access_token;
    if (typeof token !== 'string' || !token) {
      throw new MetaLoginError('Facebook did not exchange the token for a long-lived one');
    }
    const accounts = await this.listFacebookAccounts(token);
    return { token, expiresAt: expiryOf(long.data?.expires_in), accounts };
  }

  private async listFacebookAccounts(token: string): Promise<MetaInstagramAccount[]> {
    const accounts: MetaInstagramAccount[] = [];
    let url: string | undefined = `${FB_GRAPH}/me/accounts`;
    let params: Record<string, string> | undefined = {
      fields: 'name,instagram_business_account{id,username}',
      limit: '100',
    };
    // A user with many Pages: follow the pages, but not forever.
    for (let page = 0; url && page < 10; page++) {
      const res: { data?: any } = await axios.get(url, {
        params: params ?? {},
        headers: { Authorization: `Bearer ${token}` },
        timeout: HTTP_TIMEOUT_MS,
      });
      for (const row of Array.isArray(res.data?.data) ? res.data.data : []) {
        const ig = row?.instagram_business_account;
        if (ig && typeof ig.id === 'string' && /^\d{5,25}$/.test(ig.id)) {
          accounts.push({
            id: ig.id,
            ...(typeof ig.username === 'string' ? { username: ig.username } : {}),
            ...(typeof row.name === 'string' ? { pageName: row.name } : {}),
          });
        }
      }
      // `next` carries the token in its query string: send it as a header instead.
      const next: unknown = res.data?.paging?.next;
      if (typeof next === 'string' && next.startsWith(`${FB_GRAPH}/`)) {
        const parsed = new URL(next);
        parsed.searchParams.delete('access_token');
        url = `${parsed.origin}${parsed.pathname}`;
        params = Object.fromEntries(parsed.searchParams);
      } else {
        url = undefined;
      }
    }
    return accounts;
  }

  // ── Instagram Login ────────────────────────────────────────────────────

  private async instagramLogin(app: MetaLoginApp, code: string, redirectUri: string): Promise<MetaLoginResult> {
    const form = new URLSearchParams({
      client_id: app.appId,
      client_secret: app.appSecret,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code,
    });
    const short = await axios.post('https://api.instagram.com/oauth/access_token', form.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: HTTP_TIMEOUT_MS,
    });
    // Documented as { data: [{ access_token, user_id, permissions }] }; older
    // answers are flat. Accept both.
    const first = Array.isArray(short.data?.data) ? short.data.data[0] : short.data;
    const shortToken = first?.access_token;
    if (typeof shortToken !== 'string' || !shortToken) {
      throw new MetaLoginError('Instagram answered without an access token');
    }
    const long = await axios.get('https://graph.instagram.com/access_token', {
      params: { grant_type: 'ig_exchange_token', client_secret: app.appSecret, access_token: shortToken },
      timeout: HTTP_TIMEOUT_MS,
    });
    const token = long.data?.access_token;
    if (typeof token !== 'string' || !token) {
      throw new MetaLoginError('Instagram did not exchange the token for a long-lived one');
    }
    // /me's user_id is the professional account id the API paths take; the
    // id in the code exchange is app-scoped and is not.
    const me = await axios.get(`${IG_GRAPH}/me`, {
      params: { fields: 'user_id,username' },
      headers: { Authorization: `Bearer ${token}` },
      timeout: HTTP_TIMEOUT_MS,
    });
    const id = me.data?.user_id ?? me.data?.id;
    const accounts: MetaInstagramAccount[] =
      (typeof id === 'string' || typeof id === 'number') && /^\d{5,25}$/.test(String(id))
        ? [{ id: String(id), ...(typeof me.data?.username === 'string' ? { username: me.data.username } : {}) }]
        : [];
    if (accounts.length === 0) this.logger.warn('Instagram login: /me returned no account id');
    return { token, expiresAt: expiryOf(long.data?.expires_in), accounts };
  }
}
