/**
 * One-click MCP install links for Cursor and VS Code.
 *
 * The in-app "Open in …" buttons use the editors' custom-scheme deep links;
 * the README badges use the https variants, because GitHub's Markdown
 * sanitizer (and most wikis) drop links that are not http(s). All builders
 * share the same config so a button and a badge always install the same thing.
 *
 * Docs:
 * - Cursor: https://cursor.com/docs/context/mcp/install-links
 * - VS Code: https://code.visualstudio.com/docs/copilot/customization/mcp-servers
 */

export interface McpInstallTarget {
  /** Server name shown in the editor (the server slug). */
  name: string;
  /** Streamable-HTTP MCP endpoint. */
  url: string;
}

// UTF-8 safe base64 (btoa alone throws on non-Latin-1 characters).
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary);
}

function cursorConfig({ url }: McpInstallTarget): string {
  return toBase64(JSON.stringify({ url }));
}

function vscodeConfig({ name, url }: McpInstallTarget): string {
  return JSON.stringify({ name, type: 'http', url });
}

export function cursorDeepLink(target: McpInstallTarget): string {
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(target.name)}&config=${cursorConfig(target)}`;
}

export function vscodeDeepLink(target: McpInstallTarget): string {
  return `vscode:mcp/install?${encodeURIComponent(vscodeConfig(target))}`;
}

// encodeURIComponent leaves ( ) ! * ' alone; a raw ")" would end a Markdown
// link early, so the https install URLs encode them too.
function encodeQueryValue(text: string): string {
  return encodeURIComponent(text).replace(/[()!*']/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function cursorInstallUrl(target: McpInstallTarget): string {
  return `https://cursor.com/en/install-mcp?name=${encodeQueryValue(target.name)}&config=${encodeQueryValue(cursorConfig(target))}`;
}

export function vscodeInstallUrl(target: McpInstallTarget): string {
  return `https://vscode.dev/redirect/mcp/install?name=${encodeQueryValue(target.name)}&config=${encodeQueryValue(vscodeConfig(target))}`;
}

// Remote badge images. Only ever placed in the copied snippet, never loaded
// by the app itself (self-hosted instances may run fully offline).
// Cursor documents an official button; VS Code does not, so it uses a
// shields.io static badge in the README's style. #0066CC keeps white text
// at 5.57:1 contrast (WCAG AA).
export const CURSOR_BADGE_IMAGE = 'https://cursor.com/deeplink/mcp-install-dark.svg';
export const VSCODE_BADGE_IMAGE =
  'https://img.shields.io/badge/VS_Code-Add_to_VS_Code-0066CC?logo=visualstudiocode&logoColor=white&labelColor=0b1220';

const CURSOR_ALT = 'Add to Cursor';
const VSCODE_ALT = 'Add to VS Code';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function installBadgesMarkdown(target: McpInstallTarget): string {
  return [
    `[![${CURSOR_ALT}](${CURSOR_BADGE_IMAGE})](${cursorInstallUrl(target)})`,
    `[![${VSCODE_ALT}](${VSCODE_BADGE_IMAGE})](${vscodeInstallUrl(target)})`,
  ].join(' ');
}

export function installBadgesHtml(target: McpInstallTarget): string {
  return [
    `<a href="${escapeHtml(cursorInstallUrl(target))}"><img src="${escapeHtml(CURSOR_BADGE_IMAGE)}" alt="${CURSOR_ALT}" height="32"></a>`,
    `<a href="${escapeHtml(vscodeInstallUrl(target))}"><img src="${escapeHtml(VSCODE_BADGE_IMAGE)}" alt="${VSCODE_ALT}" height="32"></a>`,
  ].join('\n');
}

/** True when the endpoint only resolves on the machine that serves it. */
export function isLocalOnlyUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
  } catch {
    return false;
  }
}
