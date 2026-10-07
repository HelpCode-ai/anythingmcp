import { outboundRequest } from '../common/outbound-http';

/** The catalog adapters that talk to an Odoo and take its database name. */
const ODOO_ADAPTERS = new Set(['odoo', 'odoo-jsonrpc']);

/**
 * What Odoo says when the database name is wrong: the JSON-RPC endpoint
 * fails to connect to a database that does not exist, and the JSON-2 API
 * answers 404 (our hint for that names the database too).
 */
const WRONG_DATABASE = /database "[^"]*" does not exist|database name is wrong/i;

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
  let databases: unknown;
  try {
    const response = await outboundRequest({
      method: 'POST',
      url: `${baseUrl.replace(/\/+$/, '')}/web/database/list`,
      data: { jsonrpc: '2.0', method: 'call', params: {} },
      headers: { 'Content-Type': 'application/json' },
      timeout: 8000,
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
