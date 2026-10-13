/**
 * Returns the base origin/URL for API calls and MCP endpoints.
 *
 * In local development, the Next.js frontend runs on :3000 while the NestJS
 * backend runs on :4000. In production / cloud, requests share the same origin.
 */
export function getApiOrigin(): string {
  if (typeof window === 'undefined') return 'http://localhost:4000';
  return window.location.hostname === 'localhost'
    ? `${window.location.protocol}//${window.location.hostname}:4000`
    : window.location.origin;
}
