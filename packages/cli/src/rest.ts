// Minimal REST client for the AnythingMCP management API (`/api/*`).
// Authenticated with a management-scoped API key sent as a bearer token. The
// same transport guardrails as the MCP client apply: HTTPS only (except
// loopback), redirects refused so the key cannot follow a request to another
// origin, and the key is never taken from argv.

export const API_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type ApiMethod = (typeof API_METHODS)[number];

function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

export function apiBase(url: string): URL {
  const base = new URL(url);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error('Invalid instance URL');
  }
  if (base.protocol === 'http:' && !isLoopback(base.hostname)) {
    throw new Error('HTTP is allowed only for localhost or loopback addresses');
  }
  if (/\/mcp(\/|$)/.test(base.pathname)) {
    throw new Error('Pass the instance base URL, without /mcp');
  }
  return base;
}

export interface ApiResult {
  status: number;
  ok: boolean;
  data: unknown;
}

export async function apiRequest(options: {
  url: string;
  key: string;
  method: ApiMethod;
  path: string;
  body?: unknown;
  timeoutMs?: number;
}): Promise<ApiResult> {
  const base = apiBase(options.url);
  if (!options.path.startsWith('/')) {
    throw new Error('Path must start with /');
  }
  const target = new URL(options.path, base);
  // Never let the path escape the instance origin (e.g. a leading `//host`).
  if (target.origin !== base.origin) {
    throw new Error('Path must stay on the instance origin');
  }

  const controller = new AbortController();
  const timer = options.timeoutMs
    ? setTimeout(() => controller.abort(), options.timeoutMs)
    : undefined;
  try {
    const response = await fetch(target, {
      method: options.method,
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${options.key}`,
        Accept: 'application/json',
        ...(options.body !== undefined
          ? { 'Content-Type': 'application/json' }
          : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const text = await response.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: response.status, ok: response.ok, data };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
