import { outboundRequest } from '../common/outbound-http';

/** The catalog adapters that talk to an Odoo and take its database name. */
const ODOO_ADAPTERS = new Set(['odoo', 'odoo-jsonrpc']);

/** The adapter on Odoo's JSON-2 API (Odoo 19+), whose base URL ends in /json/2. */
const JSON2_ADAPTER = 'odoo';

/** The JSON-RPC adapter, the one to use on Odoo 18 and older. */
const JSONRPC_ADAPTER = 'odoo-jsonrpc';

/**
 * What Odoo says when the database name is wrong: the JSON-RPC endpoint
 * fails to connect to a database that does not exist, and the JSON-2 API
 * answers 404 (our hint for that names the database too).
 */
const WRONG_DATABASE = /database "[^"]*" does not exist|database name is wrong/i;

/**
 * Odoo Online answers any request for a database it does not host with a 404
 * page whose script sends the browser to `www.odoo.com/typo?domain=…`.
 */
const ODOO_ONLINE_TYPO = /odoo\.com\/typo\?/i;

const PROBE_TIMEOUT_MS = 8000;

/**
 * The address Odoo itself answers at. The JSON-2 adapter's base URL is
 * `{{ODOO_URL}}/json/2`, and Odoo's web routes (`/web/database/list`,
 * `/jsonrpc`) live at the root, not under it: asking
 * `/json/2/web/database/list` got a 404, so no database name was ever
 * suggested for that adapter.
 */
export function odooOrigin(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl.replace(/\/+$/, '').replace(/\/json\/2$/, '');
  }
}

/**
 * On Odoo Online and Odoo.sh the database name is often not the subdomain
 * (`<project>-main-<number>`), and Odoo shows it nowhere a user looks. Three
 * of three Odoo setups on 7 Oct 2026 failed on it. The web route
 * `/web/database/list` answers with the database(s) the address serves even
 * where `/jsonrpc`'s `db.list` is refused, so a failed check can name the
 * right value instead of telling the user to go and find it.
 *
 * Returns the sentence to add to the failed check, or undefined when this is
 * not an Odoo database error or the list is not available.
 */
export async function odooDatabaseHint(
  adapterSlug: string,
  failure: string,
  baseUrl: string | undefined,
  enteredDatabase: string | undefined,
): Promise<string | undefined> {
  if (!ODOO_ADAPTERS.has(adapterSlug) || !baseUrl || !WRONG_DATABASE.test(failure)) {
    return undefined;
  }
  return databaseListSentence(odooOrigin(baseUrl), enteredDatabase);
}

async function databaseListSentence(
  origin: string,
  enteredDatabase: string | undefined,
): Promise<string | undefined> {
  let databases: unknown;
  try {
    const response = await outboundRequest({
      method: 'POST',
      url: `${origin}/web/database/list`,
      data: { jsonrpc: '2.0', method: 'call', params: {} },
      headers: { 'Content-Type': 'application/json' },
      timeout: PROBE_TIMEOUT_MS,
    });
    databases = response.data?.result;
  } catch {
    return undefined;
  }
  if (!Array.isArray(databases)) return undefined;
  const names = databases.filter(
    (name): name is string => typeof name === 'string' && name !== enteredDatabase,
  );
  if (names.length === 0) return undefined;
  if (names.length === 1) {
    return `This Odoo's database is called "${names[0]}": enter that as the database name.`;
  }
  return `This Odoo serves these databases: ${names
    .slice(0, 5)
    .map((name) => `"${name}"`)
    .join(', ')}. Enter the one you use as the database name.`;
}

/** What a failed Odoo check should say instead of the generic message. */
export interface OdooCheckAdvice {
  message: string;
  /** Another catalog adapter to offer, e.g. the JSON-RPC one for Odoo 18. */
  suggest?: string;
}

/**
 * Why the JSON-2 API answered 404, found out rather than guessed. The old
 * hint said "older than 19, or the database name is wrong" and offered the
 * JSON-RPC connector, and two users on Odoo 19 with a wrong database name
 * switched connectors and failed again. Odoo's unauthenticated
 * `common.version` tells the two apart:
 *  - a version below 19 has no JSON-2 API: offer JSON-RPC;
 *  - 19 or later has it, so the database name is wrong: name the right one;
 *  - Odoo Online's "typo" page: there is no database at this address at all.
 * Undefined when the version cannot be read (not an Odoo, unreachable).
 */
export async function diagnoseOdooJson2NotFound(
  baseUrl: string,
  enteredDatabase: string | undefined,
): Promise<OdooCheckAdvice | undefined> {
  const origin = odooOrigin(baseUrl);
  let body: unknown;
  try {
    const response = await outboundRequest({
      method: 'POST',
      url: `${origin}/jsonrpc`,
      data: {
        jsonrpc: '2.0',
        method: 'call',
        params: { service: 'common', method: 'version', args: [] },
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: PROBE_TIMEOUT_MS,
      // The typo page comes with a 404; it is the answer, not a failure.
      validateStatus: () => true,
    });
    body = response.data;
  } catch {
    return undefined;
  }

  if (typeof body === 'string' && ODOO_ONLINE_TYPO.test(body)) {
    let host = origin;
    try {
      host = new URL(origin).host;
    } catch {
      // keep the origin
    }
    return {
      message:
        `This address is not an Odoo database: Odoo has no database at ${host}. Check the ` +
        'address you open Odoo at (copy it from the browser after signing in, up to the host, ' +
        'e.g. https://mycompany.odoo.com) and enter it as the Odoo address.',
    };
  }

  const result = (body as { result?: { server_version_info?: unknown; server_serie?: unknown; server_version?: unknown } } | null)
    ?.result;
  const major = majorVersion(result?.server_version_info);
  if (major === undefined) return undefined;
  const version = String(result?.server_serie ?? result?.server_version ?? major);

  if (major < 19) {
    return {
      message:
        `This Odoo is version ${version}, older than 19, so it has no JSON-2 API. Use the ` +
        'Odoo 14-18 (JSON-RPC) connector instead.',
      suggest: JSONRPC_ADAPTER,
    };
  }
  const list = await databaseListSentence(origin, enteredDatabase);
  return {
    message:
      `This Odoo is version ${version} and has the JSON-2 API, so the database name` +
      (enteredDatabase ? ` "${enteredDatabase}"` : '') +
      ' is wrong. ' +
      (list ??
        'On Odoo Online and Odoo.sh it is often not the subdomain: it is the name on ' +
          '/web/database/selector, or after ?db= in the address bar.'),
  };
}

/**
 * `server_version_info[0]`: a number on a release (`19`), a string on Odoo
 * Online's rolling versions (`"saas~19"`, then a minor such as 3).
 */
function majorVersion(info: unknown): number | undefined {
  if (!Array.isArray(info) || info.length === 0) return undefined;
  const first = info[0];
  if (typeof first === 'number' && Number.isFinite(first)) return first;
  const digits = typeof first === 'string' ? first.match(/(\d+)/) : null;
  return digits ? Number(digits[1]) : undefined;
}

/**
 * The Odoo-specific advice for a failed connection check or install probe,
 * or undefined to keep the generic message. `message` is the generic one
 * (hint plus the provider's words), `upstream` the provider's words alone.
 */
export async function odooCheckAdvice(input: {
  adapterSlug: string;
  status?: number;
  kind?: string;
  message: string;
  upstream: string;
  baseUrl: string | undefined;
  enteredDatabase: string | undefined;
}): Promise<OdooCheckAdvice | undefined> {
  if (!ODOO_ADAPTERS.has(input.adapterSlug) || !input.baseUrl) return undefined;

  if (
    input.adapterSlug === JSON2_ADAPTER &&
    (input.status === 404 || input.kind === 'not_found')
  ) {
    const diagnosis = await diagnoseOdooJson2NotFound(input.baseUrl, input.enteredDatabase);
    if (diagnosis) {
      return {
        ...diagnosis,
        message: `${diagnosis.message} (${input.upstream.replace(/[.\s]+$/, '')})`,
      };
    }
  }

  const database = await odooDatabaseHint(
    input.adapterSlug,
    input.message,
    input.baseUrl,
    input.enteredDatabase,
  );
  return database ? { message: `${database} ${input.message}` } : undefined;
}
