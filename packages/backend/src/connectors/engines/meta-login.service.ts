import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { metaGraphError } from './bearer-token-renewal.service';
import {
  META_LOGIN_GRAPH_VERSION,
  META_UNIFIED_GRAPH_VERSION,
  MetaLoginApp,
  MetaLoginFlavour,
  cleanMetaCode,
} from './meta-login.util';

const HTTP_TIMEOUT_MS = 15_000;
const FB_GRAPH = `https://graph.facebook.com/${META_LOGIN_GRAPH_VERSION}`;
const FB_GRAPH_UNIFIED = `https://graph.facebook.com/${META_UNIFIED_GRAPH_VERSION}`;
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
  /**
   * A Business Integration System User token (Unified Login): it belongs to
   * the client's business portfolio and is never exchanged or refreshed with
   * the user-token calls.
   */
  systemUser?: boolean;
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
      if (input.flavour === 'instagram') return await this.instagramLogin(input.app, code, input.redirectUri);
      return input.app.configId
        ? await this.unifiedLogin(input.app, code, input.redirectUri)
        : await this.facebookLogin(input.app, code, input.redirectUri);
    } catch (err) {
      throw describe(err);
    }
  }

  /** The Instagram accounts the client shared with a Unified Login token. */
  async unifiedAccounts(token: string, app?: MetaLoginApp): Promise<MetaInstagramAccount[]> {
    try {
      return (await this.discoverUnifiedAccounts(token, app)).accounts;
    } catch (err) {
      throw describe(err);
    }
  }

  /**
   * One Instagram account by id, read with the token: the account a user
   * names by hand when the lists come back empty. Undefined when the token
   * cannot read it.
   */
  async accountById(token: string, id: string): Promise<MetaInstagramAccount | undefined> {
    if (!/^\d{5,25}$/.test(id)) return undefined;
    try {
      const res = await axios.get(`${FB_GRAPH}/${id}`, {
        params: { fields: 'id,username' },
        headers: { Authorization: `Bearer ${token}` },
        timeout: HTTP_TIMEOUT_MS,
      });
      return String(res.data?.id) === id
        ? { id, ...(typeof res.data?.username === 'string' ? { username: res.data.username } : {}) }
        : undefined;
    } catch {
      return undefined;
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

  // ── Unified Login ──────────────────────────────────────────────────────

  private async unifiedLogin(app: MetaLoginApp, code: string, redirectUri: string): Promise<MetaLoginResult> {
    const res = await axios.get(`${FB_GRAPH_UNIFIED}/oauth/access_token`, {
      params: { client_id: app.appId, client_secret: app.appSecret, redirect_uri: redirectUri, code },
      timeout: HTTP_TIMEOUT_MS,
    });
    const token = res.data?.access_token;
    if (typeof token !== 'string' || !token) {
      throw new MetaLoginError('Meta answered without an access token');
    }
    // The configuration sets the expiry ("never" for ours): no expires_in
    // then. Such a token is not a user token and is never exchanged.
    const { accounts } = await this.discoverUnifiedAccounts(token, app);
    return { token, expiresAt: expiryOf(res.data?.expires_in), accounts, systemUser: true };
  }

  /**
   * The Instagram accounts a Unified Login token can act for. Meta documents
   * /me/assigned_instagram_accounts; when that comes back empty, the client's
   * business portfolio (/me?fields=client_business_id) is asked for its
   * owned and connected Instagram accounts, and the token's granular scopes
   * (debug_token, with the app token) name the accounts it was granted. Each
   * step's outcome is logged as counts and error codes, never the token.
   */
  private async discoverUnifiedAccounts(
    token: string,
    app?: MetaLoginApp,
  ): Promise<{ accounts: MetaInstagramAccount[]; notes: string[] }> {
    const notes: string[] = [];
    const seen = new Map<string, MetaInstagramAccount>();
    const add = (list: MetaInstagramAccount[]) => {
      for (const a of list) if (!seen.has(a.id) || (!seen.get(a.id)!.username && a.username)) seen.set(a.id, a);
    };
    const step = async (name: string, run: () => Promise<MetaInstagramAccount[]>) => {
      try {
        const list = await run();
        notes.push(`${name}=${list.length}`);
        add(list);
      } catch (err) {
        notes.push(`${name}=error(${describe(err).message.slice(0, 120)})`);
      }
    };
    await step('assigned_instagram_accounts', () => this.listAssignedAccounts(token));
    if (seen.size === 0) {
      let businessId: string | undefined;
      try {
        const me = await axios.get(`${FB_GRAPH_UNIFIED}/me`, {
          params: { fields: 'id,client_business_id' },
          headers: { Authorization: `Bearer ${token}` },
          timeout: HTTP_TIMEOUT_MS,
        });
        const biz = me.data?.client_business_id;
        businessId = (typeof biz === 'string' || typeof biz === 'number') && /^\d+$/.test(String(biz)) ? String(biz) : undefined;
        notes.push(`client_business_id=${businessId ? 'present' : 'missing'}`);
      } catch (err) {
        notes.push(`me=error(${describe(err).message.slice(0, 120)})`);
      }
      if (businessId) {
        for (const edge of ['owned_instagram_accounts', 'instagram_accounts']) {
          await step(edge, () => this.listEdgeAccounts(token, `${FB_GRAPH_UNIFIED}/${businessId}/${edge}`));
        }
      }
      if (app) {
        await step('debug_token_targets', async () => {
          const res = await axios.get(`${FB_GRAPH_UNIFIED}/debug_token`, {
            params: { input_token: token },
            headers: { Authorization: `Bearer ${app.appId}|${app.appSecret}` },
            timeout: HTTP_TIMEOUT_MS,
          });
          const data = res.data?.data ?? {};
          const scopes: string[] = Array.isArray(data.scopes) ? data.scopes.filter((x: unknown) => typeof x === 'string') : [];
          notes.push(`scopes=${scopes.join(',') || 'none'}`);
          const ids = new Set<string>();
          for (const g of Array.isArray(data.granular_scopes) ? data.granular_scopes : []) {
            if (typeof g?.scope === 'string' && g.scope.startsWith('instagram') && Array.isArray(g.target_ids)) {
              for (const id of g.target_ids) if (/^\d{5,25}$/.test(String(id))) ids.add(String(id));
            }
          }
          const found: MetaInstagramAccount[] = [];
          for (const id of ids) {
            const account = await this.accountById(token, id);
            if (account) found.push(account);
          }
          return found;
        });
      }
    }
    const accounts = [...seen.values()];
    if (accounts.length === 0) this.logger.warn(`Unified Login: no Instagram account found (${notes.join('; ')})`);
    else this.logger.log(`Unified Login: ${accounts.length} Instagram account(s) (${notes.join('; ')})`);
    return { accounts, notes };
  }

  private async listEdgeAccounts(token: string, url: string): Promise<MetaInstagramAccount[]> {
    const res = await axios.get(url, {
      params: { fields: 'id,username', limit: '100' },
      headers: { Authorization: `Bearer ${token}` },
      timeout: HTTP_TIMEOUT_MS,
    });
    const out: MetaInstagramAccount[] = [];
    for (const row of Array.isArray(res.data?.data) ? res.data.data : []) {
      const id = row?.id;
      if ((typeof id === 'string' || typeof id === 'number') && /^\d{5,25}$/.test(String(id))) {
        out.push({ id: String(id), ...(typeof row.username === 'string' ? { username: row.username } : {}) });
      }
    }
    return out;
  }

  /** /me is the business integration system user; its assigned accounts are what the client shared. */
  private async listAssignedAccounts(token: string): Promise<MetaInstagramAccount[]> {
    const accounts: MetaInstagramAccount[] = [];
    let url: string | undefined = `${FB_GRAPH_UNIFIED}/me/assigned_instagram_accounts`;
    let params: Record<string, string> = { fields: 'id,username', limit: '100' };
    for (let page = 0; url && page < 10; page++) {
      const res: { data?: any } = await axios.get(url, {
        params,
        headers: { Authorization: `Bearer ${token}` },
        timeout: HTTP_TIMEOUT_MS,
      });
      for (const row of Array.isArray(res.data?.data) ? res.data.data : []) {
        const id = row?.id;
        if ((typeof id === 'string' || typeof id === 'number') && /^\d{5,25}$/.test(String(id))) {
          accounts.push({ id: String(id), ...(typeof row.username === 'string' ? { username: row.username } : {}) });
        }
      }
      const after: unknown = res.data?.paging?.cursors?.after;
      if (typeof res.data?.paging?.next === 'string' && typeof after === 'string' && after) {
        params = { ...params, after };
      } else {
        url = undefined;
      }
    }
    return accounts;
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
