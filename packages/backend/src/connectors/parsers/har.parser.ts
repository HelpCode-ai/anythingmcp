import { Injectable, Logger } from '@nestjs/common';
import { ParsedTool } from './openapi.parser';
import { capToolName, pathForToolName, MAX_TOOL_NAME_LENGTH } from './tool-name.util';
import {
  findSecretLiterals,
  findSecretInQueryParam,
  isCredentialHeaderName as isSharedCredentialHeaderName,
  isSecretQueryName,
} from '../../common/secret-literals.util';

/**
 * HAR (HTTP Archive) parser.
 * Turns a browser network capture into REST tools, the same way "Copy as
 * cURL" + the cURL parser turns one request into one tool, but for a whole
 * recorded session.
 *
 * A HAR is live captured traffic, not a hand-written spec: it carries the
 * browser's own session cookies, bearer tokens and auth headers, in forms the
 * issue's own naming regex does not anticipate (`Ocp-Apim-Subscription-Key`,
 * `?key=AIza…`, a bare JWT in a vendor-specific header). None of that becomes
 * a tool parameter, default or header mapping — the connector's own auth
 * settings supply credentials at call time, and a captured value belongs to
 * the user's browser session, never to the connector. Credentials are
 * dropped outright here, not promoted into connector variables the way the
 * generic import pipeline moves a hand-typed key: that pipeline still runs
 * after this parser (defense in depth), but by then nothing should be left
 * for it to find. Response bodies are never read.
 */

export interface HarParseResult {
  tools: ParsedTool[];
  skipped: {
    otherOrigin: number;
    staticAsset: number;
    duplicate: number;
  };
}

interface HarNameValue {
  name: string;
  value: string;
}

interface HarPostData {
  mimeType?: string;
  text?: string;
  params?: HarNameValue[];
}

interface HarRequest {
  method?: string;
  url?: string;
  headers?: HarNameValue[];
  queryString?: HarNameValue[];
  postData?: HarPostData;
}

interface HarEntry {
  request?: HarRequest;
  _resourceType?: string;
  _webSocketMessages?: unknown[];
}

/** Fields whose name alone is enough to treat the value as a credential (query params, body fields). */
const CREDENTIAL_NAME_RE = /(token|secret|password|passwd|api[-_]?key|session|csrf|xsrf|auth|signature|sig)/i;

function isCredentialFieldName(name: string): boolean {
  return CREDENTIAL_NAME_RE.test(name);
}

/** A value shaped like a bearer/basic/etc. credential, whatever its header or field is named. */
const AUTH_SCHEME_VALUE_RE = /^(Bearer|Basic|Token|Bot|ApiKey|Api-Key|Key|OAuth|SSWS|Digest)\s+\S+$/i;

/** A string value that looks like a credential by its shape, not just its name: a JWT, a known vendor key prefix, a bot token, or an auth-scheme value. */
function looksLikeCredentialValue(value: unknown): boolean {
  if (typeof value !== 'string' || !value) return false;
  if (AUTH_SCHEME_VALUE_RE.test(value.trim())) return true;
  return findSecretLiterals(value, { query: false }).length > 0;
}

/**
 * Headers worth replaying as static tool headers: `Accept` and vendor-specific
 * `X-…` headers, once those pass the credential checks below. Everything else
 * — conditional/caching headers (`If-None-Match`, `Cache-Control`), tracing
 * headers (`traceparent`, `baggage`), and ordinary browser noise — is left
 * out. An allowlist, not a denylist: a header this parser has never seen is
 * excluded by default, not included by default.
 */
const HEADER_ALLOW_RE = /^(accept|x-[a-z0-9-]+)$/i;

function isPseudoHeader(name: string): boolean {
  return name.startsWith(':');
}

function shouldKeepHeader(name: string, value: string): boolean {
  if (isPseudoHeader(name)) return false;
  if (!HEADER_ALLOW_RE.test(name)) return false;
  if (CREDENTIAL_NAME_RE.test(name) || isSharedCredentialHeaderName(name)) return false;
  if (looksLikeCredentialValue(value)) return false;
  return true;
}

const STATIC_EXTENSION_RE = /\.(?:js|mjs|css|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|map|mp4|mp3|webm)(?:[?#]|$)/i;
const STATIC_RESOURCE_TYPES = new Set(['script', 'stylesheet', 'image', 'font', 'media', 'favicon', 'websocket']);

function isStaticAssetOrSocket(entry: HarEntry, relativePath: string): boolean {
  const resourceType = entry._resourceType?.toLowerCase();
  if (resourceType && STATIC_RESOURCE_TYPES.has(resourceType)) return true;
  if (STATIC_EXTENSION_RE.test(relativePath)) return true;
  if (Array.isArray(entry._webSocketMessages)) return true;
  if (/^wss?:/i.test(entry.request?.url ?? '')) return true;
  return false;
}

/** `wss:`/`ws:` is `https:`/`http:` for origin matching: a capture's socket upgrade shares its page's origin. */
function normalizedOrigin(url: URL): string {
  const scheme = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
  return `${scheme}//${url.host}`;
}

/** Whether `pathname` is `prefix` or sits under it on a `/` boundary — `/v1` must not match into `/v1beta/x`. */
function pathHasPrefix(pathname: string, prefix: string): boolean {
  if (!prefix) return true;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_RE = /^\d+$/;
const LONG_HEX_RE = /^[0-9a-f]{16,}$/i;

function isIdLikeSegment(segment: string): boolean {
  return NUMERIC_RE.test(segment) || UUID_RE.test(segment) || LONG_HEX_RE.test(segment);
}

function sanitizeIdent(raw: string): string {
  const cleaned = raw
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return cleaned;
}

/** First unused name among `base`, `base_2`, `base_3`, … in `used`, reserving it. */
function ensureUniqueParamName(base: string, used: Set<string>): string {
  let name = base || 'param';
  let n = 2;
  while (used.has(name)) {
    name = `${base || 'param'}_${n++}`;
  }
  used.add(name);
  return name;
}

/**
 * Replaces id-looking path segments with a named placeholder, so
 * `/orders/123` and `/orders/456` collapse to one template with one `{id}`
 * parameter. A second id-like segment in the same path gets `{id_2}`, and so on.
 */
function templatePath(pathname: string): { template: string; paramNames: string[] } {
  const segments = pathname.split('/');
  const paramNames: string[] = [];
  const usedParamNames = new Set<string>();

  const out = segments.map((segment) => {
    if (segment.length > 0 && isIdLikeSegment(segment)) {
      let name = 'id';
      let n = 2;
      while (usedParamNames.has(name)) {
        name = `id_${n++}`;
      }
      usedParamNames.add(name);
      paramNames.push(name);
      return `{${name}}`;
    }
    return segment;
  });

  return { template: out.join('/') || '/', paramNames };
}

function inferType(value: unknown): string {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return 'array';
  return 'string';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Whether any string anywhere inside `value` (object, array or scalar) looks like a credential. */
function containsCredentialValue(value: unknown, depth = 0): boolean {
  if (depth > 10) return false;
  if (typeof value === 'string') return looksLikeCredentialValue(value);
  if (Array.isArray(value)) return value.some((v) => containsCredentialValue(v, depth + 1));
  if (isPlainObject(value)) {
    return Object.entries(value).some(
      ([k, v]) => isCredentialFieldName(k) || containsCredentialValue(v, depth + 1),
    );
  }
  return false;
}

function generateToolName(method: string, template: string): string {
  const cleanPath = pathForToolName(template)
    .replace(/\{[^{}]+\}/g, '')
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${method.toLowerCase()}_${cleanPath || 'request'}`;
}

function uniqueName(base: string, used: Map<string, number>): string {
  const capped = capToolName(base);
  const count = used.get(capped) ?? 0;
  used.set(capped, count + 1);
  if (count === 0) return capped;
  const suffix = `_${count + 1}`;
  const keep = Math.max(0, MAX_TOOL_NAME_LENGTH - suffix.length);
  return `${capped.slice(0, keep)}${suffix}`;
}

const MAX_BODY_WALK_DEPTH = 6;

/**
 * Recursively walks one JSON body value, writing scrubbed leaves into
 * `properties`/`bodyTemplate`. A plain object is never itself a leaf — it is
 * always walked into — so a nested secret (`user.password`) is caught and
 * dropped individually instead of the whole `user` object surviving as one
 * opaque default, and no object ever reaches `inferType` to be mistyped as a
 * `string`. Arrays and scalars are leaves: an array is scrubbed as a whole
 * (dropped if any element looks like a credential) rather than indexed.
 */
function walkJsonBody(
  value: unknown,
  keyChain: string[],
  properties: Record<string, any>,
  usedParamNames: Set<string>,
  depth: number,
): unknown {
  if (isPlainObject(value) && depth < MAX_BODY_WALK_DEPTH) {
    const template: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      template[key] = walkJsonBody(child, [...keyChain, key], properties, usedParamNames, depth + 1);
    }
    return template;
  }

  const lastKey = keyChain[keyChain.length - 1] ?? 'field';
  const label = keyChain.join('.');
  const isCredential = isCredentialFieldName(lastKey) || containsCredentialValue(value);
  const paramName = ensureUniqueParamName(sanitizeIdent(keyChain.join('_')) || 'field', usedParamNames);

  if (isCredential) {
    properties[paramName] = {
      type: 'string',
      description: `Body field: ${label} (credential — value not captured from the recording)`,
    };
  } else {
    properties[paramName] = {
      type: inferType(value),
      description: `Body field: ${label}`,
      default: value,
    };
  }
  return `$${paramName}`;
}

function buildTool(
  method: string,
  template: string,
  paramNames: string[],
  entry: HarEntry,
  usedNames: Map<string, number>,
): ParsedTool {
  const properties: Record<string, any> = {};
  const required: string[] = [];
  const queryParamsMapping: Record<string, string> = {};
  const bodyMapping: Record<string, unknown> = {};
  const headerMapping: Record<string, string> = {};
  const usedParamNames = new Set<string>(paramNames);

  for (const paramName of paramNames) {
    properties[paramName] = { type: 'string', description: `Path parameter: ${paramName}` };
    required.push(paramName);
  }

  for (const header of entry.request?.headers ?? []) {
    if (!header?.name || header.value == null) continue;
    if (!shouldKeepHeader(header.name, header.value)) continue;
    headerMapping[header.name] = header.value;
  }

  for (const query of entry.request?.queryString ?? []) {
    if (!query?.name) continue;
    const value = query.value ?? '';
    if (
      isCredentialFieldName(query.name) ||
      isSecretQueryName(query.name) ||
      findSecretInQueryParam(query.name, value).length > 0 ||
      looksLikeCredentialValue(value)
    ) {
      continue;
    }
    const paramName = ensureUniqueParamName(sanitizeIdent(query.name) || 'param', usedParamNames);
    properties[paramName] = {
      type: 'string',
      description: `Query parameter: ${query.name}`,
      default: value,
    };
    queryParamsMapping[query.name] = `$${paramName}`;
  }

  const postData = entry.request?.postData;
  if (postData?.mimeType?.includes('application/json') && postData.text) {
    try {
      const parsed = JSON.parse(postData.text);
      if (isPlainObject(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          bodyMapping[key] = walkJsonBody(value, [key], properties, usedParamNames, 1);
        }
      }
    } catch {
      // Not a JSON object body — skip mapping, keep the tool otherwise usable.
    }
  } else if (postData?.mimeType?.includes('application/x-www-form-urlencoded') && Array.isArray(postData.params)) {
    for (const field of postData.params) {
      if (!field?.name) continue;
      const value = field.value ?? '';
      const paramName = ensureUniqueParamName(sanitizeIdent(field.name) || 'field', usedParamNames);
      if (isCredentialFieldName(field.name) || looksLikeCredentialValue(value)) {
        properties[paramName] = {
          type: 'string',
          description: `Body field: ${field.name} (credential — value not captured from the recording)`,
        };
      } else {
        properties[paramName] = {
          type: 'string',
          description: `Body field: ${field.name}`,
          default: value,
        };
      }
      bodyMapping[field.name] = `$${paramName}`;
    }
  }

  const name = uniqueName(generateToolName(method, template), usedNames);
  const parameters: Record<string, unknown> = { type: 'object', properties };
  if (required.length > 0) parameters.required = required;

  const endpointMapping: ParsedTool['endpointMapping'] = { method, path: template };
  if (Object.keys(queryParamsMapping).length > 0) endpointMapping.queryParams = queryParamsMapping;
  if (Object.keys(bodyMapping).length > 0) endpointMapping.bodyMapping = bodyMapping;
  if (Object.keys(headerMapping).length > 0) endpointMapping.headers = headerMapping;

  return {
    name,
    description: `${method} ${template} (from HAR)`,
    parameters,
    endpointMapping,
  };
}

@Injectable()
export class HarParser {
  private readonly logger = new Logger(HarParser.name);

  parse(har: string, opts: { baseUrl: string }): HarParseResult {
    let doc: any;
    try {
      doc = JSON.parse(har);
    } catch (e: any) {
      throw new Error(`Invalid HAR file: not valid JSON (${e.message})`);
    }

    const entries: HarEntry[] = doc?.log?.entries;
    if (!Array.isArray(entries)) {
      throw new Error('Invalid HAR file: expected HAR 1.2 format with a log.entries array');
    }

    let base: URL;
    try {
      base = new URL(opts.baseUrl);
    } catch {
      throw new Error(`Invalid connector base URL: ${opts.baseUrl}`);
    }
    const basePrefix = base.pathname.replace(/\/$/, '');

    const skipped = { otherOrigin: 0, staticAsset: 0, duplicate: 0 };
    const order: string[] = [];
    const groups = new Map<string, { method: string; template: string; paramNames: string[]; entry: HarEntry }>();

    for (const entry of entries) {
      const req = entry?.request;
      if (!req?.url || !req?.method) continue;
      const method = req.method.toUpperCase();
      if (method === 'OPTIONS' || method === 'HEAD') continue;

      let url: URL;
      try {
        url = new URL(req.url);
      } catch {
        continue;
      }

      if (normalizedOrigin(url) !== normalizedOrigin(base) || !pathHasPrefix(url.pathname, basePrefix)) {
        skipped.otherOrigin++;
        continue;
      }

      const relativePath = (basePrefix ? url.pathname.slice(basePrefix.length) : url.pathname) || '/';

      if (isStaticAssetOrSocket(entry, relativePath)) {
        skipped.staticAsset++;
        continue;
      }

      const { template, paramNames } = templatePath(relativePath);
      const key = `${method} ${template}`;
      if (groups.has(key)) {
        skipped.duplicate++;
        continue;
      }
      groups.set(key, { method, template, paramNames, entry });
      order.push(key);
    }

    const usedNames = new Map<string, number>();
    const tools: ParsedTool[] = order.map((key) => {
      const g = groups.get(key)!;
      return buildTool(g.method, g.template, g.paramNames, g.entry, usedNames);
    });

    this.logger.log(
      `Parsed ${tools.length} tools from HAR (${skipped.otherOrigin} other origin, ${skipped.staticAsset} static/socket, ${skipped.duplicate} duplicate)`,
    );
    return { tools, skipped };
  }
}
