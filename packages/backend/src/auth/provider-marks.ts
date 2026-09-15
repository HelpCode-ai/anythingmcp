/**
 * Inline SVG marks for the identity providers we know how to sign in with.
 *
 * Inline rather than `/logos/*.svg` + `<img>` (the repo's usual convention)
 * for two reasons that are specific to the backend-rendered login page:
 *
 *  - `/auth/login` only resolves `/logos/...` because the Next frontend
 *    proxies it. When the backend is reached directly — the Koch dashboard is
 *    LAN-only on the backend port, and the MCP OAuth flow lands here — an
 *    `<img>` would 404.
 *  - the monochrome marks (GitHub, Okta, Auth0) use `currentColor`, so they
 *    follow the button's text colour instead of vanishing in dark mode. A
 *    fixed-black file cannot do that.
 *
 * Mirrored by `packages/frontend/src/components/provider-mark.tsx`; keep the
 * two in step.
 *
 * BRANDING. The Microsoft four-square mark and the Google "G" are rendered
 * unmodified, in their official colours. Do NOT add "Sign in with Microsoft"
 * / "Sign in with Google" wording here: the button label is the admin's free
 * text (`IdentityProvider.name`) and we cannot guarantee compliant wording.
 *
 * SECURITY. This markup is trusted and must be concatenated into the page
 * WITHOUT passing through `escapeHtml` — while the provider name next to it
 * MUST be escaped. Never take the two through one templating call.
 */

const MARKS: Record<string, string> = {
  ENTRA:
    '<svg viewBox="0 0 21 21" aria-hidden="true">' +
    '<rect x="0" y="0" width="10" height="10" fill="#F25022"/>' +
    '<rect x="11" y="0" width="10" height="10" fill="#7FBA00"/>' +
    '<rect x="0" y="11" width="10" height="10" fill="#00A4EF"/>' +
    '<rect x="11" y="11" width="10" height="10" fill="#FFB900"/>' +
    '</svg>',
  GOOGLE:
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>' +
    '<path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>' +
    '<path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>' +
    '<path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>' +
    '</svg>',
  GITHUB:
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path fill="currentColor" d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>' +
    '</svg>',
  OKTA:
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path fill="currentColor" d="M12 0C5.389 0 0 5.35 0 12s5.35 12 12 12 12-5.35 12-12S18.611 0 12 0zm0 18c-3.325 0-6-2.675-6-6s2.675-6 6-6 6 2.675 6 6-2.675 6-6 6z"/>' +
    '</svg>',
  AUTH0:
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path fill="currentColor" d="M21.98 7.448L19.62 0H4.347L2.02 7.448c-1.352 4.312.03 9.206 3.815 12.015L12.007 24l6.157-4.552c3.755-2.81 5.182-7.688 3.815-12.015l-6.16 4.58 2.343 7.45-6.157-4.597-6.158 4.58 2.358-7.433-6.188-4.55 7.63-.045L12.008 0l2.356 7.404 7.615.044z"/>' +
    '</svg>',
};

/** Neutral key: generic OIDC and anything we do not recognise. */
const FALLBACK_MARK =
  '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="7.5" cy="15.5" r="4.5"/>' +
  '<path d="M10.7 12.3 21 2M15 8l3 3M18 5l3 3"/>' +
  '</svg>';

/**
 * The SVG for a provider type, wrapped so the page's CSS can size it. Returns
 * trusted markup — see the file header.
 */
export function providerMarkSvg(type: string | null | undefined): string {
  const svg = (type && MARKS[type.toUpperCase()]) || FALLBACK_MARK;
  return `<span class="sso-mark">${svg}</span>`;
}
