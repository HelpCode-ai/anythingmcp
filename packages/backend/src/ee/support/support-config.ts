/**
 * Environment for the support desk (a Libredesk instance operated by us).
 *
 * Two independent parts, each enabled by its own variables:
 * - the chat widget (SUPPORT_CHAT_*): set on every instance we host, Cloud
 *   and the dedicated instances of enterprise customers;
 * - the triage webhook (LIBREDESK_*): set on one instance only (Cloud), which
 *   receives every new conversation and tags, prioritises and annotates it.
 *
 * Self-hosted installations set none of these, so the module is not loaded.
 */

export interface SupportChatConfig {
  /** Libredesk root URL, e.g. https://support.anythingmcp.com */
  baseUrl: string;
  /** UUID of the live chat inbox. */
  inboxId: string;
  /** The inbox's identity-verification secret (HS256 key for the user JWT). */
  secret: string;
}

export interface SupportTriageConfig {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  webhookSecret: string;
}

const trimUrl = (v: string | undefined) => (v || '').trim().replace(/\/+$/, '');

export function supportChatConfig(env: NodeJS.ProcessEnv = process.env): SupportChatConfig | null {
  const baseUrl = trimUrl(env.SUPPORT_CHAT_URL);
  const inboxId = (env.SUPPORT_CHAT_INBOX_ID || '').trim();
  const secret = (env.SUPPORT_CHAT_SECRET || '').trim();
  if (!baseUrl || !inboxId || !secret) return null;
  return { baseUrl, inboxId, secret };
}

export function supportTriageConfig(env: NodeJS.ProcessEnv = process.env): SupportTriageConfig | null {
  const baseUrl = trimUrl(env.LIBREDESK_API_URL || env.SUPPORT_CHAT_URL);
  const apiKey = (env.LIBREDESK_API_KEY || '').trim();
  const apiSecret = (env.LIBREDESK_API_SECRET || '').trim();
  const webhookSecret = (env.LIBREDESK_WEBHOOK_SECRET || '').trim();
  if (!baseUrl || !apiKey || !apiSecret || !webhookSecret) return null;
  return { baseUrl, apiKey, apiSecret, webhookSecret };
}

export function supportModuleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return supportChatConfig(env) !== null || supportTriageConfig(env) !== null;
}

/** Host name of this instance, used to tell instances apart in the desk. */
export function instanceHost(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.FRONTEND_URL || env.SERVER_URL || '';
  try {
    return new URL(raw).host || 'unknown';
  } catch {
    return 'unknown';
  }
}
