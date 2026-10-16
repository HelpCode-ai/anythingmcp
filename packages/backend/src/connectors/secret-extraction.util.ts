import {
  findSecretInHeader,
  findSecretInQueryParam,
  findSecretLiterals,
  isCredentialHeaderName,
  isCredentialLiteral,
  isSecretQueryName,
  type SecretFinding,
  type SecretKind,
} from '../common/secret-literals.util';
import { capToolName } from './parsers/tool-name.util';

/** Keys never written into a rebuilt map (prototype pollution). */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Moves secret literals out of a connector's base URL, headers and tools into
 * its (encrypted) variables, leaving a `{{VAR}}` reference behind.
 *
 * Used wherever a connector or its tools are written from user input: the
 * connector form, the tool editor, spec/Postman/cURL/JSON imports and the
 * backup restore. The caller stores `newEnvVars` together with the rewritten
 * fields and tells the user what moved (`moved`, which never carries the
 * secret itself, only a redacted pattern).
 *
 * Variable interpolation is applied to the base URL, headers, path, query
 * parameters, tool headers and body mapping on every call (see
 * env-interpolation.util.ts), so the rewritten connector sends exactly the
 * request it sent before.
 */

/**
 * Connector types whose base URL, headers and tools are scanned. A DATABASE
 * connector's base URL is a connection string and its tools' `path` is SQL;
 * a WEBHOOK connector sends nothing.
 */
export const SECRET_GUARDED_TYPES: ReadonlySet<string> = new Set([
  'REST',
  'SOAP',
  'GRAPHQL',
  'MCP',
  'ODATA',
]);

export interface MovedSecret {
  /** The variable that now holds the value. */
  variable: string;
  /** Where it was found: `baseUrl`, `headers.X-Api-Key`, `tool send_message: path`… */
  field: string;
  kind: SecretKind;
  /** Redacted shape, e.g. `bot<10 digits>:***(35)`; never the secret. */
  pattern: string;
}

/** A tool as written by a user or a parser; other fields are carried along. */
export interface ToolDraft {
  name: string;
  description?: unknown;
  parameters?: unknown;
  endpointMapping?: unknown;
}

type Json = Record<string, unknown>;

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function isObject(value: unknown): value is Json {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** `My Telegram Bot` → `MY_TELEGRAM_BOT`, a valid variable-name prefix. */
export function variablePrefix(connectorName: string): string {
  const words = String(connectorName ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  let prefix = '';
  for (const w of words) {
    const next = prefix ? `${prefix}_${w}` : w;
    if (next.length > 24) break;
    prefix = next;
  }
  if (!prefix) return 'CONNECTOR';
  return /^[0-9]/.test(prefix) ? `C_${prefix}` : prefix;
}

function upperSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    .join('_');
}

const QUERY_NAME_SUFFIX: Record<string, string> = {
  key: 'API_KEY',
  apikey: 'API_KEY',
  xapikey: 'API_KEY',
  sig: 'SIGNATURE',
  pwd: 'PASSWORD',
  passwd: 'PASSWORD',
};

const PREFIX_SUFFIX: Record<string, string> = {
  'sk-': 'API_KEY',
  sk_live_: 'SECRET_KEY',
  sk_test_: 'SECRET_KEY',
  rk_live_: 'SECRET_KEY',
  rk_test_: 'SECRET_KEY',
  AIza: 'API_KEY',
  ghp_: 'TOKEN',
  github_pat_: 'TOKEN',
  'glpat-': 'TOKEN',
  'xox-': 'TOKEN',
  EAA: 'ACCESS_TOKEN',
  shpat_: 'ACCESS_TOKEN',
  jwt: 'TOKEN',
};

/** Strings exactly equal to these parts of a secret appear in tool names. */
function secretFragments(value: string): string[] {
  return value.split(/[^A-Za-z0-9]+/).filter((part) => part.length >= 6);
}

/** `POST /bot{{TOKEN}}/sendMessage` → `post_bot_sendMessage`. */
export function toolNameFromPath(method: string, path: string): string {
  const verb = HTTP_METHODS.has(String(method).toUpperCase()) ? String(method).toLowerCase() : 'call';
  const clean = String(path ?? '')
    .split('?')[0]
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/\{[^{}]*\}/g, '')
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return capToolName(`${verb}_${clean || 'request'}`);
}

function replaceAll(text: string, search: string, replacement: string): string {
  return search ? text.split(search).join(replacement) : text;
}

function deepReplace(value: unknown, pairs: Array<[string, string]>, depth = 0): unknown {
  if (typeof value === 'string') {
    let out = value;
    for (const [from, to] of pairs) out = replaceAll(out, from, to);
    return out;
  }
  if (depth > 30 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => deepReplace(v, pairs, depth + 1));
  // Keys too: a hand-built tool can name a parameter or a query key after
  // the secret itself, and `required` then lists the same string.
  return Object.fromEntries(
    Object.entries(value as Json).map(([k, v]) => [
      deepReplace(k, pairs, depth + 1) as string,
      deepReplace(v, pairs, depth + 1),
    ]),
  );
}

export class SecretExtractor {
  readonly moved: MovedSecret[] = [];
  /** Variables to add to the connector: name → secret. */
  readonly newEnvVars: Record<string, string> = {};
  /** New names of tools whose old name contained a secret (the old name is not kept). */
  readonly renamedTools: string[] = [];

  private readonly prefix: string;
  private readonly existing: Record<string, string>;
  private readonly takenToolNames: Set<string>;
  private secretCounter = 0;

  constructor(
    connectorName: string,
    envVars?: Record<string, unknown> | null,
    opts: { takenToolNames?: Iterable<string> } = {},
  ) {
    this.prefix = variablePrefix(connectorName);
    this.existing = Object.fromEntries(
      Object.entries(envVars ?? {}).filter(([, v]) => typeof v === 'string'),
    ) as Record<string, string>;
    this.takenToolNames = new Set(opts.takenToolNames ?? []);
  }

  /** Every secret value moved so far, for scrubbing other text. */
  get values(): string[] {
    return Object.values(this.newEnvVars).concat(
      this.moved
        .map((m) => this.existing[m.variable])
        .filter((v): v is string => typeof v === 'string'),
    );
  }

  get changed(): boolean {
    return this.moved.length > 0 || this.renamedTools.length > 0;
  }

  /** The variable holding `value`: an existing one with that value, or a new one. */
  private allocate(value: string, suggestion: string): string {
    const all = { ...this.existing, ...this.newEnvVars };
    const same = Object.entries(all).find(([, v]) => v === value);
    if (same) return same[0];
    let name = suggestion;
    for (let i = 2; Object.prototype.hasOwnProperty.call(all, name); i++) {
      name = `${suggestion}_${i}`;
    }
    this.newEnvVars[name] = value;
    return name;
  }

  private suggestName(f: SecretFinding): string {
    switch (f.kind) {
      case 'telegram_bot_token':
        return 'TELEGRAM_BOT_TOKEN';
      case 'secret_query_param': {
        const normalized = f.label.toLowerCase().replace(/[-_\s]/g, '');
        return `${this.prefix}_${QUERY_NAME_SUFFIX[normalized] ?? (upperSnake(f.label) || 'SECRET')}`;
      }
      case 'credential_header': {
        const header = upperSnake(f.label).replace(/^X_/, '');
        return `${this.prefix}_${header === 'AUTHORIZATION' ? 'TOKEN' : header || 'SECRET'}`;
      }
      case 'known_prefix':
      case 'jwt':
        return `${this.prefix}_${PREFIX_SUFFIX[f.label] ?? 'TOKEN'}`;
      case 'high_entropy':
      default:
        return `${this.prefix}_SECRET_${++this.secretCounter}`;
    }
  }

  private move(f: SecretFinding, field: string, suggestion?: string): string {
    const variable = this.allocate(f.value, suggestion ?? this.suggestName(f));
    this.moved.push({ variable, field, kind: f.kind, pattern: f.pattern });
    return variable;
  }

  /** `text` with each finding replaced by its `{{VAR}}` reference. */
  private rewrite(text: string, findings: SecretFinding[], field: string): string {
    let out = text;
    for (const f of [...findings].sort((a, b) => b.start - a.start)) {
      const variable = this.move(f, field);
      out = `${out.slice(0, f.start)}{{${variable}}}${out.slice(f.end)}`;
    }
    return out;
  }

  /** A base URL, a path or a URL-valued setting. */
  extractUrl(url: string, field: string): string {
    if (typeof url !== 'string' || !url) return url;
    return this.rewrite(url, findSecretLiterals(url), field);
  }

  /**
   * Header values. `only` limits the scan to these names (an update scans the
   * values it changes, not the ones it merely keeps).
   */
  extractHeaders(
    headers: Record<string, unknown> | null | undefined,
    field: string,
    only?: Set<string>,
  ): Record<string, unknown> | null | undefined {
    if (!isObject(headers)) return headers;
    const out: Json = {};
    for (const [name, value] of Object.entries(headers)) {
      if ((only && !only.has(name)) || typeof value !== 'string') {
        out[name] = value;
        continue;
      }
      out[name] = this.rewrite(value, findSecretInHeader(name, value), `${field}.${name}`);
    }
    return out;
  }

  /**
   * One tool: path, query parameters, tool headers and parameter defaults are
   * rewritten; then every moved value is replaced wherever else it appears
   * (description, body), and a name that contained a secret is regenerated
   * from the rewritten path.
   */
  extractTool<T extends ToolDraft>(tool: T): T {
    const label = `tool ${this.toolLabel(tool)}`;
    const before = this.moved.length;
    const em: Json = isObject(tool.endpointMapping) ? { ...tool.endpointMapping } : {};
    const parameters: Json | undefined = isObject(tool.parameters)
      ? { ...tool.parameters }
      : undefined;

    if (typeof em.path === 'string') {
      em.path = this.extractUrl(em.path, `${label}: path`);
    }
    if (isObject(em.queryParams)) {
      const query: Json = {};
      for (const [name, value] of Object.entries(em.queryParams)) {
        if (UNSAFE_KEYS.has(name)) continue;
        if (typeof value !== 'string') {
          query[name] = value;
          continue;
        }
        const found = findSecretInQueryParam(name, value);
        query[name] = this.rewrite(value, found, `${label}: query ${name}`);
      }
      em.queryParams = query;
    }
    if (isObject(em.headers)) {
      em.headers = this.extractHeaders(em.headers, `${label}: header`);
    }
    if (parameters) this.extractParameterDefaults(parameters, em, label);

    let next: T = { ...tool, endpointMapping: em, ...(parameters ? { parameters } : {}) };

    // The same value elsewhere in this tool (a cURL import writes the path
    // into the description) or a connector-level secret quoted in it.
    const pairs = this.replacementPairs();
    if (pairs.length > 0) {
      const { name, ...rest } = next;
      next = { ...(deepReplace(rest, pairs) as T), name };
    }

    if (this.nameLeaksSecret(next.name)) {
      const mapping = next.endpointMapping as Json;
      const renamed = this.uniqueName(
        toolNameFromPath(String(mapping.method ?? 'call'), String(mapping.path ?? '')),
      );
      next = { ...next, name: renamed };
      this.renamedTools.push(renamed);
      // The moved entries were labelled with the old name.
      for (const m of this.moved.slice(before)) {
        m.field = m.field.replace(label, `tool ${renamed}`);
      }
    }
    this.takenToolNames.add(next.name);
    return next;
  }

  /** A tool label that never prints a secret. */
  private toolLabel(tool: ToolDraft): string {
    return this.nameLeaksSecret(tool.name) ? '(name withheld)' : tool.name;
  }

  private replacementPairs(): Array<[string, string]> {
    const all = { ...this.existing, ...this.newEnvVars };
    const used = new Set(this.moved.map((m) => m.variable));
    return Object.entries(all)
      .filter(([name, value]) => used.has(name) && value.length >= 6)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([name, value]) => [value, `{{${name}}}`]);
  }

  /**
   * A parameter whose default is a credential (a cURL import turns
   * `?api_key=…` into a parameter with that default): the AI client would see
   * it in the schema. The mappings that read it get the variable instead and
   * the parameter goes.
   */
  private extractParameterDefaults(parameters: Json, em: Json, label: string): void {
    if (!isObject(parameters.properties)) return;
    const properties: Json = { ...parameters.properties };
    let required = Array.isArray(parameters.required) ? [...parameters.required] : undefined;

    for (const [param, schema] of Object.entries(properties)) {
      if (UNSAFE_KEYS.has(param)) continue;
      if (!isObject(schema) || typeof schema.default !== 'string') continue;
      const value = schema.default;
      const ref = `$${param}`;
      const slots = this.referencesOf(em, ref, param);
      const credentialSlot =
        isSecretQueryName(param) ||
        isCredentialHeaderName(param) ||
        slots.some((s) => s.credential);
      // A random-looking default alone (a spreadsheet or folder id) is not
      // a secret: only a known key shape, or any credential in a credential
      // slot, is. Moving an id would also drop the parameter from the schema.
      const shaped = findSecretLiterals(value, { query: false })
        .filter((f) => f.start === 0 && f.end === value.length)
        .filter((f) => f.kind !== 'high_entropy' || credentialSlot);
      const isSecret = shaped.length > 0 || (credentialSlot && isCredentialLiteral(value));
      if (!isSecret) continue;

      const finding: SecretFinding = shaped[0] ?? {
        kind: 'secret_query_param',
        value,
        start: 0,
        end: value.length,
        label: param,
        pattern: `${param}=***(${value.length})`,
      };
      const variable = this.move(finding, `${label}: parameter ${param}`,
        shaped[0] ? undefined : `${this.prefix}_${QUERY_NAME_SUFFIX[param.toLowerCase().replace(/[-_]/g, '')] ?? upperSnake(param)}`);
      const placeholder = `{{${variable}}}`;
      for (const slot of slots) slot.set(placeholder);
      if (slots.length > 0) {
        delete properties[param];
        if (required) required = required.filter((r) => r !== param);
      } else {
        const { default: _drop, ...restSchema } = schema;
        properties[param] = restSchema;
      }
    }
    parameters.properties = properties;
    if (required) parameters.required = required;
  }

  /** Mapping entries that read parameter `param`: query, header, body and `{param}` in the path. */
  private referencesOf(
    em: Json,
    ref: string,
    param: string,
  ): Array<{ credential: boolean; set: (value: string) => void }> {
    const out: Array<{ credential: boolean; set: (value: string) => void }> = [];
    const scan = (key: 'queryParams' | 'headers' | 'bodyMapping', credential: (name: string) => boolean) => {
      const map = em[key];
      if (!isObject(map)) return;
      for (const [name, value] of Object.entries(map)) {
        if (value !== ref || UNSAFE_KEYS.has(name)) continue;
        out.push({
          credential: credential(name),
          set: (v) => {
            em[key] = { ...(em[key] as Json), [name]: v };
          },
        });
      }
    };
    scan('queryParams', isSecretQueryName);
    scan('headers', isCredentialHeaderName);
    scan('bodyMapping', isSecretQueryName);
    if (typeof em.path === 'string' && em.path.includes(`{${param}}`)) {
      out.push({
        credential: false,
        set: (v) => {
          em.path = replaceAll(String(em.path), `{${param}}`, v);
        },
      });
    }
    return out;
  }

  private nameLeaksSecret(name: unknown): boolean {
    if (typeof name !== 'string' || !name) return false;
    if (findSecretLiterals(name).length > 0) return true;
    const lower = name.toLowerCase();
    return this.values.some((value) =>
      secretFragments(value).some((part) => lower.includes(part.toLowerCase())),
    );
  }

  private uniqueName(name: string): string {
    let candidate = name;
    for (let i = 2; this.takenToolNames.has(candidate); i++) {
      candidate = capToolName(`${name}_${i}`);
    }
    return candidate;
  }

  /** What the API answers about it: nothing secret. */
  summary(): SecretMoveSummary {
    if (!this.changed) return {};
    const notice = describeMovedSecrets(this.moved);
    return {
      ...(this.moved.length ? { secretsMoved: this.moved } : {}),
      ...(this.renamedTools.length ? { renamedTools: this.renamedTools } : {}),
      ...(notice ? { secretsNotice: notice } : {}),
    };
  }
}

/** Added to API answers when something moved; empty otherwise. */
export interface SecretMoveSummary {
  secretsMoved?: MovedSecret[];
  renamedTools?: string[];
  /** One sentence for the UI or the chat. */
  secretsNotice?: string;
}

/** Several summaries (one per tool, or per connector of a backup) as one. */
export function mergeSummaries(parts: SecretMoveSummary[]): SecretMoveSummary {
  const moved = parts.flatMap((p) => p.secretsMoved ?? []);
  const renamed = parts.flatMap((p) => p.renamedTools ?? []);
  const notice = describeMovedSecrets(moved);
  return {
    ...(moved.length ? { secretsMoved: moved } : {}),
    ...(renamed.length ? { renamedTools: renamed } : {}),
    ...(notice ? { secretsNotice: notice } : {}),
  };
}

/** One sentence for the UI and the chat. */
export function describeMovedSecrets(moved: MovedSecret[]): string | null {
  if (moved.length === 0) return null;
  const variables = [...new Set(moved.map((m) => m.variable))];
  return (
    `A secret was written directly into ${[...new Set(moved.map((m) => m.field))].join(', ')}. ` +
    `It was moved into the encrypted variable${variables.length > 1 ? 's' : ''} ` +
    `${variables.join(', ')} and is now referenced as ${variables.map((v) => `{{${v}}}`).join(', ')}.`
  );
}
