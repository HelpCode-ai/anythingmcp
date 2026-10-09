/**
 * The frame shared by the server-rendered pages of the MCP authorization flow
 * (sign-in and consent, server picker, first-connector offer, cancelled) and
 * the unsubscribe page: same card, same colours as the dashboard, and a trust
 * row under the card. No external resources: logos are inline SVG, fonts are
 * the system's.
 */

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

export const AMCP_MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 52" width="32" height="32" fill="none" aria-hidden="true">' +
  '<g stroke="#2563eb" stroke-width="1.5" stroke-linecap="round" opacity=".55"><line x1="26" y1="26" x2="26" y2="9"/><line x1="26" y1="26" x2="10" y2="40"/><line x1="26" y1="26" x2="42" y2="40"/></g>' +
  '<g fill="#2563eb" opacity=".65"><circle cx="26" cy="9" r="5"/><circle cx="10" cy="40" r="5"/><circle cx="42" cy="40" r="5"/></g>' +
  '<circle cx="26" cy="26" r="10" fill="#2563eb"/><circle cx="26" cy="26" r="5.5" fill="#fff"/></svg>';

const CLAUDE_PATH =
  'm3.127 10.604 3.135-1.76.053-.153-.053-.085H6.11l-.525-.032-1.791-.048-1.554-.065-1.505-.08-.38-.081L0 7.832l.036-.234.32-.214.455.04 1.009.069 1.513.105 1.097.064 1.626.17h.259l.036-.105-.089-.065-.068-.064-1.566-1.062-1.695-1.121-.887-.646-.48-.327-.243-.306-.104-.67.435-.48.585.04.15.04.593.456 1.267.981 1.654 1.218.242.202.097-.068.012-.049-.109-.181-.9-1.626-.96-1.655-.428-.686-.113-.411a2 2 0 0 1-.068-.484l.496-.674L4.446 0l.662.089.279.242.411.94.666 1.48 1.033 2.014.302.597.162.553.06.17h.105v-.097l.085-1.134.157-1.392.154-1.792.052-.504.25-.605.497-.327.387.186.319.456-.045.294-.19 1.23-.37 1.93-.243 1.29h.142l.161-.16.654-.868 1.097-1.372.484-.545.565-.601.363-.287h.686l.505.751-.226.775-.707.895-.585.759-.839 1.13-.524.904.048.072.125-.012 1.897-.403 1.024-.186 1.223-.21.553.258.06.263-.218.536-1.307.323-1.533.307-2.284.54-.028.02.032.04 1.029.098.44.024h1.077l2.005.15.525.346.315.424-.053.323-.807.411-3.631-.863-.872-.218h-.12v.073l.726.71 1.331 1.202 1.667 1.55.084.383-.214.302-.226-.032-1.464-1.101-.565-.497-1.28-1.077h-.084v.113l.295.432 1.557 2.34.08.718-.112.234-.404.141-.444-.08-.911-1.28-.94-1.44-.759-1.291-.093.053-.448 4.821-.21.246-.484.186-.403-.307-.214-.496.214-.98.258-1.28.21-1.016.19-1.263.112-.42-.008-.028-.092.012-.953 1.307-1.448 1.957-1.146 1.227-.274.109-.477-.247.045-.44.266-.39 1.586-2.018.956-1.25.617-.723-.004-.105h-.036l-4.212 2.736-.75.096-.324-.302.04-.496.154-.162 1.267-.871z';

const CHATGPT_PATH =
  'M14.949 6.547a3.94 3.94 0 0 0-.348-3.273 4.11 4.11 0 0 0-4.4-1.934A4.1 4.1 0 0 0 8.423.2 4.15 4.15 0 0 0 6.305.086a4.1 4.1 0 0 0-1.891.948 4.04 4.04 0 0 0-1.158 1.753 4.1 4.1 0 0 0-1.563.679A4 4 0 0 0 .554 4.72a3.99 3.99 0 0 0 .502 4.731 3.94 3.94 0 0 0 .346 3.274 4.11 4.11 0 0 0 4.402 1.933c.382.425.852.764 1.377.995.526.231 1.095.35 1.67.346 1.78.002 3.358-1.132 3.901-2.804a4.1 4.1 0 0 0 1.563-.68 4 4 0 0 0 1.14-1.253 3.990 3.990 0 0 0-.506-4.716m-6.097 8.406a3.05 3.05 0 0 1-1.945-.694l.096-.054 3.23-1.838a.53.53 0 0 0 .265-.455v-4.49l1.366.778q.02.011.025.035v3.722c-.003 1.653-1.361 2.992-3.037 2.996m-6.53-2.75a2.95 2.95 0 0 1-.36-2.01l.095.057L5.29 12.09a.53.53 0 0 0 .527 0l3.949-2.246v1.555a.05.05 0 0 1-.022.041L6.473 13.3c-1.454.826-3.311.335-4.15-1.098m-.85-6.94A3.020 3.020 0 0 1 3.07 3.949v3.785a.51.51 0 0 0 .262.451l3.93 2.237-1.366.779a.05.05 0 0 1-.048 0L2.585 9.342a2.98 2.98 0 0 1-1.113-4.094zm11.216 2.571L8.747 5.576l1.362-.776a.05.05 0 0 1 .048 0l3.265 1.86a3 3 0 0 1 1.173 1.207 2.96 2.96 0 0 1-.27 3.2 3.05 3.05 0 0 1-1.36.997V8.279a.52.52 0 0 0-.276-.445m1.36-2.015-.097-.057-3.226-1.855a.53.53 0 0 0-.53 0L6.249 6.153V4.598a.04.04 0 0 1 .019-.04L9.533 2.7a3.07 3.07 0 0 1 3.257.139c.474.325.843.778 1.066 1.303.223.526.289 1.103.191 1.664zM5.503 8.575 4.139 7.8a.05.05 0 0 1-.026-.037V4.049c0-.57.166-1.127.476-1.607s.752-.864 1.275-1.105a3.08 3.08 0 0 1 3.234.41l-.096.054-3.23 1.838a.53.53 0 0 0-.265.455zm.742-1.577 1.758-1 1.762 1v2l-1.755 1-1.762-1z';

const svg16 = (path: string, fill: string, size: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="${size}" height="${size}" fill="${fill}" aria-hidden="true"><path d="${path}"/></svg>`;

export const claudeMark = (size = 28) => svg16(CLAUDE_PATH, '#D97757', size);
const chatgptMark = (size = 28) => svg16(CHATGPT_PATH, '#10A37F', size);

const LOCK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

export type KnownClient = 'claude' | 'chatgpt' | null;

const hostMatches = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/**
 * Which well-known AI client this authorization goes back to, judged ONLY by
 * where the code is sent (the redirect host): the client's self-registered
 * name proves nothing. A code sent to claude.ai can only be used by Claude.
 */
export function knownClientFor(redirectHost: string): KnownClient {
  const host = (redirectHost || '').toLowerCase().replace(/:\d+$/, '');
  if (hostMatches(host, 'claude.ai') || hostMatches(host, 'claude.com')) return 'claude';
  if (hostMatches(host, 'chatgpt.com') || hostMatches(host, 'openai.com')) return 'chatgpt';
  return null;
}

/**
 * The AI client named on the sign-up link from this page, for the Claude
 * Directory badge: it is left out only for ChatGPT and Meta's Muse, and shown
 * to everyone else. Muse is not recognised by host yet (no Muse client has
 * registered with us), so a client called "Muse" or one on Meta's domains
 * counts too. Only a badge depends on it, so a self-declared name is enough.
 */
export type SignupClient = 'claude' | 'chatgpt' | 'muse' | 'other';

/** Meta's domains, where Muse's redirect is expected (none seen in production yet). */
const MUSE_DOMAINS = ['muse.ai', 'meta.ai', 'meta.com'];

/** Whether a redirect host is on one of Meta's domains. */
export function isMuseHost(redirectHost: string): boolean {
  const host = (redirectHost || '').toLowerCase().replace(/:\d+$/, '');
  return MUSE_DOMAINS.some((d) => hostMatches(host, d));
}

export function signupClientFor(clientName: string, redirectHost: string): SignupClient {
  const known = knownClientFor(redirectHost);
  if (known) return known;
  if (isMuseHost(redirectHost) || /\bmuse\b/i.test(clientName || '')) {
    return 'muse';
  }
  return 'other';
}

/** Whether the Claude Directory badge is shown to someone connecting this client. */
export const showsDirectoryBadge = (client: SignupClient) => client !== 'chatgpt' && client !== 'muse';

/** The two tiles at the top of the card: the client, dots, AnythingMCP. */
export function clientTilePair(clientName: string, redirectHost: string): string {
  const known = knownClientFor(redirectHost);
  const initial = (clientName || '?').trim().charAt(0).toUpperCase() || '?';
  const client =
    known === 'claude'
      ? `<div class="tile tile-claude" title="Claude">${claudeMark(28)}</div>`
      : known === 'chatgpt'
        ? `<div class="tile" title="ChatGPT">${chatgptMark(28)}</div>`
        : `<div class="tile tile-initial" aria-hidden="true">${escapeHtml(initial)}</div>`;
  return `<div class="pair">${client}<div class="dots" aria-hidden="true"><i></i><i></i><i></i></div><div class="tile" title="AnythingMCP">${AMCP_MARK_SVG}</div></div>`;
}

export interface TrustRowOptions {
  /** Cloud-only claims (Frankfurt, DPA) are shown only on AnythingMCP Cloud. */
  cloud: boolean;
  /** GitHub stars, formatted ("984", "1,100+"), or null when unknown. */
  stars: string | null;
}

export function trustRow(opts: TrustRowOptions): string {
  const items = [
    `<span>${LOCK_SVG} AES-256-GCM encryption</span>`,
    ...(opts.cloud ? ['<span>&#127466;&#127482; Hosted in Frankfurt</span>', '<span>GDPR &middot; DPA</span>'] : []),
    '<span>Every call in your audit log</span>',
    opts.stars
      ? `<span class="gh"><span class="star">&#9733;</span> ${escapeHtml(opts.stars)} on GitHub &middot; open source</span>`
      : '<span class="gh">Open source on GitHub</span>',
  ];
  return `<div class="trust">${items.join('')}</div>
  <div class="foot">AnythingMCP by helpcode.ai GmbH, Freiburg, Germany</div>`;
}

const STYLES = `
  :root { --bg:#f5f6f9; --surface:#fff; --surface-2:#f2f4f7; --border:#e7e9ef; --border-strong:#d6dae3;
          --text:#0f1219; --text-2:#565d70; --text-3:#8a91a3; --brand:#2563eb; --brand-strong:#1d4ed8;
          --tint:#edf2ff; --ok:#16a34a; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
         background: var(--bg); color: var(--text); min-height: 100vh; display: flex; flex-direction: column;
         align-items: center; justify-content: center; padding: 40px 16px; -webkit-font-smoothing: antialiased; }
  .card { width: 100%; max-width: 440px; background: var(--surface); border: 1px solid var(--border);
          border-radius: 16px; padding: 32px; box-shadow: 0 8px 30px rgba(16,24,40,.06); }
  .pair { display: flex; align-items: center; justify-content: center; gap: 14px; margin-bottom: 22px; }
  .tile { width: 56px; height: 56px; border-radius: 14px; border: 1px solid var(--border); display: flex;
          align-items: center; justify-content: center; background: #fff; flex: none; }
  .tile-claude { background: #fdf3ee; border-color: #f3d9cc; }
  .tile-initial { background: var(--surface-2); color: var(--text-2); font-size: 24px; font-weight: 600; }
  .dots { display: flex; gap: 4px; } .dots i { width: 5px; height: 5px; border-radius: 50%; background: #c7cdd9; }
  .dots i:nth-child(2) { background: var(--brand); }
  h1 { font-size: 21px; line-height: 1.3; text-align: center; margin: 0 0 6px; letter-spacing: -.01em; overflow-wrap: anywhere; }
  .sub { text-align: center; color: var(--text-2); font-size: 14px; margin: 0 0 22px; line-height: 1.5; }
  .verified { display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 12.5px; color: #9a3412;
              background: #fff7ed; border: 1px solid #fed7aa; border-radius: 999px; padding: 6px 12px;
              width: max-content; max-width: 100%; margin: -8px auto 20px; text-decoration: none; }
  .verified svg { flex: none; }
  .consent { border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-bottom: 16px; }
  .consent h2 { margin: 0 0 10px; font-size: 13px; color: var(--text-2); font-weight: 500; overflow-wrap: anywhere; }
  .row { display: flex; gap: 10px; font-size: 14px; margin: 8px 0; line-height: 1.45; }
  .row b { font-weight: 600; overflow-wrap: anywhere; }
  .row .ok { color: var(--ok); font-weight: 700; flex: none; width: 14px; }
  .row .no { color: var(--text-3); font-weight: 700; flex: none; width: 14px; }
  .row.muted { color: var(--text-2); }
  .returns { font-size: 12.5px; color: var(--text-3); margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); line-height: 1.5; }
  .host { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; font-weight: 600;
          color: var(--text); background: var(--bg); border-radius: 6px; padding: 2px 6px; overflow-wrap: anywhere; }
  .returns.unknown .host { color: #b45309; background: #fffbeb; }
  .warn { margin: 8px 0 0; font-size: 12.5px; color: var(--text-2); }
  .returns.unknown .warn { color: #92400e; }
  .acct { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px;
          color: var(--text-2); margin: 2px 0 18px; }
  .acct strong { color: var(--text); font-weight: 600; overflow-wrap: anywhere; }
  .acct a { color: var(--brand); text-decoration: none; font-weight: 500; white-space: nowrap; }
  .acct a:hover { text-decoration: underline; }
  .btns { display: grid; grid-template-columns: 1fr 1.4fr; gap: 10px; }
  /* Allow comes first in the markup (Enter in a field submits the first
     button), Cancel is placed on the left. */
  .btns .secondary { order: -1; }
  button, .btn, a.button { font: inherit; min-height: 46px; border-radius: 10px; font-weight: 600; font-size: 15px; cursor: pointer;
                 border: 1px solid var(--brand); background: var(--brand); color: #fff; width: 100%; padding: 0 14px;
                 display: inline-flex; align-items: center; justify-content: center; text-decoration: none; transition: background .15s; }
  button:hover, .btn:hover, a.button:hover { background: var(--brand-strong); }
  button.secondary, .btn.secondary { background: #fff; color: var(--text); border-color: var(--border); }
  button.secondary:hover, .btn.secondary:hover { background: var(--surface-2); }
  button.sso { background: #fff; color: var(--text); border-color: var(--border-strong); gap: 10px; margin-bottom: 8px; font-weight: 500; }
  button.sso:hover { background: var(--surface-2); }
  .sso-mark { display: inline-flex; flex: none; width: 18px; height: 18px; } .sso-mark svg { width: 100%; height: 100%; }
  label { display: block; font-size: 13px; font-weight: 500; margin: 0 0 6px; }
  input[type="email"], input[type="password"] { width: 100%; height: 42px; border: 1px solid var(--border);
          border-radius: 9px; padding: 0 12px; font: inherit; font-size: 15px; margin-bottom: 14px; background: #fff; color: var(--text); }
  input:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px rgba(37,99,235,.16); }
  .error { background: #fdecec; color: #c2282d; border: 1px solid #f8d0d0; border-radius: 9px; padding: 10px 12px;
           margin-bottom: 16px; font-size: 14px; line-height: 1.45; }
  .divider { display: flex; align-items: center; gap: 10px; margin: 14px 0; color: var(--text-3); font-size: 12px; }
  .divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: var(--border); }
  .signup { background: var(--tint); border: 1px solid #c9d8fb; border-radius: 12px; padding: 14px; margin-bottom: 4px; }
  .signup-lead { font-size: 14px; color: #334155; margin: 0 0 10px; line-height: 1.45; }
  .signup-btn { display: flex; align-items: center; justify-content: center; min-height: 46px; padding: 0 12px;
                background: #fff; color: var(--brand-strong); border: 1.5px solid var(--brand); border-radius: 10px;
                font-size: 15px; font-weight: 600; text-decoration: none; }
  .signup-btn:hover { background: #dbe6fe; }
  .links { text-align: center; margin: 14px 0 0; font-size: 13.5px; color: var(--text-2); }
  .links a { color: var(--brand); text-decoration: none; font-weight: 500; } .links a:hover { text-decoration: underline; }
  .note { font-size: 12.5px; color: var(--text-3); margin: 14px 0 0; text-align: center; line-height: 1.5; }
  .trust { max-width: 440px; width: 100%; margin-top: 18px; display: flex; flex-wrap: wrap; justify-content: center;
           gap: 8px 16px; font-size: 12px; color: var(--text-3); }
  .trust span { display: inline-flex; align-items: center; gap: 6px; }
  .trust .gh { color: var(--text-2); font-weight: 500; } .trust .star { color: #e3a008; }
  .foot { margin-top: 10px; font-size: 11.5px; color: var(--text-3); text-align: center; }
  @media (max-width: 480px) {
    body { padding: 16px 12px 24px; justify-content: flex-start; }
    .card { padding: 24px 18px; border-radius: 14px; }
    h1 { font-size: 19px; }
    .tile { width: 48px; height: 48px; border-radius: 12px; }
    .btns { grid-template-columns: 1fr; } .btns .secondary { order: 0; }
  }
`;

/** A whole page: the card, then the trust row. `card` is trusted HTML (escape inputs before). */
export function renderAuthPage(opts: {
  title: string;
  card: string;
  trust: TrustRowOptions;
  /** Page-specific CSS, appended to the shared rules. */
  extraStyles?: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta name="color-scheme" content="light">
  <title>${escapeHtml(opts.title)}</title>
  <style>${STYLES}${opts.extraStyles ?? ''}</style>
</head>
<body>
  <main class="card">${opts.card}
  </main>
  ${trustRow(opts.trust)}
</body>
</html>`;
}
