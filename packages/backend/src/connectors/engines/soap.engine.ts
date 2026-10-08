import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import { assertSafeOutboundUrl, SsrfBlockedError } from '../../common/ssrf.util';
import { outboundAxiosOptions } from '../../common/outbound-http';
import {
  openWsdl,
  resolveWsdlOperation,
  soap12Ports,
  wsdlTargetNamespace,
  wsdlUrlForLog,
  WsdlOperationInfo,
} from '../parsers/wsdl.parser';
import { SoapEndpointMapping } from './engine-types';

/** SOAP metadata of one operation, read from the WSDL when a tool lacks it. */
type WsdlOperationMeta = WsdlOperationInfo & {
  targetNamespace: string;
  paramOrder: string[];
};

/** What the engine keeps of a parsed WSDL: strings only, not the parsed document. */
interface WsdlMetadata {
  targetNamespace: string;
  portEndpoints: Map<string, string>;
  /** Keyed by `${port}\n${operation}`. */
  operations: Map<string, WsdlOperationMeta>;
  /** What a connection test reports. */
  summary: WsdlSummary;
}

interface WsdlCacheEntry {
  expiresAt: number;
  /** null when the WSDL could not be read. */
  metadata: Promise<WsdlMetadata | null>;
}

const WSDL_CACHE_TTL_MS = 10 * 60_000;
const WSDL_FAILURE_TTL_MS = 60_000;
const WSDL_CACHE_MAX_ENTRIES = 100;

// OASIS WSS 1.0 UsernameToken profile.
const WSSE_NS =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
const WSU_NS =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd';
const USERNAME_TOKEN_PROFILE =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0';
const BASE64_BINARY =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary';
/** Lifetime of the optional wsu:Timestamp. */
const WSSE_TIMESTAMP_TTL_MS = 300_000;
/**
 * Stands in for the WS-Security header in every envelope that leaves the
 * engine (error detail returned to MCP clients and the UI): the real one
 * carries the password, or a digest and nonce that can be replayed.
 */
const REDACTED_SECURITY_HEADER = '<wsse:Security><!-- redacted --></wsse:Security>';
/** Any Security header block, whatever its prefix, in a server's response. */
const SECURITY_HEADER_BLOCK = /<([\w.-]+:)?Security\b[\s\S]*?<\/([\w.-]+:)?Security\s*>/g;

const SOAP11_ENVELOPE_NS = 'http://schemas.xmlsoap.org/soap/envelope/';
const SOAP12_ENVELOPE_NS = 'http://www.w3.org/2003/05/soap-envelope';

/** The SOAP 1.2 media type, with the action as its quoted `action` parameter when there is one. */
function soap12ContentType(soapAction: string): string {
  const action = soapAction ? `; action="${soapAction.replace(/["\\]/g, '\\$&')}"` : '';
  return `application/soap+xml; charset=utf-8${action}`;
}

/** What a connection test reports about a WSDL. */
export interface WsdlSummary {
  /** Distinct operations (per service), i.e. the tools an import would create at most. */
  operations: number;
  ports: number;
  /** Ports with a SOAP 1.2 binding. */
  soap12Ports: number;
}

/** A WSDL that could not be downloaded or parsed. */
export class WsdlReadError extends Error {
  constructor(
    message: string,
    /** HTTP status of the WSDL response, when the server answered with one other than 200. */
    readonly status: number | undefined,
    /**
     * Whether the server answered over HTTP: with a status, or with a 200
     * that is not a WSDL. False for DNS, connection, timeout and TLS
     * failures, and for a host the SSRF guard blocks.
     */
    readonly reachedServer: boolean,
    /** Network error code (ENOTFOUND, ECONNREFUSED, ...), when there was one. */
    readonly code?: string,
  ) {
    super(message);
    this.name = 'WsdlReadError';
  }
}

/** Error codes that come with an HTTP answer (a redirect the client would not follow), not a transport failure. */
const ANSWERED_ERROR_CODES = new Set(['ERR_FR_TOO_MANY_REDIRECTS', 'ERR_BAD_RESPONSE', 'ERR_BAD_REQUEST']);

/**
 * The error of a WSDL download or parse, safe to show and log: node-soap's
 * message for a non-200 answer quotes the full URL (whose query may carry a
 * token) and the response body, so it is replaced by the status; any other
 * message gets the URL without user info and query string, and is shortened.
 */
function toWsdlReadError(err: any, wsdlUrl: string): WsdlReadError {
  const raw = String(err?.message ?? err ?? 'unknown error');
  const status =
    typeof err?.response?.status === 'number'
      ? err.response.status
      : Number(/\bCode: (\d{3})\b/.exec(raw)?.[1]) || undefined;
  const code = typeof err?.code === 'string' ? err.code : undefined;
  if (status) {
    return new WsdlReadError(`The WSDL request returned HTTP ${status}`, status, true, code);
  }
  const blocked = err instanceof SsrfBlockedError || /SSRF guard/.test(raw);
  // No code and not blocked: a document arrived, but it is not a WSDL (an
  // HTML page, a parse error).
  const reachedServer = !blocked && (!code || ANSWERED_ERROR_CODES.has(code));
  let message = raw.split(wsdlUrl).join(wsdlUrlForLog(wsdlUrl));
  if (message.length > 300) message = `${message.slice(0, 300)}…`;
  return new WsdlReadError(message, undefined, reachedServer, code);
}

/** How deep parameter values may nest (objects and arrays) before the call is refused. */
const MAX_NESTING_DEPTH = 20;
/** An XML element name without a prefix (NCName, close enough). */
const XML_NAME = /^[\p{L}_][\p{L}\p{N}\p{M}_.\-\u00B7\u203F\u2040]*$/u;

interface EnvelopeOptions {
  /** Child element order of nested parameters, by path (`address`, `order/lines`). */
  elementOrder?: Record<string, string[]>;
  /**
   * Whether parameter elements (and those nested in them) carry the `tns:`
   * prefix. Default true. Unprefixed elements are in no namespace, since the
   * envelope declares no default namespace: that is what an unqualified
   * element is.
   */
  qualified?: boolean;
  /** A SOAP 1.2 envelope instead of SOAP 1.1. */
  soap12?: boolean;
}

interface SerializeContext {
  /** `tns:` for qualified elements, '' for unqualified ones. */
  prefix: string;
  elementOrder: Record<string, string[]>;
}

/**
 * The element name of a parameter. soap's describe() marks a repeated
 * element (maxOccurs > 1) with `[]`, which older imports kept in the
 * parameter name; `[]` is not valid in an XML name.
 */
function elementName(key: string): string {
  return key.endsWith('[]') ? key.slice(0, -2) : key;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** The keys of an object: those named in `order` first, in that order, then the rest. */
function orderedFields(value: Record<string, unknown>, order?: string[]): string[] {
  const keys = Object.keys(value);
  if (!order || order.length === 0) return keys;
  const used = new Set<string>();
  for (const name of order) {
    for (const key of keys) {
      if (!used.has(key) && elementName(key) === name) used.add(key);
    }
  }
  // A Set iterates in insertion order: the schema's order, then the rest.
  for (const key of keys) used.add(key);
  return [...used];
}

/**
 * SoapEngine — executes SOAP calls using raw HTTP via axios.
 *
 * The node `soap` library is only used for WSDL parsing (to extract metadata
 * like SOAPAction, endpoint, and namespace). The actual HTTP call is made
 * with axios to avoid the library's tendency to generate bloated envelopes
 * and hang on certain WCF services.
 */
@Injectable()
export class SoapEngine {
  private readonly logger = new Logger(SoapEngine.name);
  /**
   * WSDL metadata by WSDL URL, oldest first. Keyed by the URL as configured
   * (it may carry credentials in its query string, so it stays in memory and
   * is logged without them). A WSDL is the same for every tenant that uses
   * the same URL; no tenant secret is part of it.
   */
  private readonly wsdlCache = new Map<string, WsdlCacheEntry>();

  async execute(
    config: {
      baseUrl: string;
      authType: string;
      authConfig?: Record<string, unknown>;
      headers?: Record<string, string>;
      specUrl?: string;
    },
    endpointMapping: SoapEndpointMapping,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const operationName = endpointMapping.method;

    // Resolve SOAP metadata — prefer stored values, fall back to WSDL parsing
    let soapAction = endpointMapping.soapAction || '';
    let endpoint = endpointMapping.endpoint || '';
    let targetNamespace = endpointMapping.targetNamespace || '';
    let paramOrder = endpointMapping.paramOrder || [];
    // Body wrapper element and its namespace. A tool imported before these
    // were stored has neither: with complete metadata it keeps sending
    // `<tns:{operation}>` in targetNamespace, exactly as before.
    let inputElement = endpointMapping.inputElement || '';
    let inputNamespace = endpointMapping.inputNamespace || '';

    if (!soapAction || !endpoint || !targetNamespace || paramOrder.length === 0) {
      const wsdlUrl = config.specUrl || config.baseUrl;
      const meta = await this.extractWsdlMetadata(
        wsdlUrl,
        endpointMapping.path,
        operationName,
      );
      if (!soapAction) soapAction = meta.soapAction;
      if (!endpoint) endpoint = meta.endpoint;
      if (!targetNamespace) targetNamespace = meta.targetNamespace;
      if (paramOrder.length === 0) paramOrder = meta.paramOrder;
      // The WSDL is read anyway: take the input element from it too, unless
      // the tool already says which one to use.
      if (!endpointMapping.inputElement && !endpointMapping.inputNamespace) {
        inputElement = meta.inputElement || '';
        inputNamespace = meta.inputNamespace || '';
      }
    }

    // Use connector baseUrl as endpoint fallback (for internal vs external IPs)
    if (!endpoint) {
      endpoint = config.baseUrl;
    }

    // Override the WSDL endpoint's host with the connector's baseUrl host.
    // WSDLs often advertise external IPs that aren't reachable from internal networks.
    endpoint = this.overrideEndpointHost(endpoint, config.baseUrl);

    this.logger.debug(
      `SOAP call: ${operationName} → ${endpoint} (SOAPAction: ${soapAction})`,
    );

    // Map parameters
    const soapParams = this.mapParams(endpointMapping.bodyMapping, params);

    // WS-Security travels in the SOAP header, not in an HTTP header.
    const securityHeader =
      config.authType === 'WS_SECURITY'
        ? this.buildSecurityHeader(config.authConfig)
        : undefined;

    // Opt-in, set on import for SOAP 1.2 ports: older tools stay SOAP 1.1.
    const soap12 = endpointMapping.soapVersion === '1.2';

    // Build the SOAP envelope (respecting WSDL parameter order for WCF)
    const elementOrder = this.validElementOrder(endpointMapping.elementOrder);
    const buildEnvelope = (header?: string) =>
      this.buildEnvelope(
        inputElement || operationName,
        inputNamespace || targetNamespace,
        soapParams,
        paramOrder,
        header,
        {
          elementOrder,
          // Opt-in, set on import: older tools keep qualified elements.
          qualified: endpointMapping.childElementsQualified !== false,
          soap12,
        },
      );
    const envelope = buildEnvelope(securityHeader);
    // The envelope as it may be shown in error details: never the credentials.
    const shownEnvelope = securityHeader
      ? buildEnvelope(REDACTED_SECURITY_HEADER)
      : envelope;
    const shownResponse = (data: unknown) =>
      securityHeader && typeof data === 'string'
        ? data.replace(SECURITY_HEADER_BLOCK, REDACTED_SECURITY_HEADER)
        : data;

    // Build headers. SOAP 1.1 requires the SOAPAction header even when the
    // action is empty: it is then sent as `""` (two double quotes), as WCF,
    // Axis and node-soap do. A non-empty action is sent as stored. SOAP 1.2
    // has no SOAPAction header: the action is a parameter of the media type
    // (RFC 3902), left out when empty.
    const headers: Record<string, string> = {
      ...(soap12
        ? { 'Content-Type': soap12ContentType(soapAction) }
        : { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: soapAction || '""' }),
      ...config.headers,
    };

    // Inject authentication
    const headersBeforeAuth = new Set(Object.keys(headers));
    this.injectAuth(headers, config.authType, config.authConfig);
    const credentialHeaders = [
      ...Object.keys(config.headers ?? {}),
      ...Object.keys(headers).filter((h) => !headersBeforeAuth.has(h)),
    ];

    // Resolve dynamic headers from endpoint mapping
    if (endpointMapping.headers) {
      for (const [key, value] of Object.entries(endpointMapping.headers)) {
        if (typeof value === 'string' && value.startsWith('$')) {
          const paramVal = params[value.substring(1)];
          if (paramVal !== undefined) {
            headers[key] = String(paramVal);
          }
        } else {
          headers[key] = value;
        }
      }
    }

    try {
      await assertSafeOutboundUrl(endpoint);
      const response = await axios.post(endpoint, envelope, {
        headers,
        timeout: 30000,
        // SOAP responses may have non-2xx status (SOAP faults return 500)
        validateStatus: (status) => status < 600,
        ...outboundAxiosOptions({ credentialHeaders }),
      });

      // Parse the SOAP response
      if (response.status >= 400) {
        // Some servers echo the request (and its Security header) in a fault.
        const responseBody = shownResponse(response.data);
        // SOAP 1.1 returns its faults with HTTP 500: say what the fault is
        // (in full in responseBody; Java stacks may put a stack trace in it).
        let fault = this.faultMessageOf(responseBody);
        if (fault && fault.length > 500) fault = `${fault.slice(0, 500)}…`;
        const detail: Record<string, unknown> = {
          error: `SOAP call failed with HTTP ${response.status}${fault ? `: ${fault}` : ''}`,
          status: response.status,
          statusText: response.statusText,
          endpoint,
          responseBody,
          requestBody: shownEnvelope,
        };
        const enrichedError = new Error(String(detail.error));
        (enrichedError as any).soapDetail = detail;
        throw enrichedError;
      }

      return this.parseResponse(response.data);
    } catch (err: any) {
      // Re-throw enriched errors
      if (err.soapDetail) throw err;

      // Axios network errors
      const detail: Record<string, unknown> = {
        error: err.message,
        endpoint,
        requestBody: shownEnvelope,
      };
      if (err.code) detail.code = err.code;
      if (err.response?.data) detail.responseBody = shownResponse(err.response.data);
      if (err.response?.status) detail.status = err.response.status;

      const enrichedError = new Error(err.message);
      (enrichedError as any).soapDetail = detail;
      throw enrichedError;
    }
  }

  /**
   * Build a SOAP 1.1 (or 1.2) envelope: the parameters wrapped in the body element
   * (the operation name unless the WSDL names another input element).
   * WCF services require parameters in WSDL-defined order.
   */
  private buildEnvelope(
    wrapperElement: string,
    targetNamespace: string,
    params: Record<string, unknown>,
    paramOrder: string[] = [],
    headerXml?: string,
    options: EnvelopeOptions = {},
  ): string {
    const ns = targetNamespace || 'http://tempuri.org/';
    const header = headerXml
      ? `  <soapenv:Header>\n    ${headerXml}\n  </soapenv:Header>`
      : '  <soapenv:Header/>';

    // Use paramOrder if available, otherwise fall back to object key order
    const orderedKeys =
      paramOrder.length > 0
        ? paramOrder.filter((k) => params[k] !== undefined)
        : Object.keys(params);

    const context: SerializeContext = {
      prefix: options.qualified === false ? '' : 'tns:',
      elementOrder: options.elementOrder ?? {},
    };
    const paramXml = orderedKeys
      .map((key) =>
        this.elementXml(key, params[key], context, '      ', 0, elementName(key), []),
      )
      .filter(Boolean)
      .join('\n');

    return `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="${options.soap12 ? SOAP12_ENVELOPE_NS : SOAP11_ENVELOPE_NS}" xmlns:tns="${ns}">
${header}
  <soapenv:Body>
    <tns:${wrapperElement}>
${paramXml}
    </tns:${wrapperElement}>
  </soapenv:Body>
</soapenv:Envelope>`;
  }

  /**
   * One parameter as XML, '' when it is left out.
   *
   * - null / undefined: left out
   * - an array: the element once per item (maxOccurs > 1 in the schema)
   * - a plain object: its fields as child elements, in the schema's order
   *   when the tool has one (`elementOrder`, set on import; a JSON column
   *   does not keep key order), then any other fields in the object's order
   * - a Date: its ISO 8601 form
   * - anything else: its text
   *
   * Every text is escaped and every name checked, since nested names come
   * from the caller. `ancestors` holds the objects and arrays being written,
   * to stop on a cycle.
   */
  private elementXml(
    rawName: string,
    value: unknown,
    context: SerializeContext,
    indent: string,
    depth: number,
    path: string,
    ancestors: object[],
  ): string {
    const name = elementName(rawName);
    if (!XML_NAME.test(name)) {
      throw new Error(`SOAP parameter "${rawName}" is not a valid XML element name`);
    }
    if (value === undefined || value === null) return '';

    if (typeof value === 'object' && !(value instanceof Date)) {
      if (ancestors.includes(value)) {
        throw new Error(`SOAP parameter "${path}" contains a circular reference`);
      }
      if (depth >= MAX_NESTING_DEPTH) {
        throw new Error(
          `SOAP parameter "${path}" is nested more than ${MAX_NESTING_DEPTH} levels deep`,
        );
      }
    }

    const tag = `${context.prefix}${name}`;
    if (Array.isArray(value)) {
      const inner = [...ancestors, value];
      return value
        .map((item) => this.elementXml(name, item, context, indent, depth + 1, path, inner))
        .filter(Boolean)
        .join('\n');
    }
    if (isPlainObject(value)) {
      const inner = [...ancestors, value];
      const children = orderedFields(value, context.elementOrder[path])
        .map((key) =>
          this.elementXml(
            key,
            value[key],
            context,
            `${indent}  `,
            depth + 1,
            `${path}/${elementName(key)}`,
            inner,
          ),
        )
        .filter(Boolean);
      return children.length > 0
        ? `${indent}<${tag}>\n${children.join('\n')}\n${indent}</${tag}>`
        : `${indent}<${tag}/>`;
    }

    let text: string;
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) {
        throw new Error(`SOAP parameter "${path}" is an invalid date`);
      }
      text = value.toISOString();
    } else {
      text = String(value);
    }
    return `${indent}<${tag}>${this.escapeXml(text)}</${tag}>`;
  }

  /** `elementOrder` of a stored tool, when it has the expected shape. */
  private validElementOrder(raw: unknown): Record<string, string[]> {
    const order: Record<string, string[]> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return order;
    for (const [path, names] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(names) && names.every((n) => typeof n === 'string')) {
        order[path] = names as string[];
      }
    }
    return order;
  }

  private escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * The wsse:Security header with a UsernameToken (OASIS WSS 1.0 UsernameToken
   * profile), from authConfig `username`, `password` and `passwordType`
   * (`PasswordText`, the default, or `PasswordDigest`).
   *
   * PasswordDigest = Base64(SHA-1(nonce + created + password)) and always
   * carries the Nonce and Created it was computed from; PasswordText carries
   * them only with `includeNonce: true`. `includeTimestamp: true` adds a
   * wsu:Timestamp valid for five minutes.
   */
  private buildSecurityHeader(authConfig?: Record<string, unknown>): string {
    const username = authConfig?.username == null ? '' : String(authConfig.username);
    const password = authConfig?.password == null ? undefined : String(authConfig.password);
    if (!username || password === undefined) {
      throw new Error(
        'WS-Security needs a username and a password in the connector authentication settings',
      );
    }

    const configuredType = String(authConfig?.passwordType || 'PasswordText');
    const kind = configuredType.slice(configuredType.lastIndexOf('#') + 1).toLowerCase();
    if (kind !== 'passwordtext' && kind !== 'passworddigest') {
      throw new Error(
        `Unsupported WS-Security passwordType "${configuredType}": use PasswordText or PasswordDigest`,
      );
    }
    const digest = kind === 'passworddigest';
    const enabled = (value: unknown) => value === true || value === 'true';

    const now = this.currentTime();
    const created = this.wsuDateTime(now);
    const lines = [
      `<wsse:Security xmlns:wsse="${WSSE_NS}" xmlns:wsu="${WSU_NS}" soapenv:mustUnderstand="1">`,
    ];
    if (enabled(authConfig?.includeTimestamp)) {
      const expires = this.wsuDateTime(new Date(now.getTime() + WSSE_TIMESTAMP_TTL_MS));
      lines.push(
        '  <wsu:Timestamp>',
        `    <wsu:Created>${created}</wsu:Created>`,
        `    <wsu:Expires>${expires}</wsu:Expires>`,
        '  </wsu:Timestamp>',
      );
    }
    lines.push(
      '  <wsse:UsernameToken>',
      `    <wsse:Username>${this.escapeXml(username)}</wsse:Username>`,
    );
    if (digest || enabled(authConfig?.includeNonce)) {
      const nonce = this.createNonce();
      const value = digest
        ? createHash('sha1')
            .update(Buffer.concat([nonce, Buffer.from(created, 'utf8'), Buffer.from(password, 'utf8')]))
            .digest('base64')
        : this.escapeXml(password);
      lines.push(
        `    <wsse:Password Type="${USERNAME_TOKEN_PROFILE}#${digest ? 'PasswordDigest' : 'PasswordText'}">${value}</wsse:Password>`,
        `    <wsse:Nonce EncodingType="${BASE64_BINARY}">${nonce.toString('base64')}</wsse:Nonce>`,
        `    <wsu:Created>${created}</wsu:Created>`,
      );
    } else {
      lines.push(
        `    <wsse:Password Type="${USERNAME_TOKEN_PROFILE}#PasswordText">${this.escapeXml(password)}</wsse:Password>`,
      );
    }
    lines.push('  </wsse:UsernameToken>', '</wsse:Security>');
    return lines.join('\n    ');
  }

  /** UTC, ISO 8601 without milliseconds (2026-10-08T07:00:00Z). */
  private wsuDateTime(date: Date): string {
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** Clock for WS-Security timestamps; tests replace it. */
  protected currentTime(): Date {
    return new Date();
  }

  /** 16 random bytes for the UsernameToken nonce; tests replace it. */
  protected createNonce(): Buffer {
    return randomBytes(16);
  }

  /**
   * Parse the SOAP response XML, extracting the body content.
   */
  private parseResponse(data: unknown): unknown {
    if (typeof data !== 'string') return data;

    try {
      const parsed = this.parseXml(data);

      // Navigate: Envelope → Body → first child (operation result)
      const envelope = parsed.Envelope || parsed['soap:Envelope'] || parsed;
      const body = envelope.Body || envelope['soap:Body'];
      if (!body) return parsed;

      // Check for SOAP fault
      if (body.Fault || body['soap:Fault']) {
        const fault = body.Fault || body['soap:Fault'];
        throw new Error(`SOAP Fault: ${this.faultText(fault)}`);
      }

      // Return the first child of Body (the operation response)
      const keys = Object.keys(body);
      if (keys.length === 1) return body[keys[0]];
      return body;
    } catch (err: any) {
      if (err.message?.startsWith('SOAP Fault:')) throw err;
      // If XML parsing fails, return raw data
      return data;
    }
  }

  private parseXml(data: string): any {
    return new XMLParser({ ignoreAttributes: false, removeNSPrefix: true }).parse(data);
  }

  /**
   * The message of a SOAP fault: `faultstring` in SOAP 1.1, `Reason/Text` in
   * SOAP 1.2 (an element with an xml:lang attribute, possibly one per
   * language), which the XML parser turns into objects.
   */
  private faultText(fault: any): string {
    const text = (node: unknown): string => {
      if (node == null) return '';
      if (Array.isArray(node)) return node.map(text).filter(Boolean).join('; ');
      if (typeof node === 'object') {
        const obj = node as Record<string, unknown>;
        return text(obj['#text'] ?? obj.Text);
      }
      return String(node).trim();
    };
    return text(fault?.faultstring) || text(fault?.Reason) || JSON.stringify(fault);
  }

  /** The fault message of a SOAP response body, when it is a fault. */
  private faultMessageOf(data: unknown): string | undefined {
    if (typeof data !== 'string') return undefined;
    try {
      const parsed = this.parseXml(data);
      const fault = (parsed?.Envelope ?? parsed)?.Body?.Fault;
      return fault ? this.faultText(fault) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * SOAP metadata of one operation, read from the WSDL. Cached per WSDL URL
   * (see wsdlCache), so a tool whose stored metadata is incomplete (an empty
   * soapAction is common for document/literal services) does not parse the
   * whole WSDL on every call.
   */
  private async extractWsdlMetadata(
    wsdlUrl: string,
    portName: string,
    operationName: string,
  ): Promise<WsdlOperationMeta> {
    let entry = this.cachedWsdl(wsdlUrl);
    if (!entry) {
      this.logger.debug(`Fetching WSDL metadata from: ${wsdlUrlForLog(wsdlUrl)}`);
      entry = this.cacheWsdl(wsdlUrl, this.readWsdlMetadata(wsdlUrl));
    }

    const metadata = await entry.metadata;
    const empty = { soapAction: '', endpoint: '', targetNamespace: '', paramOrder: [] };
    if (!metadata) return empty;
    return (
      metadata.operations.get(`${portName}\n${operationName}`) ?? {
        ...empty,
        endpoint: metadata.portEndpoints.get(portName) ?? '',
        targetNamespace: metadata.targetNamespace,
      }
    );
  }

  /** The cache entry of a WSDL, unless it has expired. */
  private cachedWsdl(wsdlUrl: string): WsdlCacheEntry | undefined {
    const entry = this.wsdlCache.get(wsdlUrl);
    if (entry && entry.expiresAt <= this.currentTime().getTime()) {
      this.wsdlCache.delete(wsdlUrl);
      return undefined;
    }
    return entry;
  }

  private cacheWsdl(wsdlUrl: string, metadata: Promise<WsdlMetadata | null>): WsdlCacheEntry {
    const entry: WsdlCacheEntry = {
      expiresAt: this.currentTime().getTime() + WSDL_CACHE_TTL_MS,
      metadata,
    };
    // A WSDL that could not be read is retried sooner.
    void metadata.then((read) => {
      if (!read) entry.expiresAt = this.currentTime().getTime() + WSDL_FAILURE_TTL_MS;
    });
    this.wsdlCache.delete(wsdlUrl);
    this.wsdlCache.set(wsdlUrl, entry);
    while (this.wsdlCache.size > WSDL_CACHE_MAX_ENTRIES) {
      this.wsdlCache.delete(this.wsdlCache.keys().next().value as string);
    }
    return entry;
  }

  /** Read every operation of a WSDL, using the soap library for parsing only. */
  private async readWsdlMetadata(wsdlUrl: string): Promise<WsdlMetadata | null> {
    try {
      // Without the library's own cache (see openWsdl): wsdlCache is bounded.
      return this.wsdlMetadataOf(await openWsdl(wsdlUrl));
    } catch (err: any) {
      // The library's message may quote the URL with its query string.
      this.logger.warn(
        `Failed to extract WSDL metadata from ${wsdlUrlForLog(wsdlUrl)}: ${toWsdlReadError(err, wsdlUrl).message}`,
      );
      return null;
    }
  }

  private wsdlMetadataOf(client: Awaited<ReturnType<typeof openWsdl>>): WsdlMetadata {
    const wsdl = client.wsdl;
    const targetNamespace = wsdlTargetNamespace(wsdl);

    const portEndpoints = new Map<string, string>();
    for (const service of Object.values(wsdl.definitions?.services || {}) as any[]) {
      for (const [portName, port] of Object.entries((service?.ports || {}) as Record<string, any>)) {
        if (port?.location && !portEndpoints.has(portName)) {
          portEndpoints.set(portName, port.location);
        }
      }
    }

    const operations = new Map<string, WsdlOperationMeta>();
    const operationNames = new Set<string>();
    let ports = 0;
    for (const [serviceName, service] of Object.entries(client.describe())) {
      for (const [portName, port] of Object.entries(service as Record<string, any>)) {
        ports++;
        for (const [operationName, operation] of Object.entries(port as Record<string, any>)) {
          operationNames.add(`${serviceName}\n${operationName}`);
          const key = `${portName}\n${operationName}`;
          // The first service with an input for the operation wins, as before.
          if (operations.get(key)?.paramOrder.length) continue;
          operations.set(key, {
            ...resolveWsdlOperation(wsdl, portName, operationName),
            targetNamespace,
            paramOrder: operation?.input ? Object.keys(operation.input) : [],
          });
        }
      }
    }
    return {
      targetNamespace,
      portEndpoints,
      operations,
      summary: {
        operations: operationNames.size,
        ports,
        soap12Ports: soap12Ports(wsdl).size,
      },
    };
  }

  /**
   * Download and parse a WSDL for a connection test, through the same
   * guarded path and cache as a tool call: a WSDL read in the last ten
   * minutes is not downloaded again (the health check runs on every
   * dashboard load), and one read here serves the next tool call. A WSDL
   * that could not be read is always tried again. Calls no operation.
   * Throws a WsdlReadError whose message carries neither the URL's
   * credentials nor the response body.
   */
  async inspectWsdl(wsdlUrl: string): Promise<WsdlSummary> {
    const cached = await this.cachedWsdl(wsdlUrl)?.metadata;
    if (cached) return cached.summary;
    let metadata: WsdlMetadata;
    try {
      metadata = this.wsdlMetadataOf(await openWsdl(wsdlUrl));
    } catch (err: any) {
      throw toWsdlReadError(err, wsdlUrl);
    }
    this.cacheWsdl(wsdlUrl, Promise.resolve(metadata));
    return metadata.summary;
  }

  private injectAuth(
    headers: Record<string, string>,
    authType: string,
    authConfig?: Record<string, unknown>,
  ): void {
    if (!authConfig) return;

    switch (authType) {
      case 'BASIC_AUTH': {
        const credentials = Buffer.from(
          `${authConfig.username}:${authConfig.password}`,
        ).toString('base64');
        headers['Authorization'] = `Basic ${credentials}`;
        break;
      }
      case 'BEARER_TOKEN':
        headers['Authorization'] = `Bearer ${authConfig.token}`;
        break;
      case 'API_KEY':
        headers[String(authConfig.headerName || 'X-API-Key')] = String(
          authConfig.apiKey,
        );
        break;
    }
  }

  /**
   * Replace the host (scheme + hostname + port) of the WSDL endpoint
   * with the host from the connector's baseUrl. This handles the common
   * case where the WSDL advertises an external/public IP but the service
   * must be reached via an internal IP.
   */
  private overrideEndpointHost(
    wsdlEndpoint: string,
    connectorBaseUrl: string,
  ): string {
    try {
      // Strip query strings (e.g. ?singleWsdl) from baseUrl
      const baseClean = connectorBaseUrl.split('?')[0];
      const base = new URL(baseClean);
      const ep = new URL(wsdlEndpoint);

      // If hosts already match, no override needed
      if (ep.host === base.host) return wsdlEndpoint;

      this.logger.debug(
        `Overriding WSDL endpoint host: ${ep.host} → ${base.host}`,
      );
      ep.protocol = base.protocol;
      ep.hostname = base.hostname;
      ep.port = base.port;
      return ep.toString();
    } catch {
      // If URL parsing fails, return as-is
      return wsdlEndpoint;
    }
  }

  private mapParams(
    bodyMapping: Record<string, unknown> | undefined,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!bodyMapping) return params;

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(bodyMapping)) {
      if (typeof value === 'string' && value.startsWith('$')) {
        const paramName = value.substring(1);
        if (params[paramName] !== undefined) {
          result[key] = params[paramName];
        }
      } else {
        result[key] = value;
      }
    }
    return result;
  }
}
