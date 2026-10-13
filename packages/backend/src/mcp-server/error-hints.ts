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

const MISSING_SCOPE_HINT =
  'The connector was authorized without a permission this tool needs (the error names it). ' +
  'Retrying will not help: ask the user to open this connector in AnythingMCP and click ' +
  '"Authorize with Provider" again, which requests the missing permission, then retry.';

const ODOO_FIELD_HINT =
  'That field does not exist on this model in this Odoo database; field names differ between ' +
  'Odoo versions and installed apps. Do not guess another spelling: list the model\'s fields ' +
  'first (odoo_fields_get, or fields_get on the model) and use only the names it returns.';

// Odoo 18.3 dropped `mobile` from contacts (res.partner, and res.users through
// it); one number field is left. On 10 Oct 2026 a scheduled job asked for it 28
// times in a day on Odoo 19, and the generic field hint did not stop it.
const ODOO_PARTNER_MOBILE_HINT =
  'Odoo 18.3 and later (Odoo 19 included) have no `mobile` field on contacts: every number is ' +
  'in `phone`. Ask for `phone` instead and leave `mobile` out of fields and domains.';

const ODOO_MODEL_HINT =
  'That model does not exist in this Odoo database: it was renamed in newer versions or its ' +
  'app is not installed (for example stock.production.lot is stock.lot since Odoo 16). Check ' +
  'the model name before retrying, e.g. search ir.model by name.';

const ETSY_PROPERTY_NAME_HINT =
  'Etsy needs every entry of property_values complete: property_id, property_name, ' +
  'scale_id (when the listing has one), value_ids and values. Read the listing with ' +
  'etsy_read_listing_inventory and send its property_values back unchanged, changing ' +
  'only prices, quantities or SKUs.';

const WECLAPP_FIELD_HINT =
  'weclapp rejects fields it does not know. Field names are camelCase and belong to ' +
  'the entity itself: line items live under `orderItems` / `salesInvoiceItems` / ' +
  '`shipmentItems` (as nested objects, not as filterable properties), the customer ' +
  'name is inside `recordAddress`, links end in `Id` (`customerId`, `articleId`, ' +
  '`warehouseId` is NOT a field of every entity). Names seen guessed wrong: the ' +
  'shipping address of an order is `deliveryAddress` (not `shippingAddress`), an ' +
  'article has `unitId` (not `unitName`), and fields of line items cannot be picked ' +
  'with a dot (`orderItems.articleNumber`): ask for `orderItems` whole. Do not guess another spelling: ' +
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

const WECLAPP_READ_ONLY_HINT =
  'weclapp refuses to write a read-only field (the error names it, e.g. statusHistory, ' +
  'createdDate, an amount or a number the system assigns). Do not copy a record you read ' +
  'back into an update: send only the fields that change, with ignoreMissingProperties=true ' +
  '(the weclapp_edit_* tools do this), and leave the named field out.';

const WECLAPP_OPTIMISTIC_LOCK_HINT =
  'The record changed after it was read, so the `version` sent with the update is stale ' +
  '(or someone saved the record at the same moment). Read the record again, take its ' +
  'current `version`, check the change still makes sense, then retry once. Leaving ' +
  '`version` out skips the check but can overwrite the other change.';

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

const TYPESAFE_INVALID_REQUEST_HINT =
  'Jev rejected the shape of a question without saying which one. Check every ' +
  'question: `type` must be exactly "noul" (yes/no; there is no "bool"), "choice" ' +
  'or "score"; a choice needs `criteria` as an object of option -> description ' +
  '(1 to 255 options); a score needs `criteria` as an ARRAY of 2 to 10 level ' +
  'descriptions, lowest first; `model` must be a name from jev_list_models. Only ' +
  'state, model and questions go in the request: there is no field for a list ' +
  'of records, send one call per record instead.';

const TELEGRAM_BAD_TOKEN_HINT =
  'Telegram answers 404 "Not Found" (or 401) for every method when the bot token ' +
  'in the URL is wrong, so this is the TELEGRAM_BOT_TOKEN, not the method. Tell ' +
  'the user to copy the token again from @BotFather (format 123456789:AA...) into ' +
  'the connector settings. Retrying or calling another method will fail the same way.';

const TELEGRAM_CHAT_HINT =
  'The bot cannot reach that chat. A bot may only write to a user who has opened ' +
  'it and pressed Start, or to a group/channel it was added to (channels: as an ' +
  'administrator). Use the numeric chat id from telegram_bot_get_updates after ' +
  'the user has sent the bot a message; @usernames only work for public channels. ' +
  'Ask the user to do that instead of trying other ids.';

const TELEGRAM_SUPERGROUP_HINT =
  'The group became a supergroup and has a new chat id: it is the ' +
  '`migrate_to_chat_id` in this answer (it starts with -100). Send to that id; ' +
  'the old one will not work again.';

const TELEGRAM_URL_CONTENT_HINT =
  'Telegram downloads the file itself and could not fetch that URL. It must be a ' +
  'public https link that returns the file directly (no login, no preview page, no ' +
  'expiring link from a chat app or file share), at most 5 MB for a photo. Ask the ' +
  'user for such a link instead of retrying the same one.';

const LEXWARE_OVERDUE_HINT =
  'Lexware does not accept `overdue` together with other statuses in ' +
  '`voucherStatus`. Make one call with voucherStatus=overdue and a separate one ' +
  'for the other statuses.';

const SHOPIFY_NOT_INSTALLED_HINT =
  'Shopify refused the token because the Dev Dashboard app is not installed on this ' +
  'store (`app_not_installed`). This cannot be fixed by retrying. The store owner must ' +
  'open the app in the Shopify Dev Dashboard, click "Install app" and choose this ' +
  'store (the one in SHOPIFY_STORE), then the tools work. Tell the user exactly that.';

const SHOPIFY_PROTECTED_DATA_HINT =
  'Shopify withholds protected customer data (names, emails, phones, addresses) from ' +
  'an app until access is requested. Retrying or asking for other fields of the same ' +
  'object will not help. The store owner must open the Partner Dashboard → Apps → this ' +
  'app → API access requests → Protected customer data access, request the fields and ' +
  'save (no review for an app on their own store). Tell the user exactly that.';

const PRINTFUL_STORE_ID_HINT =
  'The Printful token is account-level, so this call needs `store_id`. Call ' +
  'printful_list_stores and retry with the id of the store meant. If that list is ' +
  'empty, the account has no store yet: the user must create one in Printful ' +
  '(Stores → Add store → "Manual order platform / API") first.';

const FIGMA_NO_DEV_MODE_HINT =
  'Figma answers "File not found" to dev resource calls when the user has no Dev Mode ' +
  'access to the file, even though the file exists (a file Figma really cannot find ' +
  'answers "Not found"). Dev Mode needs a paid Figma plan and a Full or Dev seat; a ' +
  'Starter or locked team, or a View or Collab seat, is refused. Retrying will not help: ' +
  'tell the user that dev resources are not available to them on this file.';

// Generative AI APIs (gemini and openai adapters, and hand-built tools on the
// same hosts). Every call is billed to the user's own key, so a retry loop
// costs them money: these say when retrying cannot help.
const GEMINI_KEY_HINT =
  'Google refused the API key (API_KEY_INVALID): it is wrong, was deleted, or has extra ' +
  'characters. Retrying will not help. Ask the user to create a key in Google AI Studio ' +
  '(https://aistudio.google.com/apikey) and paste it into GEMINI_API_KEY.';

const GEMINI_PERMISSION_HINT =
  'Google refused the request (403). Usual causes: the key is restricted to other APIs or ' +
  'apps (Google Cloud console, Credentials, the key, API restrictions: allow the Generative ' +
  'Language API), the API is switched off in the key\'s project, or a file URL passed in the ' +
  'request is not public. Retrying unchanged will not help.';

const GEMINI_MODEL_HINT =
  'That model name does not exist for this key or does not support this method. Do not guess ' +
  'another name: list the models (gemini_list_models, or GET /v1beta/models) and use a `name` ' +
  'it returns, without the `models/` prefix (for example gemini-3.1-flash-lite).';

const GEMINI_QUOTA_HINT =
  'Gemini quota or rate limit reached (429 RESOURCE_EXHAUSTED). The free tier limits requests ' +
  'per minute and per day for each model, and image models have no free tier at all (limit 0). ' +
  'Wait for the time in the RetryInfo detail before one retry, use a smaller model, or ask the ' +
  'user to enable billing for the key\'s project in Google AI Studio. Do not retry in a loop.';

const GEMINI_REGION_HINT =
  'Gemini refused the request for this account or region (FAILED_PRECONDITION), for example ' +
  'because the free tier is not available in the user\'s country or billing is required. ' +
  'Retrying will not help: the user needs to enable billing for the key\'s project in Google AI Studio.';

const GEMINI_SAFETY_HINT =
  'Gemini blocked this prompt or its answer with its safety or content filters (block reason or ' +
  'finish reason SAFETY, PROHIBITED_CONTENT, BLOCKLIST, SPII, RECITATION or IMAGE_SAFETY). ' +
  'Retrying the same request will not help. Tell the user, and only rephrase if they want to ' +
  'and the request is acceptable.';

const OPENAI_KEY_HINT =
  'OpenAI refused the API key (401): it is wrong, revoked, or belongs to another organization ' +
  'or project than OPENAI_ORGANIZATION / OPENAI_PROJECT name. Retrying will not help. Ask the ' +
  'user to create a key at https://platform.openai.com/api-keys and paste it into OPENAI_API_KEY, ' +
  'and to clear or correct the organization and project settings.';

const OPENAI_VERIFICATION_HINT =
  'OpenAI requires a verified organization for this model or feature (the GPT image models ' +
  'among them). Retrying will not help. The user has to verify the organization under ' +
  'https://platform.openai.com/settings/organization/general (Verify Organization); access ' +
  'can take a few minutes to arrive after verification.';

const OPENAI_MODEL_HINT =
  'That model does not exist or this key has no access to it. Do not guess another name: list ' +
  'the models (openai_list_models, or GET /v1/models) and use an id it returns.';

const OPENAI_QUOTA_HINT =
  'The OpenAI account has no credit left or reached its spending limit (insufficient_quota). ' +
  'Retrying will not help: the user has to add credit or raise the limit under ' +
  'https://platform.openai.com/settings/organization/billing.';

const OPENAI_RATE_HINT =
  'OpenAI rate limit reached for this model (requests or tokens per minute). Wait the time ' +
  'the error names before one retry, ask for less (fewer images, shorter output), or use a ' +
  'smaller model. Do not retry in a loop.';

const OPENAI_SAFETY_HINT =
  'OpenAI\'s safety system refused this request or stopped the answer (moderation_blocked, ' +
  'content_policy_violation or content_filter). Retrying the same request will not help. Tell ' +
  'the user, and only rephrase if they want to and the request is acceptable.';

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

  // OAuth tokens granted before an adapter gained a scope (Etsy's listings_w
  // when its write tools arrived). Wording differs per vendor; the fix is the
  // same: re-authorize, which now asks for the catalog's current scopes.
  if (
    (input.status === 401 || input.status === 403 || input.status === undefined) &&
    /lacks scope|insufficient[_ ]scope|requires? scope|missing (the )?(required )?scopes?|scope is not granted/i.test(text)
  ) {
    return MISSING_SCOPE_HINT;
  }

  // Odoo answers an unknown field or model with a 500 ValueError (REST) or a
  // JSON-RPC "Odoo Server Error", and the host is the customer's own domain.
  if (/Invalid field '?(?:res\.(?:partner|users)\.)?mobile'? (?:on '?res\.(?:partner|users)|in leaf)/i.test(text)) {
    return ODOO_PARTNER_MOBILE_HINT;
  }
  if (/Invalid field '[^']+' on '[^']+'|Invalid field [\w.]+ in leaf|Invalid field '[^']+' on model/i.test(text)) {
    return ODOO_FIELD_HINT;
  }
  if (/Object [\w.]+ doesn't exist|Model not found: [\w.]+/i.test(text)) {
    return ODOO_MODEL_HINT;
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
    if (/read_only_property|property [\w.\[\]]+ is read-only/i.test(text)) {
      return WECLAPP_READ_ONLY_HINT;
    }
    if (/optimistic[ _]lock/i.test(text)) {
      return WECLAPP_OPTIMISTIC_LOCK_HINT;
    }
  }

  if (hostMatches(input.host, 'api.telegram.org')) {
    if (input.status === 401 || (input.status === 404 && /"Not Found"/.test(text))) {
      return TELEGRAM_BAD_TOKEN_HINT;
    }
    if (/upgraded to a supergroup|migrate_to_chat_id/i.test(text)) {
      return TELEGRAM_SUPERGROUP_HINT;
    }
    if (/failed to get HTTP URL content|wrong file identifier\/HTTP URL specified/i.test(text)) {
      return TELEGRAM_URL_CONTENT_HINT;
    }
    if (/chat not found|bot is not a member|can't initiate conversation|need administrator rights|bot was blocked by the user/i.test(text)) {
      return TELEGRAM_CHAT_HINT;
    }
  }

  if (hostMatches(input.host, 'etsy.com') && /Expected string value for 'property_name'/.test(text)) {
    return ETSY_PROPERTY_NAME_HINT;
  }

  if (hostMatches(input.host, 'myshopify.com') && /app_not_installed/.test(text)) {
    return SHOPIFY_NOT_INSTALLED_HINT;
  }
  if (hostMatches(input.host, 'myshopify.com') && /not approved to access the \w+ object|protected-customer-data/i.test(text)) {
    return SHOPIFY_PROTECTED_DATA_HINT;
  }

  if (hostMatches(input.host, 'api.printful.com') && /requires `?store_id`?/i.test(text)) {
    return PRINTFUL_STORE_ID_HINT;
  }

  if (/voucherStatus filter 'overdue' cannot be used in combination/i.test(text)) {
    return LEXWARE_OVERDUE_HINT;
  }

  // Figma hides a file from the dev resource API when the user lacks Dev Mode:
  // 404 {"message": "File not found"} on a read, `errors[].error` on a write.
  // A missing file reads {"err": "Not found"} instead.
  if (hostMatches(input.host, 'api.figma.com') && /File not found/.test(text)) {
    return FIGMA_NO_DEV_MODE_HINT;
  }

  // TypeSafe answers a question with an unknown type (and any other field it
  // does not expect) with a bare "Invalid request.", which names nothing the
  // model could fix.
  if (hostMatches(input.host, 'typesafe.ai') && /"Invalid request\."/.test(text)) {
    return TYPESAFE_INVALID_REQUEST_HINT;
  }

  if (hostMatches(input.host, 'generativelanguage.googleapis.com')) {
    const hint = geminiHint(input.status, text);
    if (hint) return hint;
  }

  if (hostMatches(input.host, 'api.openai.com')) {
    const hint = openaiHint(input.status, text);
    if (hint) return hint;
  }

  return undefined;
}

function geminiHint(status: number | undefined, text: string): string | undefined {
  if (/API_KEY_INVALID|API key not valid|API key expired/i.test(text)) return GEMINI_KEY_HINT;
  if (/\b(SAFETY|PROHIBITED_CONTENT|BLOCKLIST|SPII|RECITATION|IMAGE_SAFETY|IMAGE_PROHIBITED_CONTENT|IMAGE_RECITATION)\b/.test(text)) {
    return GEMINI_SAFETY_HINT;
  }
  if (status === 429 || /RESOURCE_EXHAUSTED/.test(text)) return GEMINI_QUOTA_HINT;
  if (status === 404 && /models\/|is not found for API version|not supported for/i.test(text)) return GEMINI_MODEL_HINT;
  if (/User location is not supported|FAILED_PRECONDITION/i.test(text)) return GEMINI_REGION_HINT;
  if (status === 403 || /PERMISSION_DENIED/.test(text)) return GEMINI_PERMISSION_HINT;
  return undefined;
}

function openaiHint(status: number | undefined, text: string): string | undefined {
  if (/moderation_blocked|content_policy_violation|safety system|content_filter/i.test(text)) return OPENAI_SAFETY_HINT;
  if (/insufficient_quota|exceeded your current quota/i.test(text)) return OPENAI_QUOTA_HINT;
  if (status === 429 || /rate_limit_exceeded/.test(text)) return OPENAI_RATE_HINT;
  if (/must be verified|organization.{0,40}verif/i.test(text)) return OPENAI_VERIFICATION_HINT;
  if (status === 401 || /invalid_api_key|Incorrect API key/i.test(text)) return OPENAI_KEY_HINT;
  if (/model_not_found|The model `[^`]*` does not exist/i.test(text)) return OPENAI_MODEL_HINT;
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
