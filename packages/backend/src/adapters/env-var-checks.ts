import { describeAdapterEnvVars, EnvVarDescriptor } from './env-var-meta';
import { addressFix, describeAddressFix, withMissingScheme } from './address-fix';
import { normalizeWooCommerceUrl } from './woocommerce-setup';

/**
 * Values that cannot be what the user meant, refused field by field before a
 * catalog connector is checked, installed or edited.
 *
 * WHY. Three shapes reached production connectors and failed every call:
 *  - the example left in a field: a MySQL host saved as the literal `host`
 *    failed with "Host not found: 'host' could not be resolved";
 *  - a value the adapter's own pattern refuses, saved through a path that did
 *    not check it (the dashboard's variable editor): an Odoo address with
 *    `/web` after the host, a Bitrix24 CRM page instead of the webhook URL;
 *  - a key pasted two or three times into one field (an Odoo key of 3 × 40
 *    characters).
 *
 * Every rule is conservative: it matches only values no real host, address or
 * key can have. A subdomain of example.com is NOT refused (tests and demo
 * setups use them); a single-label host such as `erp` is NOT refused
 * (self-hosted servers reach services by that name).
 */

/** Words that stand for a host in docs and forms. Matched as the whole host. */
const PLACEHOLDER_HOSTS = new Set([
  'host',
  'hostname',
  'server',
  'servername',
  'domain',
  'ip',
  'ip-address',
  'ipaddress',
  'example.com',
  'www.example.com',
  'example.org',
  'www.example.org',
  'example.net',
  'www.example.net',
]);

/** `your-host`, `yourdomain`, `your_company`: a label written for the reader to replace. */
const YOUR_LABEL =
  /^your[-_]?(?:host(?:name)?|domain|server|company|store|shop|instance|tenant|subdomain|site|org(?:anization)?|account|portal|url|ip)s?$/i;

/** Whole values that are a note, not a value. */
const PLACEHOLDER_VALUE =
  /^(?:todo|tbd|tba|changeme|change[-_ ]?me|placeholder|replace[-_ ]?me|fill[-_ ]?me|x{3,}|\.{3}|…|<[^<>]+>|\[[^[\]]+\]|null|undefined)$/i;

/** `your-api-key`, `YOUR_TOKEN`, `my_secret`: the name of the value instead of the value. */
const NAMED_SECRET =
  /^(?:your|my)[-_ ]?(?:api[-_ ]?)?(?:key|token|secret|password|pass|client[-_ ]?(?:id|secret)|access[-_ ]?token|bot[-_ ]?token)$/i;

/** `PASTE_KEY_HERE`, `your_api_key_here`, `insert token here`. Letters only: real keys carry digits. */
const HERE_VALUE = /^[a-z][a-z_\- ]*[-_ ]here$/i;

/** Names that hold an address even when the adapter does not put them in the base URL. */
const ADDRESS_NAME = /(?:^|_)(?:HOST|HOSTNAME|URL|SERVER|DOMAIN|ENDPOINT|ADDRESS)(?:_|$)/;

function hostOf(value: string): string | undefined {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  try {
    return new URL(withScheme).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Why `value` is a placeholder rather than a real value, or undefined.
 * `field` says what kind of value the field holds.
 */
export function placeholderReason(value: string, field: 'address' | 'credential'): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  if (PLACEHOLDER_VALUE.test(text) || HERE_VALUE.test(text)) {
    return 'still holds the example text from the instructions';
  }
  if (field === 'credential') {
    return NAMED_SECRET.test(text) ? 'still holds the example text from the instructions' : undefined;
  }
  const lower = text.toLowerCase();
  if (PLACEHOLDER_HOSTS.has(lower) || YOUR_LABEL.test(lower)) {
    return `holds "${text}", the word from the instructions, not the real address`;
  }
  const host = hostOf(text);
  if (!host) return undefined;
  if (PLACEHOLDER_HOSTS.has(host)) {
    return `points at ${host}, the example from the instructions, not the real address`;
  }
  if (host.split('.').some((label) => YOUR_LABEL.test(label))) {
    return `points at ${host}, the example from the instructions, not the real address`;
  }
  return undefined;
}

/**
 * True when `value` is one string repeated two or more times back to back
 * (`abcabc`), the shape a key pasted more than once has. Only exact
 * repetition counts, of a unit long enough to be a key: `aaaaaaaa` or
 * `abab` in a short value are left alone.
 */
export function isRepeatedPaste(value: string): boolean {
  const text = value.trim();
  const n = text.length;
  if (n < 16) return false;
  for (let unit = 8; unit <= n / 2; unit++) {
    if (n % unit !== 0) continue;
    const piece = text.slice(0, unit);
    if (piece.repeat(n / unit) === text) {
      // A unit that is itself one character repeated (`--------`) is padding, not a key.
      return !/^(.)\1*$/.test(piece);
    }
  }
  return false;
}

function matchesPattern(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    // A broken pattern never blocks a save.
    return true;
  }
}

/**
 * Per-variable clean-ups applied before a value is checked and stored, for
 * shapes that working connectors were saved with and that mean exactly one
 * thing. Normalising beats refusing: the value the user pasted works, and the
 * stored one is what is used.
 *
 * (The tenant pasted as a whole address, `acme.weclapp.com`, is handled for
 * every adapter by normalizeSubdomainVariables in base-url-variable.util.ts.)
 */
const NORMALISERS: Record<string, Record<string, (value: string) => string>> = {
  // A bot token has no whitespace; one copied from a chat or a PDF can carry
  // spaces after the colon or inside (`123: AAH… …`).
  'telegram-bot': {
    TELEGRAM_BOT_TOKEN: (v) => v.replace(/\s+/g, ''),
  },
  // The webhook URL is everything up to `/rest/<user_id>/<code>/`; a method
  // name copied with it (`…/crm.deal.list.json?ID=1`) is cut off, because
  // the tools append their own.
  bitrix24: {
    BITRIX24_WEBHOOK_URL: (v) => {
      const m = /^(.*?\/rest\/\d+\/[A-Za-z0-9_-]+)(?:[/?#].*)?$/.exec(v.trim());
      return m ? `${m[1]}/` : v;
    },
  },
  // What the browser shows in WordPress (`/wp-admin/…`, `/wp-json/wc/v3`,
  // `/wp-login.php`, a query, a trailing slash) cut back to the site's
  // address, with https://. A subfolder stays; the setup check asks the site
  // whether it is WordPress's (woocommerce-setup.ts).
  woocommerce: {
    WOOCOMMERCE_URL: normalizeWooCommerceUrl,
  },
};

/** The adapter fields a checker needs. */
export type CheckedAdapter = Parameters<typeof describeAdapterEnvVars>[0];

/** A field that holds an address and is shown back as typed (never a secret). */
function isPlainAddress(d: Pick<EnvVarDescriptor, 'name' | 'kind' | 'secret'>): boolean {
  return !d.secret && d.kind !== 'credential' && (d.kind === 'address' || ADDRESS_NAME.test(d.name));
}

/**
 * These values with the adapter's clean-ups applied (NORMALISERS) and, when
 * given the adapter rather than its slug, `https://` put in front of an
 * address typed without it where the field's pattern wants one
 * (`acme.odoo.com`, address-fix.ts). Values of other variables, and of
 * adapters without clean-ups, come back unchanged.
 */
export function normalizeAdapterEnvValues<T extends Record<string, unknown>>(
  adapter: string | CheckedAdapter | undefined,
  values: T,
): T {
  const slug = typeof adapter === 'string' ? adapter : adapter?.slug;
  const rules = slug ? NORMALISERS[slug] : undefined;
  let out = values;
  if (rules) {
    out = Object.fromEntries(
      Object.entries(out).map(([name, value]) => {
        const ruled = Object.prototype.hasOwnProperty.call(rules, name);
        return [name, ruled && typeof value === 'string' && value ? rules[name](value) : value];
      }),
    ) as T;
  }
  if (adapter && typeof adapter !== 'string') {
    for (const d of describeAdapterEnvVars(adapter)) {
      const value = out[d.name];
      if (typeof value !== 'string' || !value || !isPlainAddress(d)) continue;
      const fixed = withMissingScheme(d.pattern, value);
      if (fixed !== value) out = { ...out, [d.name]: fixed };
    }
  }
  return out;
}

/**
 * One value as the setup stores it: the clean-ups of
 * {@link normalizeAdapterEnvValues} for this field alone (a chat install
 * checks each setting as it arrives). The adapter's own rules (NORMALISERS)
 * apply when its slug is given.
 */
export function normalizeAdapterEnvValue(d: EnvVarDescriptor, value: string, slug?: string): string {
  const rules = slug ? NORMALISERS[slug] : undefined;
  const ruled =
    rules && Object.prototype.hasOwnProperty.call(rules, d.name) && value ? rules[d.name](value) : value;
  return isPlainAddress(d) ? withMissingScheme(d.pattern, ruled) : ruled;
}

/**
 * Field-level problems with these values of a catalog connector's variables,
 * as `{ VARIABLE: message }`; empty when there is nothing to say. Only the
 * names in `only` are checked when it is given (an edit checks what it
 * changes, so a stored value never blocks an unrelated edit). Empty values
 * and names the adapter does not declare are skipped: "still empty" is told
 * elsewhere.
 */
export function checkAdapterEnvValues(
  adapter: CheckedAdapter,
  values: Record<string, unknown>,
  only?: Iterable<string>,
): Record<string, string> {
  const wanted = only ? new Set(only) : undefined;
  const out: Record<string, string> = {};
  for (const d of describeAdapterEnvVars(adapter)) {
    if (wanted && !wanted.has(d.name)) continue;
    const raw = values[d.name];
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const message = checkOne(d, raw.trim());
    if (message) out[d.name] = message;
  }
  return out;
}

function checkOne(d: EnvVarDescriptor, value: string): string | undefined {
  // Values that are still a {{VARIABLE}} are resolved later and checked there.
  if (/\{\{\s*[\w.]+\s*\}\}/.test(value)) return undefined;
  const isAddress = d.kind === 'address' || ADDRESS_NAME.test(d.name);
  const isCredential = d.secret || d.kind === 'credential';
  if (isAddress || isCredential) {
    const reason = placeholderReason(value, isAddress ? 'address' : 'credential');
    if (reason) {
      return `${d.label} ${reason}. Enter the real value${d.example && isAddress ? `, e.g. ${d.example}` : ''}.`;
    }
  }
  if (isCredential && isRepeatedPaste(value)) {
    return `${d.label}: this looks like the key pasted more than once. Paste it once.`;
  }
  if (d.pattern && !matchesPattern(d.pattern, value)) {
    // An address one small change away from what the pattern accepts: say
    // which change, with the value to enter (an address, never a secret).
    const fix = isPlainAddress(d) ? addressFix(d.pattern, value) : undefined;
    if (fix) return `${d.label} does not look right. ${describeAddressFix(fix)}`;
    return `${d.label} does not look right. ${d.patternMessage ?? (d.example ? `Example: ${d.example}` : d.help ?? '')}`.trim();
  }
  return undefined;
}

/** One sentence naming every refused field, for callers without a form. */
export function describeFieldProblems(fields: Record<string, string>): string {
  return Object.values(fields).join(' ');
}
