/**
 * What a request and its response contribute to a log line.
 *
 * pino-http's default serializers write every request and response header,
 * and the request object is bound to every line logged while the request
 * runs. On cloud that was most of the backend log: about 1.2 KB of headers
 * per `/mcp` request, so the docker log (5 x 50 MB) only reached back about
 * 5.7 hours on 21 Oct 2026. The fields kept here are the ones the logs are
 * read for: which request (id), what (method, path, MCP method), from whom
 * (client, address; user and workspace come from customProps) and how it
 * ended (status; the duration is added by pino-http as responseTime).
 *
 * Only named headers are read, so a credential can never end up in a line
 * whatever header it arrives in. The query string is dropped from the path:
 * OAuth callbacks and one-time links carry codes and tokens there.
 */

/** The request as pino's wrapped serializer hands it over (`raw` is the IncomingMessage). */
interface SerializedRequestInput {
  id?: unknown;
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  remoteAddress?: string;
}

export interface LoggedRequest {
  id?: unknown;
  method?: string;
  url?: string;
  mcpMethod?: string;
  userAgent?: string;
  ip?: string;
}

/** Longest header value kept; a client can send anything. */
const MAX_HEADER_CHARS = 200;

function header(
  headers: SerializedRequestInput['headers'],
  name: string,
): string | undefined {
  const value = headers?.[name];
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first !== 'string' || !first) return undefined;
  return first.length > MAX_HEADER_CHARS ? first.slice(0, MAX_HEADER_CHARS) : first;
}

export function serializeRequest(req: SerializedRequestInput): LoggedRequest {
  const url = typeof req?.url === 'string' ? req.url.split('?')[0] : undefined;
  // The first X-Forwarded-For hop is the client as the reverse proxy saw it.
  const forwarded = header(req?.headers, 'x-forwarded-for')?.split(',')[0]?.trim();
  const out: LoggedRequest = { id: req?.id, method: req?.method, url };
  const mcpMethod = header(req?.headers, 'mcp-method');
  if (mcpMethod) out.mcpMethod = mcpMethod;
  const userAgent = header(req?.headers, 'user-agent');
  if (userAgent) out.userAgent = userAgent;
  const ip = forwarded || req?.remoteAddress;
  if (ip) out.ip = ip;
  return out;
}

export function serializeResponse(res: { statusCode?: number }): { statusCode?: number } {
  return { statusCode: res?.statusCode };
}
