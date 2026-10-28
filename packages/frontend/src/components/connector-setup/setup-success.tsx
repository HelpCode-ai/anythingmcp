'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { connectors, mcpServers, productEvents, server as serverApi } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Button, buttonVariants } from '@/components/ui/button';
import { ConnectorLogo } from '@/components/connector-logo';
import { copyText } from '@/lib/clipboard';
import { getApiOrigin } from '@/lib/origin';
import { CLAUDE_ADD_CONNECTOR_URL, CLAUDE_DIRECTORY_URL } from '@/lib/marketing';
import { isLocalOnlyUrl, vscodeDeepLink } from '@/lib/mcp-install-links';
import type { ReturnAssistant } from '@/lib/return-assistant';
import { cn } from '@/lib/utils';

type ClientTab = 'claude' | 'chatgpt' | 'copilot' | 'other';

/** Product names stay as they are; "Other" is `setupSuccess.tabs.other`. */
const TABS: Array<{ id: ClientTab; label?: string }> = [
  { id: 'claude', label: 'Claude' },
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'copilot', label: 'Copilot' },
  { id: 'other' },
];

interface ServerInfo {
  id: string;
  name: string;
  slug: string;
  /** Calls in the last 30 days: some AI client already uses this server. */
  inUse: boolean;
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const t = useTranslations('setupSuccess');
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
      {copied ? t('copied') : (label ?? t('copy'))}
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
  const t = useTranslations('setupSuccess');
  const isCloud = deploymentMode === 'cloud';
  const [server, setServer] = useState<ServerInfo | null | undefined>(undefined);
  /** How this instance's MCP endpoint signs clients in (MCP_AUTH_MODE). */
  const [authMode, setAuthMode] = useState('');
  const [tab, setTab] = useState<ClientTab>('claude');
  const [showClients, setShowClients] = useState(false);

  useEffect(() => {
    serverApi.info().then((i) => setAuthMode(i?.mcpAuthMode || '')).catch(() => {});
  }, []);

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
          setServer({ id: serverId, name: s?.name ?? t('yourServer'), slug: s?.slug || 'anythingmcp', inUse: (activity?.calls30d ?? 0) > 0 });
        }
      } catch {
        if (!cancelled) setServer(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, connectorId, t]);

  const endpoint = server ? `${getApiOrigin()}/mcp/${server.id}` : '';
  const prompts = examples.length > 0 ? examples : [t('defaultPrompt', { name })];
  const openTab = (id: ClientTab) => {
    setTab(id);
    if (token) productEvents.track('client_tab_opened', token, { client: id, via: 'setup' });
  };

  const endpointRow = (
    <div>
      <div className="mb-1 text-xs font-medium text-[var(--text-3)]">{t('serverUrl')}</div>
      <div className="flex items-start gap-2">
        <code className="flex-1 rounded-[8px] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 font-mono text-[12.5px] text-[var(--text)] [overflow-wrap:anywhere]">
          {endpoint}
        </code>
        <CopyButton text={endpoint} />
      </div>
    </div>
  );

  /** Bold UI names (buttons and menus in the client) inside an instruction. */
  const rich = { b: (chunks: ReactNode) => <strong>{chunks}</strong> };

  const external = (href: string, label: string) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants({ size: 'sm' }), 'gap-1.5')}>
      {label} <span aria-hidden>↗</span>
    </a>
  );

  const clientSteps = server && (
    <div className="space-y-3">
      <div role="tablist" aria-label={t('tabs.label')} className="flex flex-wrap gap-1.5">
        {TABS.map((c) => (
          <button
            key={c.id}
            role="tab"
            aria-selected={tab === c.id}
            onClick={() => openTab(c.id)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              tab === c.id
                ? 'border-[var(--brand)] bg-[var(--brand)] text-[var(--primary-foreground)]'
                : 'border-[var(--border)] text-[var(--text-2)] hover:border-[var(--border-strong)]',
            )}
          >
            {c.label ?? t('tabs.other')}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="space-y-3 text-sm leading-relaxed text-[var(--text-2)]">
        {tab === 'claude' && (
          <>
            <ol className="list-decimal space-y-1 pl-5">
              <li>{t.rich('claude.step1', rich)}</li>
              <li>{t.rich('claude.step2', rich)}</li>
              <li>{t.rich('claude.step3', rich)}</li>
            </ol>
            {endpointRow}
            {external(CLAUDE_ADD_CONNECTOR_URL, t('claude.add'))}
            <p className="text-xs text-[var(--text-3)]">
              {t.rich('claude.noDialog', rich)}
              {isCloud && (
                <>
                  {' '}
                  {t.rich('claude.directory', {
                    ...rich,
                    link: (chunks) => (
                      <a href={CLAUDE_DIRECTORY_URL} target="_blank" rel="noopener noreferrer" className="underline">
                        {chunks}
                      </a>
                    ),
                  })}
                </>
              )}
            </p>
          </>
        )}
        {tab === 'chatgpt' && (
          <>
            <ol className="list-decimal space-y-1 pl-5">
              <li>{t.rich('chatgpt.step1', rich)}</li>
              <li>{t.rich('chatgpt.step2', rich)}</li>
              <li>{t.rich('chatgpt.step3', rich)}</li>
              <li>{t.rich('chatgpt.step4', rich)}</li>
            </ol>
            {endpointRow}
            {external('https://chatgpt.com/plugins', t('chatgpt.open'))}
            <p className="text-xs text-[var(--text-3)]">{t('chatgpt.plan')}</p>
          </>
        )}
        {tab === 'copilot' && (
          <>
            <p>{t.rich('copilot.body', rich)}</p>
            <a href={vscodeDeepLink({ name: server.slug, url: endpoint })} className={cn(buttonVariants({ size: 'sm' }))}>
              {t('copilot.add')}
            </a>
            <p className="text-xs text-[var(--text-3)]">
              {t.rich('copilot.other', {
                link: (chunks) => (
                  <Link href={`/mcp-server/${server.id}`} className="underline">
                    {chunks}
                  </Link>
                ),
              })}
            </p>
          </>
        )}
        {tab === 'other' && (
          <>
            <p>{t('other.body')}</p>
            {endpointRow}
            <Link href={`/mcp-server/${server.id}`} className={cn(buttonVariants({ size: 'sm', variant: 'secondary' }))}>
              {t('other.open', { name: server.name })}
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
            {t('title', { name })}
          </h1>
          <p className="text-sm text-[var(--text-2)]">
            {verified ? t('verified', { name }) : t('ready', { name })}
          </p>
        </div>
      </div>

      {back && (
        <div className="space-y-2">
          {back.href ? (
            <a href={back.href} className={cn(buttonVariants())}>
              {t('back.button', { name: back.name })}
            </a>
          ) : (
            <p className="text-sm text-[var(--text-2)]">{t('back.closeTab', { name: back.name })}</p>
          )}
        </div>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-[var(--text)]">{t('tryAsking')}</h2>
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
          <h2 className="text-sm font-semibold text-[var(--text)]">{t('useIt')}</h2>
          {server === undefined && <p className="text-sm text-[var(--text-3)]">{t('loading')}</p>}
          {server === null && (
            <p className="text-sm text-[var(--text-2)]">
              {t.rich('noServer', {
                link: (chunks) => (
                  <Link href={`/connectors/${connectorId}`} className="underline">
                    {chunks}
                  </Link>
                ),
              })}
            </p>
          )}
          {server && server.inUse && !showClients && (
            <div className="space-y-1 rounded-[11px] border border-[var(--border)] p-3 text-sm text-[var(--text-2)]">
              <p>
                {t.rich('inUse', {
                  name,
                  server: server.name,
                  b: (chunks) => <strong className="text-[var(--text)]">{chunks}</strong>,
                })}
              </p>
              <button type="button" onClick={() => setShowClients(true)} className="text-xs underline hover:text-[var(--text)]">
                {t('anotherClient')}
              </button>
            </div>
          )}
          {server && (!server.inUse || showClients) && (
            // Claude and ChatGPT add a server by URL and sign in with OAuth,
            // from their own servers. A self-hosted instance on API keys
            // only, or one reachable on localhost, gets the server page with
            // the set-ups that do work there.
            authMode && authMode !== 'oauth2' && authMode !== 'both' ? (
              <p className="rounded-[9px] bg-[var(--t-warn-bg)] px-3 py-2 text-sm text-[var(--t-warn-fg)]" data-testid="setup-no-oauth">
                {t.rich('apiKeysOnly', {
                  mode: authMode,
                  server: server.name,
                  code: (chunks) => <code className="font-mono">{chunks}</code>,
                  link: (chunks) => (
                    <Link href={`/mcp-server/${server.id}`} className="underline">
                      {chunks}
                    </Link>
                  ),
                })}
              </p>
            ) : (
              <>
                {isLocalOnlyUrl(endpoint) && (
                  <p className="rounded-[9px] bg-[var(--t-warn-bg)] px-3 py-2 text-sm text-[var(--t-warn-fg)]" data-testid="setup-localhost">
                    {t('localhost')}
                  </p>
                )}
                {clientSteps}
              </>
            )
          )}
        </section>
      )}

      {sample && (
        <details>
          <summary className="cursor-pointer text-xs font-medium text-[var(--text-3)]">{t('sample', { name })}</summary>
          <pre className="mt-2 max-h-48 overflow-auto rounded-[9px] bg-[var(--surface-2)] p-3 text-xs text-[var(--text)]">{sample}</pre>
        </details>
      )}

      <div className="flex flex-wrap gap-2 border-t border-[var(--border)] pt-4">
        <Link href={`/connectors/${connectorId}`} className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}>
          {t('openConnector')}
        </Link>
        <Link href="/connectors/store" className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}>
          {t('addAnother')}
        </Link>
      </div>
    </div>
  );
}
