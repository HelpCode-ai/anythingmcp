import { AMCP_MARK_SVG, escapeHtml, renderAuthPage, type TrustRowOptions } from '../auth/auth-page';

/**
 * The HTML of the connect page (/auth/connect/:connectorId, served by
 * McpOAuthCallbackController): where a user connects their own account to a
 * connector with per-user credentials, without the dashboard. Pure rendering;
 * every value is escaped here.
 */

export type ConnectPageView =
  /** No connector behind the link, or none this browser's user may connect. */
  | { kind: 'unavailable' }
  /**
   * Not signed in: the workspace's identity providers, and the dashboard as
   * fallback. No connector name: the page is public.
   */
  | {
      kind: 'sign-in';
      ssoProviders: { id: string; name: string }[];
      dashboardUrl?: string;
    }
  /** The workspace has no Enterprise licence, which per-user sign-in needs. */
  | { kind: 'not-licensed'; connectorName: string; email: string }
  /** Signed in: connect, or connect again. */
  | {
      kind: 'ready';
      connectorName: string;
      email: string;
      /** The user may switch accounts (signed in on this page, not through the dashboard). */
      canSwitch: boolean;
      connected: boolean;
      authorizedAt?: string;
      /** The provider refused this user's sign-in: they must connect again. */
      needsReauth: boolean;
    };

export interface ConnectPageInput {
  view: ConnectPageView;
  csrfToken?: string;
  /** Form action: /auth/connect/<connectorId>. */
  action?: string;
  error?: string;
  /** Shown after a successful connection. */
  justConnected?: boolean;
  trust: TrustRowOptions;
}

const EXTRA_STYLES = `
  .status { display: flex; gap: 10px; align-items: flex-start; border: 1px solid var(--border); border-radius: 12px;
            padding: 14px 16px; margin-bottom: 16px; font-size: 14px; line-height: 1.5; }
  .status .dot { flex: none; width: 10px; height: 10px; border-radius: 50%; margin-top: 6px; background: var(--text-3); }
  .status.ok .dot { background: var(--ok); }
  .status.warn { background: #fffbeb; border-color: #fde68a; } .status.warn .dot { background: #d97706; }
  .done { background: #ecfdf3; color: #166534; border: 1px solid #bbf7d0; border-radius: 9px; padding: 10px 12px;
          margin-bottom: 16px; font-size: 14px; line-height: 1.45; }
  form.inline { display: inline; } form.inline button { min-height: 0; width: auto; padding: 0; border: 0; background: none;
          color: var(--brand); font-size: 13px; font-weight: 500; } form.inline button:hover { background: none; text-decoration: underline; }
`;

function pair(connectorName?: string): string {
  const initial = escapeHtml((connectorName?.trim()[0] || '?').toUpperCase());
  return `
    <div class="pair">
      <div class="tile">${AMCP_MARK_SVG}</div>
      <div class="dots"><i></i><i></i><i></i></div>
      <div class="tile tile-initial">${initial}</div>
    </div>`;
}

function formatDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10);
}

export function renderConnectPage(input: ConnectPageInput): string {
  const { view } = input;
  const error = input.error
    ? `<div class="error" role="alert">${escapeHtml(input.error)}</div>`
    : '';
  const csrf = input.csrfToken
    ? `<input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}">`
    : '';
  const action = escapeHtml(input.action ?? '');

  let card: string;
  let title: string;
  if (view.kind === 'unavailable') {
    title = 'Connection not available';
    card = `
    <h1>This link does not lead to a connection</h1>
    <p class="sub">The connector does not exist, does not sign users in with their own account,
      or belongs to a workspace you are not a member of. Ask your administrator for the right link.</p>
    ${error}`;
  } else if (view.kind === 'sign-in') {
    title = 'Connect your account';
    const buttons = view.ssoProviders
      .map(
        (p) =>
          `<button type="submit" name="action" value="sso:${escapeHtml(p.id)}" class="sso">` +
          `Continue with ${escapeHtml(p.name)}</button>`,
      )
      .join('');
    const dashboardUrl = view.dashboardUrl ? escapeHtml(view.dashboardUrl) : '';
    // Without an identity provider the dashboard is the only way to sign in.
    const signIn = buttons
      ? `<form method="post" action="${action}">${csrf}${buttons}</form>` +
        (dashboardUrl ? `<p class="links">Or <a href="${dashboardUrl}">open the connector in the dashboard</a>.</p>` : '')
      : `<p class="sub">Sign in to the AnythingMCP dashboard and connect your account on the connector's page.</p>` +
        (dashboardUrl ? `<a class="button" href="${dashboardUrl}">Open the dashboard</a>` : '');
    card = `${pair()}
    <h1>Connect your own account</h1>
    <p class="sub">Sign in to AnythingMCP first, so the account you connect is tied to you and nobody else.</p>
    ${error}
    ${signIn}`;
  } else if (view.kind === 'not-licensed') {
    title = `Connect your account to ${view.connectorName}`;
    card = `${pair(view.connectorName)}
    <h1>Per-user sign-in is not available</h1>
    <p class="sub">Connecting your own account to ${escapeHtml(view.connectorName)} needs AnythingMCP Enterprise.
      Ask a workspace administrator to renew the Enterprise licence.</p>
    <p class="note">Signed in as ${escapeHtml(view.email)}</p>
    ${error}`;
  } else {
    const name = escapeHtml(view.connectorName);
    title = `Connect your account to ${view.connectorName}`;
    const since = formatDate(view.authorizedAt);
    const status = view.needsReauth
      ? `<div class="status warn"><span class="dot"></span><span>${name} refused your last sign-in. Connect your account again.</span></div>`
      : view.connected
        ? `<div class="status ok"><span class="dot"></span><span>Your account is connected${since ? ` since ${escapeHtml(since)}` : ''}. Calls to ${name} use your own sign-in.</span></div>`
        : `<div class="status"><span class="dot"></span><span>Not connected yet. Calls to ${name} need your own sign-in.</span></div>`;
    const done = input.justConnected
      ? `<div class="done" role="status">Connected. You can close this page and go back to your chat.</div>`
      : '';
    const label = view.connected || view.needsReauth ? 'Connect again' : 'Connect my account';
    const switchForm = view.canSwitch
      ? `<form class="inline" method="post" action="${action}">${csrf}<button type="submit" name="action" value="switch">Not you?</button></form>`
      : '';
    card = `${pair(view.connectorName)}
    <h1>Connect your own account to ${name}</h1>
    <p class="sub">${name} then answers with what your own account may see and do, nothing more.</p>
    <div class="acct"><span>Signed in as <strong>${escapeHtml(view.email)}</strong></span>${switchForm}</div>
    ${done}${error}${status}
    <form method="post" action="${action}">${csrf}
      <button type="submit" name="action" value="connect"${view.connected && !view.needsReauth ? ' class="secondary"' : ''}>${label}</button>
    </form>
    <p class="note">You sign in at ${name}. AnythingMCP stores the token encrypted and uses it only for your own calls.</p>`;
  }

  return renderAuthPage({ title, card, trust: input.trust, extraStyles: EXTRA_STYLES });
}
