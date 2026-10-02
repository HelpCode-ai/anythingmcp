import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import * as http from 'http';
import * as https from 'https';
import {
  assertSafeOutboundUrl,
  assertSafeRedirectTarget,
  createSsrfGuardedAgents,
} from './ssrf.util';

/**
 * Wiring that makes an HTTP client keep the SSRF guard after the first check.
 *
 * Every outbound call to a user-supplied URL runs assertSafeOutboundUrl first.
 * That check alone does not hold: axios and fetch follow redirects to hosts
 * nobody checked, and resolve the name again when they connect. These helpers
 * close both gaps for the two clients we use:
 *  - axios: agents that check the address at connect time, plus a
 *    `beforeRedirect` hook for the scheme and literal-IP targets.
 *  - fetch: redirects followed by hand, each target checked like the first.
 */

let sharedAgents: { httpAgent: http.Agent; httpsAgent: https.Agent } | null = null;

function guardedAgents() {
  // The lookup reads process.env on every call, so one pair serves all.
  sharedAgents ??= createSsrfGuardedAgents();
  return sharedAgents;
}

function beforeRedirect(options: Record<string, any>): void {
  assertSafeRedirectTarget({ protocol: options.protocol, hostname: options.hostname });
}

/**
 * Spread into any axios config that calls a user-supplied URL. A caller that
 * needs its own agent (e.g. the operator's connector proxy) can set
 * httpAgent/httpsAgent after the spread; `beforeRedirect` still applies.
 */
export function ssrfGuardedAxiosOptions(): Pick<
  AxiosRequestConfig,
  'httpAgent' | 'httpsAgent' | 'beforeRedirect'
> {
  const { httpAgent, httpsAgent } = guardedAgents();
  return { httpAgent, httpsAgent, beforeRedirect };
}

let sharedAxios: AxiosInstance | null = null;

/** An axios instance with {@link ssrfGuardedAxiosOptions}, for libraries that take one (soap). */
export function ssrfGuardedAxios(): AxiosInstance {
  sharedAxios ??= axios.create(ssrfGuardedAxiosOptions());
  return sharedAxios;
}

const MAX_FETCH_REDIRECTS = 5;

/**
 * A `fetch` that follows redirects itself and runs assertSafeOutboundUrl on
 * every target. Same semantics as fetch otherwise: 307/308 keep method and
 * body, 301/302/303 turn a non-GET into a body-less GET, and Authorization
 * and Cookie are dropped when the redirect leaves the origin.
 */
export async function ssrfGuardedFetch(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  let url = typeof input === 'string' ? input : input.toString();
  let current: RequestInit = { ...init };
  await assertSafeOutboundUrl(url);
  for (let hop = 0; ; hop++) {
    const res = await fetch(url, { ...current, redirect: 'manual' });
    const location = res.headers.get('location');
    if (![301, 302, 303, 307, 308].includes(res.status) || !location) return res;
    if (init.redirect === 'manual') return res;
    if (init.redirect === 'error') throw new TypeError(`Redirect refused for ${url}`);
    if (hop >= MAX_FETCH_REDIRECTS) {
      throw new TypeError(`Too many redirects from ${new URL(url).origin}`);
    }
    await res.body?.cancel().catch(() => undefined);

    const next = new URL(location, url).toString();
    await assertSafeOutboundUrl(next);
    const method = (current.method ?? 'GET').toUpperCase();
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
      current = { ...current, method: 'GET', body: undefined };
    }
    if (new URL(next).origin !== new URL(url).origin) {
      const headers = new Headers(current.headers);
      headers.delete('authorization');
      headers.delete('cookie');
      current = { ...current, headers };
    }
    url = next;
  }
}
