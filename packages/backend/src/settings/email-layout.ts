import type { TrustStatsDisplay } from '../public-stats/trust-stats.format';

/**
 * The one layout every AnythingMCP email is rendered with: table layout and
 * inline styles (Gmail and Outlook ignore most of <style>), 600px wide, one
 * blue call to action, a trust band and a footer. No web fonts (privacy and
 * deliverability): Georgia for headings, the system sans for text. Images are
 * hosted PNGs with width, height and alt; Gmail and Outlook do not render SVG.
 *
 * The marketing site renders its own emails with the same design, so the two
 * look alike in an inbox.
 */

export const EMAIL_COLORS = {
  paper: '#f6f4ef',
  card: '#ffffff',
  border: '#e7e3d9',
  ink: '#1a1815',
  muted: '#6b665c',
  blue: '#2159e0',
  tint: '#eef2fd',
  star: '#e3a008',
} as const;

const C = EMAIL_COLORS;
const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

export const DEFAULT_EMAIL_ASSET_BASE = 'https://anythingmcp.com/email';
const MARKETING = 'https://anythingmcp.com';
export const CLAUDE_DIRECTORY_URL = 'https://claude.ai/directory/anythingmcp';
export const GITHUB_URL = 'https://github.com/HelpCode-ai/anythingmcp';

/** Escape a value for HTML text and attribute positions. Use on everything a user or an operator chose. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Context shared by every email: the trust numbers and which claims hold for this deployment. */
export interface EmailBrandContext {
  stats: TrustStatsDisplay;
  /** AnythingMCP Cloud: Frankfurt hosting, DPA, the Claude Directory listing and the workspace count apply. */
  cloud: boolean;
  /** Where the logo PNGs live. Overridden only for local previews. */
  assetBase?: string;
}

export interface MarketingFooter {
  /** Opens the one-click unsubscribe page (or, without one, the account settings). */
  unsubscribeUrl: string;
}

// ── Building blocks for email bodies ────────────────────────────────────────

/** Serif heading; `emphasis` is the clause set in italic blue. Both are HTML (escape inputs first). */
export function h1(lead: string, emphasis?: string): string {
  const em = emphasis
    ? ` <em style="font-style:italic;color:${C.blue};">${emphasis}</em>`
    : '';
  return `<h1 class="h1" style="margin:0 0 16px 0;font-family:${SERIF};font-weight:normal;font-size:30px;line-height:1.2;letter-spacing:-0.01em;color:${C.ink};">${lead}${em}</h1>`;
}

export function p(html: string, opts: { size?: number; muted?: boolean; mb?: number } = {}): string {
  const size = opts.size ?? 16;
  const color = opts.muted ? C.muted : C.ink;
  const mb = opts.mb ?? 16;
  return `<p style="margin:0 0 ${mb}px 0;font-family:${SANS};font-size:${size}px;line-height:1.6;color:${color};">${html}</p>`;
}

/** Small muted closing line. */
export function small(html: string, mb = 0): string {
  return p(html, { size: 13, muted: true, mb });
}

/** Inline text link. `href` is escaped here; `label` is HTML. */
export function link(href: string, label: string): string {
  return `<a href="${esc(href)}" style="color:${C.blue};text-decoration:underline;">${label}</a>`;
}

/** The one call to action. `href` is escaped here; `label` is plain text. */
export function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 14px 0;"><tr>
<td style="background:${C.blue};border-radius:8px;">
<a href="${esc(href)}" style="display:inline-block;padding:14px 26px;font-family:${SANS};font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${esc(label)} &rarr;</a>
</td></tr></table>`;
}

/** A code (verification code, licence key, promotion code) in a tinted box. Plain text in. */
export function codeBox(code: string, opts: { size?: number; spacing?: number } = {}): string {
  const size = opts.size ?? 34;
  const spacing = opts.spacing ?? 10;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 20px 0;"><tr>
<td align="center" style="background:${C.paper};border:1px solid ${C.border};border-radius:12px;padding:22px;">
<span style="font-family:${MONO};font-size:${size}px;font-weight:600;letter-spacing:${spacing}px;color:${C.ink};word-break:break-all;">${esc(code)}</span>
</td></tr></table>`;
}

/** Numbered steps. `title` and `detail` are HTML. */
export function steps(items: Array<{ title: string; detail: string }>): string {
  const rows = items
    .map(
      (s, i) => `<tr>
<td width="36" style="vertical-align:top;padding:0 0 16px 0;"><div style="width:26px;height:26px;border-radius:999px;background:${C.tint};color:${C.blue};font-family:${SANS};font-size:13px;font-weight:600;text-align:center;line-height:26px;">${i + 1}</div></td>
<td style="vertical-align:top;padding:2px 0 16px 0;font-family:${SANS};font-size:15px;line-height:1.5;color:${C.ink};"><strong style="font-weight:600;">${s.title}</strong><br><span style="color:${C.muted};">${s.detail}</span></td></tr>`,
    )
    .join('\n');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 12px 0;">\n${rows}\n</table>`;
}

/** The user's own numbers (connectors, tool calls) side by side. */
export function usageBox(items: Array<{ value: string; label: string }>): string {
  const width = Math.floor(100 / Math.max(1, items.length));
  const cells = items
    .map(
      (u) => `<td width="${width}%" style="padding:16px;text-align:center;vertical-align:top;">
<div style="font-family:${SERIF};font-size:28px;color:${C.ink};line-height:1.2;">${esc(u.value)}</div>
<div style="font-family:${SANS};font-size:13px;color:${C.muted};line-height:1.4;">${esc(u.label)}</div></td>`,
    )
    .join('\n');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.paper};border:1px solid ${C.border};border-radius:12px;margin:4px 0 20px 0;"><tr>
${cells}
</tr></table>`;
}

/** Monospace inline code, e.g. an endpoint URL. Plain text in. */
export function code(text: string): string {
  return `<code style="font-family:${MONO};font-size:13px;background:${C.paper};border:1px solid ${C.border};border-radius:4px;padding:1px 5px;white-space:nowrap;">${esc(text)}</code>`;
}

// ── The frame ───────────────────────────────────────────────────────────────

function head(title: string, preheader: string): string {
  // The padding after the preheader keeps the first lines of the body out of
  // the inbox preview.
  const pad = '&#847;&zwnj;&nbsp;'.repeat(30);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>${esc(title)}</title>
<style>
@media (max-width:480px){
  .card{padding:28px 22px 26px 22px !important}
  .h1{font-size:25px !important}
  .stat-n{font-size:19px !important}
  .stat-l{font-size:11px !important}
}
</style>
</head>
<body style="margin:0;padding:0;background:${C.paper};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${esc(preheader)}${pad}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.paper};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;">
`;
}

function header(assetBase: string): string {
  return `<tr><td style="padding:0 4px 20px 4px;">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td style="vertical-align:middle;"><img src="${esc(assetBase)}/amcp-mark.png" width="30" height="30" alt="AnythingMCP" style="display:block;border:0;"></td>
    <td style="vertical-align:middle;padding-left:10px;font-family:${SANS};font-size:18px;font-weight:600;letter-spacing:-0.01em;color:${C.ink};">Anything<span style="color:${C.blue};">MCP</span></td>
  </tr></table>
</td></tr>
`;
}

function card(inner: string): string {
  return `<tr><td class="card" style="background:${C.card};border:1px solid ${C.border};border-radius:14px;padding:40px 40px 36px 40px;">
${inner}
</td></tr>
`;
}

const pill = (html: string, bg = '#ffffff') =>
  `<span style="display:inline-block;border:1px solid ${C.border};border-radius:999px;padding:5px 12px;margin:3px;font-family:${SANS};font-size:12px;line-height:1.5;color:${C.ink};background:${bg};white-space:nowrap;">${html}</span>`;

const CLIENTS: Array<{ file: string; alt: string; label: string }> = [
  { file: 'claude', alt: 'Claude', label: 'Claude' },
  { file: 'chatgpt', alt: 'ChatGPT', label: 'ChatGPT' },
  { file: 'copilot', alt: 'Copilot', label: 'Copilot' },
  { file: 'cursor', alt: 'Cursor', label: 'Cursor' },
  { file: 'muse', alt: 'Meta Muse', label: 'Muse' },
];

function trustBand(ctx: EmailBrandContext, assetBase: string): string {
  const { stats, cloud } = ctx;
  const tiles: Array<{ big: string; small: string }> = [];
  if (stats.stars) {
    tiles.push({ big: `<span style="color:${C.star};">&#9733;</span> ${esc(stats.stars)}`, small: 'stars on GitHub' });
  }
  if (stats.downloads) tiles.push({ big: esc(stats.downloads), small: 'downloads' });
  // The tool-call count is AnythingMCP Cloud's. A self-hosted instance only
  // knows its own, which would read as if it were everyone's.
  if (cloud && stats.toolCalls) tiles.push({ big: esc(stats.toolCalls), small: 'AI tool calls last month' });
  const width = tiles.length ? Math.floor(100 / tiles.length) : 100;
  const statRow = tiles.length
    ? `<tr><td style="padding:0 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
${tiles
  .map(
    (t) => `<td width="${width}%" style="padding:14px 8px;text-align:center;vertical-align:top;">
<div class="stat-n" style="font-family:${SERIF};font-size:24px;color:${C.ink};line-height:1.1;">${t.big}</div>
<div class="stat-l" style="font-family:${SANS};font-size:12px;color:${C.muted};line-height:1.4;padding-top:4px;">${t.small}</div></td>`,
  )
  .join('\n')}
</tr></table></td></tr>`
    : '';
  const workspaces =
    cloud && stats.workspaces
      ? `<tr><td style="padding:0 16px 6px 16px;text-align:center;font-family:${SANS};font-size:12px;color:${C.muted};"><span style="color:${C.ink};font-weight:600;">${esc(stats.workspaces)}</span> workspaces on AnythingMCP Cloud</td></tr>`
      : '';
  const directory = cloud
    ? `<a href="${CLAUDE_DIRECTORY_URL}" style="text-decoration:none;color:${C.ink};">${pill(
        `<img src="${esc(assetBase)}/claude.png" width="12" height="12" alt="" style="vertical-align:-2px;border:0;"> Listed in the Claude Directory`,
        '#fffaf5',
      )}</a>`
    : '';
  const badges =
    directory +
    (cloud ? pill('EU-hosted &middot; Frankfurt') + pill('GDPR &middot; DPA included') : '') +
    pill('AES-256-GCM') +
    pill('Open source &middot; AGPL-3.0');
  const works = CLIENTS.map(
    (c) =>
      `<span style="white-space:nowrap;"><img src="${esc(assetBase)}/${c.file}.png" width="16" height="16" alt="${c.alt}" style="vertical-align:-3px;border:0;">&nbsp;<span style="font-family:${SANS};font-size:12px;color:${C.ink};">${c.label}</span></span>`,
  ).join('&nbsp;&nbsp;\n');
  return `<tr><td style="padding:28px 0 0 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid ${C.border};border-radius:14px;">
<tr><td style="padding:20px 24px 4px 24px;font-family:${SANS};font-size:13px;font-weight:600;color:${C.muted};text-align:center;">Why teams build on AnythingMCP</td></tr>
${statRow}
${workspaces}
<tr><td style="padding:4px 16px 12px 16px;text-align:center;line-height:2.4;">
${badges}
</td></tr>
<tr><td align="center" style="padding:12px 16px 18px 16px;border-top:1px solid ${C.border};text-align:center;line-height:2;">
<span style="font-family:${SANS};font-size:12px;color:${C.muted};">Works with&nbsp;&nbsp;</span>
${works}
</td></tr>
</table>
</td></tr>
`;
}

function footer(marketing: MarketingFooter | false): string {
  const a = (href: string, label: string) =>
    `<a href="${href}" style="color:${C.ink};text-decoration:none;font-weight:500;">${label}</a>`;
  const unsub = marketing
    ? `<br><a href="${esc(marketing.unsubscribeUrl)}" style="color:${C.muted};text-decoration:underline;">Unsubscribe from tips and offers</a>`
    : '';
  return `<tr><td style="padding:24px 8px 0 8px;font-family:${SANS};font-size:12px;line-height:1.7;color:${C.muted};text-align:center;">
${a(`${MARKETING}/guides`, 'Guides')} &nbsp;&middot;&nbsp;
${a(`${MARKETING}/docs`, 'Help')} &nbsp;&middot;&nbsp;
${a(GITHUB_URL, '&#9733; Star on GitHub')} &nbsp;&middot;&nbsp;
${a(`${MARKETING}/datenschutz`, 'Privacy')}<br><br>
AnythingMCP is made by helpcode.ai GmbH &middot; Hanferstra&szlig;e 26 &middot; 79108 Freiburg, Germany${unsub}
</td></tr>
`;
}

const TAIL = '</table></td></tr></table></body></html>\n';

export interface RenderEmailInput {
  /** Inbox preview line. Plain text. */
  preheader: string;
  /** Document title. Plain text. */
  title: string;
  /** The card's content, built from the helpers above with every input escaped. */
  bodyHtml: string;
  /** Marketing and lifecycle nudges carry an unsubscribe line; transactional mail does not. */
  marketing: MarketingFooter | false;
  ctx: EmailBrandContext;
}

export function renderEmail(input: RenderEmailInput): string {
  const assetBase = (input.ctx.assetBase || DEFAULT_EMAIL_ASSET_BASE).replace(/\/+$/, '');
  return (
    head(input.title, input.preheader) +
    header(assetBase) +
    card(input.bodyHtml) +
    trustBand(input.ctx, assetBase) +
    footer(input.marketing) +
    TAIL
  );
}

/**
 * The text part: the email's own text, then the same trust line and footer as
 * the HTML. `bodyText` is plain text and is not escaped.
 */
export function renderEmailText(input: {
  bodyText: string;
  marketing: MarketingFooter | false;
  ctx: EmailBrandContext;
}): string {
  const { stats, cloud } = input.ctx;
  const numbers = [
    stats.stars ? `${stats.stars} stars on GitHub` : null,
    stats.downloads ? `${stats.downloads} downloads` : null,
    cloud && stats.toolCalls ? `${stats.toolCalls} AI tool calls last month` : null,
    cloud && stats.workspaces ? `${stats.workspaces} workspaces on AnythingMCP Cloud` : null,
  ].filter(Boolean);
  const badges = [
    cloud ? 'Listed in the Claude Directory' : null,
    cloud ? 'EU-hosted, Frankfurt' : null,
    cloud ? 'GDPR, DPA included' : null,
    'AES-256-GCM',
    'Open source, AGPL-3.0',
  ].filter(Boolean);
  const lines = [
    input.bodyText.trim(),
    '',
    '--',
    numbers.length ? `AnythingMCP: ${numbers.join(' · ')}` : 'AnythingMCP',
    badges.join(' · '),
    'Works with Claude, ChatGPT, Copilot, Cursor and Meta Muse.',
    '',
    `Guides: ${MARKETING}/guides`,
    `Help: ${MARKETING}/docs`,
    `GitHub: ${GITHUB_URL}`,
    `Privacy: ${MARKETING}/datenschutz`,
    '',
    'AnythingMCP is made by helpcode.ai GmbH · Hanferstraße 26 · 79108 Freiburg, Germany',
  ];
  if (input.marketing) lines.push('', `Unsubscribe from tips and offers: ${input.marketing.unsubscribeUrl}`);
  return lines.join('\n') + '\n';
}
