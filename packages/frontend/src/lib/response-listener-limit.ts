import { subscribe } from 'node:diagnostics_channel';
import type { ServerResponse } from 'node:http';

/**
 * How many `close` listeners one response may carry before Node warns.
 *
 * Every request that a rewrite in next.config.ts proxies to the backend (/api,
 * /mcp, /auth, /register, ...) or to Sentry (the /monitoring tunnel) gets 10
 * `close` listeners from Next 16.3+ alone: its router, two abort controllers
 * and the httpxy proxy. The Sentry SDK adds 3 more (request isolation scope,
 * request session, server span), so each such response logged
 * "MaxListenersExceededWarning: Possible EventEmitter memory leak detected.
 * 11 close listeners added to [ServerResponse]" (vercel/next.js#97757).
 * The listeners belong to that one response and go with it, so this is not a
 * leak; 20 leaves room for both and still flags a response that really
 * piles them up.
 */
export const RESPONSE_MAX_LISTENERS = 20;

let installed = false;

/**
 * Raises the listener limit of every incoming request's response, and only of
 * those: other emitters keep Node's default of 10. Node publishes
 * `http.server.request.start` before the request handlers run.
 */
export function raiseResponseListenerLimit(limit = RESPONSE_MAX_LISTENERS): void {
  if (installed) return;
  installed = true;
  subscribe('http.server.request.start', (message) => {
    const { response } = message as { response?: ServerResponse };
    if (response && response.getMaxListeners() < limit) {
      response.setMaxListeners(limit);
    }
  });
}
