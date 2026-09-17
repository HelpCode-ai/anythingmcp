/**
 * Turns a raw upstream failure into a one-line hint the AI client can act on.
 *
 * WHY. The tool result already carries the vendor's response body, and that is
 * the right thing to keep: it names the real cause. But some vendors phrase it
 * in a way that sends the model into a loop. weclapp answers "unknown property:
 * articleNumber" and the model tries "articleName", "article.number", … for
 * ten calls in a row (194 failures in one week from a single starter
 * workspace). Sorare answers `authenticate_from_new_country`, which no model
 * can fix by retrying — only the human can, by confirming the login from the
 * vendor's email. The hint says what to do instead of what went wrong.
 *
 * WHERE IT APPLIES. Rules are keyed on the upstream host (so a hand-built tool
 * against the same API gets the same help as a catalog one) or on the error
 * text itself when the host is not known. Everything here is advisory: a hint
 * is appended, never substituted for the vendor's own message.
 */

export interface ErrorHintInput {
  /** Upstream host the request went to, if known (e.g. `purora.weclapp.com`). */
  host?: string | null;
  /** HTTP status of the upstream answer, if any. */
  status?: number;
  /** The engine's own error message. */
  message?: string;
  /** The upstream response body, raw. */
  body?: unknown;
}

const WECLAPP_FIELD_HINT =
  'weclapp rejects fields it does not know. Field names are camelCase and belong to ' +
  'the entity itself: line items live under `orderItems` / `salesInvoiceItems` / ' +
  '`shipmentItems` (as nested objects, not as filterable properties), the customer ' +
  'name is inside `recordAddress`, links end in `Id` (`customerId`, `articleId`, ' +
  '`warehouseId` is NOT a field of every entity). Do not guess another spelling: ' +
  'fetch ONE record without `properties` and without that filter, read the field ' +
  'names it actually returns, then retry using only those.';

const WECLAPP_EXPRESSION_HINT =
  'This tool sends `filter` as a weclapp filter EXPRESSION, not as a query string. ' +
  'Grammar: property = "value" | property != "value" | property ~ "%pattern%" ' +
  '(pattern match; the words like/ilike do not exist) | property in ["A","B"] | ' +
  'property > 5. Strings in double quotes. Do NOT write property-eq=value here. ' +
  'Example: name ~ "%Protein%".';

const WECLAPP_RAW_FILTER_HINT =
  'This endpoint takes weclapp filters as query parameters, one per condition: ' +
  '`property-operator=value` (operators -eq -ne -gt -lt -ge -le -like -ilike -in ' +
  '-notin -null -notnull), joined with `&`. `-in` needs a bracketed list: ' +
  '`id-in=[1,2]`. Do not send an SQL-like expression.';

const NEW_COUNTRY_HINT =
  'The service refused the sign-in because it came from a new location (the ' +
  'connector signs in from the AnythingMCP server, not from the user\'s device). ' +
  'This cannot be fixed by retrying or by changing the request. The account owner ' +
  'must open the email the service just sent ("new country / new device") and ' +
  'confirm the login, then the tool works. Tell the user exactly that.';

const SQL_COLUMN_HINT =
  'The upstream folded your `filter` into SQL and SQL read part of it as a column ' +
  'name, which means the value was not quoted the way this API expects. Booleans ' +
  'are the usual culprit: `deleted eq false` becomes the column `false`. Try the ' +
  'call again with that condition removed to confirm the rest of the filter is ' +
  'fine, then reintroduce it using the spelling the endpoint documents (often `0` ' +
  'and `1`, or a quoted `"false"`). Do not guess more than one variant per call.';

const SQL_SYNTAX_HINT =
  'The upstream folded your `filter` into SQL and SQL rejected the syntax, so this ' +
  'is a filter GRAMMAR problem, not a wrong value. A parenthesised list such as ' +
  '`client_number in (1,2)` is the common cause: most of these endpoints accept ' +
  'only simple `field op value` conditions joined with AND. Split it into one call ' +
  'per value, or drop the filter, read what a plain page returns, and filter on a ' +
  'field you have seen. Retrying the same expression will fail the same way.';

const SELECTED_FIELDS_HINT =
  'One of the names in `fields` does not exist on this view, and the API rejects ' +
  'the whole list because of it. Do not guess another spelling: repeat the call ' +
  'with `fields` omitted, read the field names that actually come back, then ask ' +
  'again with only those.';

function bodyText(body: unknown): string {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

function hostMatches(host: string | null | undefined, suffix: string): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return h === suffix || h.endsWith(`.${suffix}`);
}

/**
 * The hint for a failed upstream call, or `undefined` when nothing useful can
 * be said. Pure: safe to call from a catch block.
 */
export function deriveErrorHint(input: ErrorHintInput): string | undefined {
  const text = `${input.message ?? ''}\n${bodyText(input.body)}`;

  // Login-token flows: the vendor's refusal reason is folded into our message.
  if (/authenticate_from_new_country|new_country|unrecognized_device|new_device/i.test(text)) {
    return NEW_COUNTRY_HINT;
  }

  // SQL-backed APIs (several customer connectors sit on SQL Server views) leak
  // the database's own complaint. The model reads "Ungültiger Spaltenname" and
  // starts permuting field names; these three say which part of the request to
  // change. Keyed on the text, not the host, because the phrasing belongs to the
  // database rather than to any one vendor.
  if (/Invalid field in selected fields/i.test(text)) {
    return SELECTED_FIELDS_HINT;
  }
  if (/Ungültiger Spaltenname|Invalid column name/i.test(text)) {
    return SQL_COLUMN_HINT;
  }
  if (/Falsche Syntax in der Nähe von|Incorrect syntax near/i.test(text)) {
    return SQL_SYNTAX_HINT;
  }

  if (hostMatches(input.host, 'weclapp.com')) {
    if (/unknown property|unexpected filter property/i.test(text)) {
      return WECLAPP_FIELD_HINT;
    }
    if (/expression contains errors/i.test(text)) {
      return WECLAPP_EXPRESSION_HINT;
    }
    if (/invalid parameter value|unknown query parameter|unexpected parameter/i.test(text)) {
      return WECLAPP_RAW_FILTER_HINT;
    }
  }

  return undefined;
}

/** Hostname of a URL, or undefined when it is not one (e.g. still holds `{{VAR}}`). */
export function hostFromUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Best-effort host extraction from an axios error: the request config carries
 * either an absolute `url` or a `baseURL` + relative `url`.
 */
export function hostFromAxiosConfig(config: { url?: string; baseURL?: string } | undefined): string | undefined {
  if (!config) return undefined;
  for (const candidate of [config.url, config.baseURL]) {
    if (!candidate) continue;
    try {
      return new URL(candidate, config.baseURL || undefined).hostname;
    } catch {
      /* relative url without a base: try the next candidate */
    }
  }
  return undefined;
}
