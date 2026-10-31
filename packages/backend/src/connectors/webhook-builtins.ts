import { slugifyForPrefix } from './graphql-builtins';

/**
 * The one tool a webhook-enabled connector ships with: reading the events
 * stored by webhook-ingest.controller.ts. Executed through the
 * `webhook_recent_events` special case in dynamic-mcp-tools.ts, not any
 * engine — there is no outbound call, only a read of our own storage.
 */
export interface WebhookBuiltinTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  endpointMapping: Record<string, unknown>;
}

export function wantsWebhookBuiltins(webhookEnabled: unknown): boolean {
  return webhookEnabled === true;
}

export function webhookToolPrefix(opts: { toolPrefix?: unknown; name: string }): string {
  const own = typeof opts.toolPrefix === 'string' ? opts.toolPrefix.trim() : '';
  if (own && /^[a-z][a-z0-9_]{0,39}$/.test(own)) return own;
  return slugifyForPrefix(opts.name).slice(0, 40).replace(/_+$/, '');
}

export function buildWebhookBuiltinTools(opts: {
  prefix: string;
  displayName: string;
}): WebhookBuiltinTool[] {
  const { prefix, displayName } = opts;
  return [
    {
      name: `${prefix}_recent_events`,
      description:
        `Recently received webhook deliveries for the ${displayName} connector, newest first. ` +
        'Each event was verified (signature checked) before being stored; nothing unverified ever lands here. ' +
        'Use since to page past events you already read.',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'integer',
            description: 'Events to return, default 20, at most 200.',
          },
          since: {
            type: 'string',
            description: 'ISO 8601 timestamp; only events received at or after this time.',
          },
        },
      },
      endpointMapping: { method: 'webhook_recent_events', path: '' },
    },
  ];
}
