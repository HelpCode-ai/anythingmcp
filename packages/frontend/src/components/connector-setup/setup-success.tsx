'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { connectors, mcpServers, productEvents } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Button, buttonVariants } from '@/components/ui/button';
import { ConnectorLogo } from '@/components/connector-logo';
import { copyText } from '@/lib/clipboard';
import { getApiOrigin } from '@/lib/origin';
import { CLAUDE_ADD_CONNECTOR_URL, CLAUDE_DIRECTORY_URL } from '@/lib/marketing';
import { vscodeDeepLink } from '@/lib/mcp-install-links';
import type { ReturnAssistant } from '@/lib/return-assistant';
import { cn } from '@/lib/utils';

type ClientTab = 'claude' | 'chatgpt' | 'copilot' | 'other';

const TABS: Array<{ id: ClientTab; label: string }> = [
  { id: 'claude', label: 'Claude' },
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'copilot', label: 'Copilot' },
  { id: 'other', label: 'Other' },
];

interface ServerInfo {
  id: string;
  name: string;
  slug: string;
  /** Calls in the last 30 days: some AI client already uses this server. */
  inUse: boolean;
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      className="flex-none"
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }
      }}
    >
      {copied ? 'Copied ✓' : label}
    </Button>
  );
}

/**
 * The end of a guided setup: the connector works, here is how to reach it
 * from an AI client (on the MCP server it was put on), and what to ask first.
 * The steps for each client are the ones of the MCP server page, shortened;
 * "Other" links there for the rest.
 */
export function SetupSuccess({
  name,
  icon,
  connectorId,
  verified,
  sample,
  examples,
  back,
}: {
  name: string;
  icon: string;
  connectorId: string;
  verified: boolean;
  sample?: string;
  examples: string[];
  back: ReturnAssistant | null;
}) {
  const { token, deploymentMode } = useAuth();
  const isCloud = deploymentMode === 'cloud';
  const [server, setServer] = useState<ServerInfo | null | undefined>(undefined);
  const [tab, setTab] = useState<ClientTab>('claude');
  const [showClients, setShowClients] = useState(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const c = await connectors.get(connectorId, token);
        const serverId: string | undefined = c?.mcpServers?.[0]?.mcpServerId;
        if (!serverId) {
          if (!cancelled) setServer(null);
          return;
        }
        const [s, activity] = await Promise.all([
          mcpServers.get(serverId, token),
          mcpServers.activity(serverId, token).catch(() => null),
        ]);
        if (!cancelled) {
          setServer({ id: serverId, name: s?.name ?? 'your MCP server', slug: s?.slug || 'anythingmcp', inUse: (activity?.calls30d ?? 0) > 0 });
        }
      } catch {
        if (!cancelled) setServer(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, connectorId]);

  const endpoint = server ? `${getApiOrigin()}/mcp/${server.id}` : '';
  const prompts = examples.length > 0 ? examples : [`What can you do with ${name}?`];
  const openTab = (id: ClientTab) => {
    setTab(id);
    if (token) productEvents.track('client_tab_opened', token, { client: id, via: 'setup' });
  };

  const endpointRow = (
    <div>
      <div className="mb-1 text-xs font-medium text-[var(--text-3)]">Your MCP server URL</div>
      <div className="flex items-start gap-2">
        <code className="flex-1 rounded-[8px] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 font-mono text-[12.5px] text-[var(--text)] [overflow-wrap:anywhere]">
          {endpoint}
        </code>
        <CopyButton text={endpoint} />
      </div>
    </div>
  );

  const external = (href: string, label: string) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants({ size: 'sm' }), 'gap-1.5')}>
      {label} <span aria-hidden>↗</span>
    </a>
  );

  const clientSteps = server && (
    <div className="space-y-3">
      <div role="tablist" aria-label="AI client" className="flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => openTab(t.id)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              tab === t.id
                ? 'border-[var(--brand)] bg-[var(--brand)] text-[var(--primary-foreground)]'
                : 'border-[var(--border)] text-[var(--text-2)] hover:border-[var(--border-strong)]',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="space-y-3 text-sm leading-relaxed text-[var(--text-2)]">
        {tab === 'claude' && (
          <>
            <ol className="list-decimal space-y-1 pl-5">
              <li>Click <strong>Add to Claude</strong>: Claude opens its <strong>Add custom connector</strong> dialog.</li>
              <li>Enter a name (e.g. AnythingMCP), paste the URL below and click <strong>Add</strong>.</li>
              <li>Click <strong>Connect</strong> and approve access.</li>
            </ol>
            {endpointRow}
            {external(CLAUDE_ADD_CONNECTOR_URL, 'Add to Claude')}
            <p className="text-xs text-[var(--text-3)]">
              Dialog not showing? In Claude open <strong>Customize → Connectors</strong>, click <strong>+</strong>, then{' '}
              <strong>Add custom connector</strong>.
              {isCloud && (
                <>
                  {' '}Or add AnythingMCP from the{' '}
                  <a href={CLAUDE_DIRECTORY_URL} target="_blank" rel="noopener noreferrer" className="underline">
                    Claude Directory
                  </a>{' '}
                  and pick this server when you sign in.
                </>
              )}
            </p>
          </>
        )}
        {tab === 'chatgpt' && (
          <>
            <ol className="list-decimal space-y-1 pl-5">
              <li>Open <strong>Plugins</strong> in ChatGPT, click <strong>+</strong>, then <strong>Add custom MCP server</strong>.</li>
              <li>Enter a name, paste the URL below as the <strong>Server URL</strong> and keep <strong>Authentication</strong> on <strong>OAuth</strong>.</li>
              <li>Select <strong>I understand and want to continue</strong>, then <strong>Create as a plugin</strong>, and sign in to AnythingMCP.</li>
              <li>Install the plugin from your personal plugins, then type <strong>@</strong> in a chat to use it.</li>
            </ol>
            {endpointRow}
            {external('https://chatgpt.com/plugins', 'Open ChatGPT Plugins')}
            <p className="text-xs text-[var(--text-3)]">Custom MCP servers need a paid ChatGPT plan. On a Business workspace only admins and owners can add them.</p>
          </>
        )}
        {tab === 'copilot' && (
          <>
            <p>
              Click below: VS Code opens and offers to install the server for GitHub Copilot. Approve the sign-in to AnythingMCP when it
              asks, then pick the tools in Copilot Chat → <strong>Tools</strong>.
            </p>
            <a href={vscodeDeepLink({ name: server.slug, url: endpoint })} className={cn(buttonVariants({ size: 'sm' }))}>
              Add to VS Code
            </a>
            <p className="text-xs text-[var(--text-3)]">
              Visual Studio, JetBrains, Eclipse or Xcode: see{' '}
              <Link href={`/mcp-server/${server.id}`} className="underline">
                the server page
              </Link>
              .
            </p>
          </>
        )}
        {tab === 'other' && (
          <>
            <p>Cursor, Claude Code, Claude Desktop, Gemini CLI, Meta Muse, Windsurf and others: the server page has the steps for each.</p>
            {endpointRow}
            <Link href={`/mcp-server/${server.id}`} className={cn(buttonVariants({ size: 'sm', variant: 'secondary' }))}>
              Open {server.name}
            </Link>
          </>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <ConnectorLogo icon={icon} name={name} />
        <div>
          <h1 className="text-lg font-semibold text-[var(--text)]">
            <span aria-hidden className="mr-1.5 text-[var(--t-success-fg)]">✓</span>
            {name} is connected
          </h1>
          <p className="text-sm text-[var(--text-2)]">
            {verified ? `AnythingMCP checked it with ${name}: it works.` : `Your AI can use ${name} now.`}
          </p>
        </div>
      </div>

      {back && (
        <div className="space-y-2">
          {back.href ? (
            <a href={back.href} className={cn(buttonVariants())}>
              Back to {back.name}
            </a>
          ) : (
            <p className="text-sm text-[var(--text-2)]">You can close this tab and return to {back.name}.</p>
          )}
        </div>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-[var(--text)]">Try asking</h2>
        <ul className="space-y-1.5">
          {prompts.map((p) => (
            <li key={p} className="flex items-center gap-2 rounded-[9px] bg-[var(--surface-2)] py-1.5 pl-3 pr-1.5 text-sm text-[var(--text)]">
              <span className="flex-1">“{p}”</span>
              <CopyButton text={p} />
            </li>
          ))}
        </ul>
      </section>

      {!back && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-[var(--text)]">Use it in your AI</h2>
          {server === undefined && <p className="text-sm text-[var(--text-3)]">Loading…</p>}
          {server === null && (
            <p className="text-sm text-[var(--text-2)]">
              Add the connector to an MCP server to reach it from an AI client:{' '}
              <Link href={`/connectors/${connectorId}`} className="underline">
                open the connector
              </Link>
              .
            </p>
          )}
          {server && server.inUse && !showClients && (
            <div className="space-y-1 rounded-[11px] border border-[var(--border)] p-3 text-sm text-[var(--text-2)]">
              <p>
                {name} is on <strong className="text-[var(--text)]">{server.name}</strong>, which your AI client already uses. Start a new chat
                and ask it something from the list above.
              </p>
              <button type="button" onClick={() => setShowClients(true)} className="text-xs underline hover:text-[var(--text)]">
                Connect another AI client
              </button>
            </div>
          )}
          {server && (!server.inUse || showClients) && clientSteps}
        </section>
      )}

      {sample && (
        <details>
          <summary className="cursor-pointer text-xs font-medium text-[var(--text-3)]">What {name} answered to the check</summary>
          <pre className="mt-2 max-h-48 overflow-auto rounded-[9px] bg-[var(--surface-2)] p-3 text-xs text-[var(--text)]">{sample}</pre>
        </details>
      )}

      <div className="flex flex-wrap gap-2 border-t border-[var(--border)] pt-4">
        <Link href={`/connectors/${connectorId}`} className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}>
          Open the connector
        </Link>
        <Link href="/connectors/store" className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}>
          Add another app
        </Link>
      </div>
    </div>
  );
}
