import { Injectable, Logger } from '@nestjs/common';
import { ParsedTool } from './openapi.parser';
import { capToolName, pathForToolName, MAX_TOOL_NAME_LENGTH } from './tool-name.util';

/**
 * HAR (HTTP Archive) parser.
 * Turns a browser network capture into REST tools, the same way "Copy as
 * cURL" + the cURL parser turns one request into one tool, but for a whole
 * recorded session.
 *
 * A HAR is live captured traffic, not a hand-written spec: it carries the
 * browser's own session cookies, bearer tokens and auth headers. Those never
 * become tool parameters or header mappings — the connector's own auth
 * settings supply credentials at call time. Response bodies are never read.
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

/** Fields whose name alone is enough to treat the value as a credential. */
const CREDENTIAL_NAME_RE = /(token|secret|password|passwd|api[-_]?key|session|csrf|xsrf|auth|signature|sig)/i;

const EXPLICIT_CREDENTIAL_HEADERS = new Set(['cookie', 'authorization', 'proxy-authorization']);

/** Headers that describe the browser/request, not the API, and the API's own content metadata (redundant with postData). */
const NOISE_HEADERS = new Set(['user-agent', 'origin', 'referer', 'content-length', 'content-type']);

function isPseudoHeader(name: string): boolean {
  return name.startsWith(':');
}

function isNoiseHeader(name: string): boolean {
  const n = name.toLowerCase();
  return NOISE_HEADERS.has(n) || n.startsWith('accept') || n.startsWith('sec-');
}

function isCredentialHeaderName(name: string): boolean {
  const n = name.toLowerCase();
  return EXPLICIT_CREDENTIAL_HEADERS.has(n) || isPseudoHeader(n) || CREDENTIAL_NAME_RE.test(n);
}

function isCredentialFieldName(name: string): boolean {
  return CREDENTIAL_NAME_RE.test(name);
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
  const bodyMapping: Record<string, string> = {};
  const headerMapping: Record<string, string> = {};

  for (const paramName of paramNames) {
    properties[paramName] = { type: 'string', description: `Path parameter: ${paramName}` };
    required.push(paramName);
  }

  for (const header of entry.request?.headers ?? []) {
    if (!header?.name || header.value == null) continue;
    if (isCredentialHeaderName(header.name) || isNoiseHeader(header.name)) continue;
    headerMapping[header.name] = header.value;
  }

  for (const query of entry.request?.queryString ?? []) {
    if (!query?.name) continue;
    if (isCredentialFieldName(query.name)) continue;
    const paramName = sanitizeIdent(query.name) || 'param';
    properties[paramName] = {
      type: 'string',
      description: `Query parameter: ${query.name}`,
      default: query.value,
    };
    queryParamsMapping[query.name] = `$${paramName}`;
  }

  const postData = entry.request?.postData;
  if (postData?.mimeType?.includes('application/json') && postData.text) {
    try {
      const parsed = JSON.parse(postData.text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          const paramName = sanitizeIdent(key) || 'field';
          if (isCredentialFieldName(key)) {
            properties[paramName] = {
              type: 'string',
              description: `Body field: ${key} (credential — value not captured from the recording)`,
            };
          } else {
            properties[paramName] = {
              type: inferType(value),
              description: `Body field: ${key}`,
              default: value,
            };
          }
          bodyMapping[key] = `$${paramName}`;
        }
      }
    } catch {
      // Not a JSON object body — skip mapping, keep the tool otherwise usable.
    }
  } else if (postData?.mimeType?.includes('application/x-www-form-urlencoded') && Array.isArray(postData.params)) {
    for (const field of postData.params) {
      if (!field?.name) continue;
      const paramName = sanitizeIdent(field.name) || 'field';
      if (isCredentialFieldName(field.name)) {
        properties[paramName] = {
          type: 'string',
          description: `Body field: ${field.name} (credential — value not captured from the recording)`,
        };
      } else {
        properties[paramName] = {
          type: 'string',
          description: `Body field: ${field.name}`,
          default: field.value,
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

      if (normalizedOrigin(url) !== normalizedOrigin(base) || !url.pathname.startsWith(basePrefix)) {
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
