'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import { mcpServers, connectors as connectorsApi, mcpKeys, productEvents, server as serverApi } from '@/lib/api';
import { AppShell } from '@/components/app-shell';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge, StatusPill, type Tone } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { ConnectionCheck } from '@/components/connection-check';
import { FirstSuccessOffer } from '@/components/first-success-offer';
import { copyText } from '@/lib/clipboard';
import { getApiOrigin } from '@/lib/origin';
import { CLAUDE_ADD_CONNECTOR_URL, CLAUDE_DIRECTORY_URL } from '@/lib/marketing';
import { INSPECTOR_URL, inspectorCommand } from '@/lib/inspector-url';
import {
  cursorDeepLink as buildCursorDeepLink,
  vscodeDeepLink as buildVscodeDeepLink,
  cursorInstallUrl,
  vscodeInstallUrl,
  installBadgesHtml,
  installBadgesMarkdown,
  isLocalOnlyUrl,
} from '@/lib/mcp-install-links';

export default function McpServerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { token, deploymentMode } = useAuth();
  const isCloud = deploymentMode === 'cloud';
  const router = useRouter();
  const t = useTranslations('mcpServer');

  const [server, setServer] = useState<any>(null);
  // Bumped a moment after the first request arrives, so the card-trial offer
  // (which the backend unlocks on the first successful call) can appear.
  const [offerKey, setOfferKey] = useState(0);
  const [allConnectors, setAllConnectors] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  // MCP auth mode of this instance; install badges only work with OAuth.
  const [mcpAuthMode, setMcpAuthMode] = useState('');

  // Edit state
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editInstructions, setEditInstructions] = useState('');
  const [editSkillsDelivery, setEditSkillsDelivery] = useState<'auto' | 'inline' | 'index'>('auto');
  // `error` colours the line; it used to be read from an "Error" prefix,
  // which a translated message does not have.
  const [saveMsg, setSaveMsg] = useState<{ text: string; error: boolean } | null>(null);

  // API key state
  const [newKeyName, setNewKeyName] = useState('');
  const [generatedKey, setGeneratedKey] = useState('');
  const [keyMsg, setKeyMsg] = useState<{ text: string; error: boolean } | null>(null);

  // Connector assignment state. A change is saved the moment it is made: the
  // list used to wait for a "Save assignments" button below it, which went
  // off screen once a workspace had a few connectors, and a server looked
  // configured while exposing no tools at all.
  const [assignedIds, setAssignedIds] = useState<Set<string>>(new Set());
  const [assignStatus, setAssignStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [assignError, setAssignError] = useState('');
  // The set the next change starts from (state lags behind rapid clicks),
  // the last one the server accepted, and a chain that keeps writes in order.
  const currentIds = useRef<Set<string>>(new Set());
  const savedIds = useRef<Set<string>>(new Set());
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const saveSeq = useRef(0);

  const [copied, setCopied] = useState('');
  const [connectClient, setConnectClient] = useState<string | null>(null);

  // Funnel instrumentation. This is the page that stands between "attached
  // a connector" and "sent the first MCP request", and three quarters of the
  // workspaces that reach it never send one. Record what people actually do
  // here (copy the URL, open a client, generate a key, or leave without
  // touching anything) so the next change to it is informed by data.
  const copiedAnything = useRef(false);
  useEffect(() => {
    if (!token || !id) return;
    productEvents.track('post_attach_viewed', token, { serverId: id });
    const onLeave = () => {
      if (!copiedAnything.current) {
        productEvents.track('left_page_without_copy', token, { serverId: id });
        // Fire once, whether pagehide or unmount gets there first.
        copiedAnything.current = true;
      }
    };
    window.addEventListener('pagehide', onLeave);
    return () => {
      window.removeEventListener('pagehide', onLeave);
      onLeave();
    };
  }, [token, id]);

  useEffect(() => {
    if (!token || !id) return;
    Promise.all([
      mcpServers.get(id, token),
      connectorsApi.list(token),
    ]).then(([srv, conns]) => {
      setServer(srv);
      setEditName(srv.name);
      setEditDescription(srv.description || '');
      setEditInstructions(srv.instructions || '');
      setEditSkillsDelivery(srv.skillsDelivery || 'auto');
      setAllConnectors(conns);
      const ids = new Set<string>(srv.connectors?.map((c: any) => c.connector.id) || []);
      currentIds.current = ids;
      savedIds.current = ids;
      setAssignedIds(ids);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [token, id]);

  useEffect(() => {
    serverApi.info().then((info) => setMcpAuthMode(info?.mcpAuthMode || '')).catch(() => {});
  }, []);

  const apiUrl = getApiOrigin();

  const handleSave = async () => {
    if (!token || !id) return;
    try {
      const updated = await mcpServers.update(id, {
        name: editName.trim(),
        description: editDescription.trim() || undefined,
        instructions: editInstructions.trim() || undefined,
        skillsDelivery: editSkillsDelivery,
      }, token);
      setServer((prev: any) => ({ ...prev, ...updated }));
      setSaveMsg({ text: t('saved'), error: false });
      setTimeout(() => setSaveMsg(null), 2000);
    } catch (err: any) {
      setSaveMsg({ text: t('error', { message: err.message }), error: true });
    }
  };

  const handleToggleActive = async () => {
    if (!token || !id || !server) return;
    try {
      const updated = await mcpServers.update(id, { isActive: !server.isActive }, token);
      setServer((prev: any) => ({ ...prev, ...updated }));
    } catch {}
  };

  const saveAssignments = (next: Set<string>) => {
    if (!token || !id) return;
    currentIds.current = next;
    setAssignedIds(next);
    setAssignStatus('saving');
    const seq = ++saveSeq.current;
    saveChain.current = saveChain.current.then(async () => {
      try {
        await mcpServers.assignConnectors(id, Array.from(next), token);
        savedIds.current = next;
        if (seq === saveSeq.current) {
          setAssignStatus('saved');
          setAssignError('');
        }
      } catch (err: any) {
        // Put the list back to what the server has, so the ticks never claim
        // more than the endpoint exposes.
        if (seq === saveSeq.current) {
          currentIds.current = savedIds.current;
          setAssignedIds(new Set(savedIds.current));
          setAssignStatus('error');
          setAssignError(err?.message || t('assignError'));
        }
      }
    });
  };

  const handleToggleConnector = (connectorId: string) => {
    const next = new Set(currentIds.current);
    if (next.has(connectorId)) next.delete(connectorId);
    else next.add(connectorId);
    saveAssignments(next);
  };

  const handleGenerateKey = async () => {
    if (!token || !newKeyName.trim()) return;
    try {
      const result = await mcpKeys.generate(newKeyName.trim(), token, id);
      productEvents.track('api_key_generated', token, { serverId: id });
      setGeneratedKey(result.key);
      setNewKeyName('');
      setKeyMsg({ text: t('keyGenerated'), error: false });
      // Reload server to refresh key list
      const srv = await mcpServers.get(id, token);
      setServer(srv);
    } catch (err: any) {
      setKeyMsg({ text: t('error', { message: err.message }), error: true });
    }
  };

  const handleRevokeKey = async (keyId: string) => {
    if (!token) return;
    try {
      await mcpKeys.revoke(keyId, token);
      const srv = await mcpServers.get(id, token);
      setServer(srv);
      setKeyMsg({ text: t('keyRevoked'), error: false });
    } catch (err: any) {
      setKeyMsg({ text: t('error', { message: err.message }), error: true });
    }
  };

  const handleDeleteKey = async (keyId: string) => {
    if (!token || !confirm(t('confirmDeleteKey'))) return;
    try {
      await mcpKeys.delete(keyId, token);
      const srv = await mcpServers.get(id, token);
      setServer(srv);
      setKeyMsg({ text: t('keyDeleted'), error: false });
    } catch (err: any) {
      setKeyMsg({ text: t('error', { message: err.message }), error: true });
    }
  };

  const handleDeleteServer = async () => {
    if (!token || !id || !confirm(t('confirmDeleteServer'))) return;
    try {
      await mcpServers.delete(id, token);
      router.push('/mcp-server');
    } catch {}
  };

  const handleCopy = async (text: string, label: string) => {
    const ok = await copyText(text);
    if (ok) {
      setCopied(label);
      setTimeout(() => setCopied(''), 2000);
      copiedAnything.current = true;
      if (token) {
        if (label === 'endpoint') {
          productEvents.track('mcp_url_copied', token, { serverId: id });
        } else {
          productEvents.track('client_config_copied', token, { serverId: id, client: label });
        }
      }
    }
  };

  if (loading) {
    return (
      <AppShell backTo={{ label: t('back'), href: '/mcp-server' }} title={t('loading')}>
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-1/3 rounded-[9px] bg-[var(--surface-2)]" />
          <div className="h-40 rounded-[14px] bg-[var(--surface-2)]" />
          <div className="h-40 rounded-[14px] bg-[var(--surface-2)]" />
        </div>
      </AppShell>
    );
  }

  if (!server) {
    return (
      <AppShell backTo={{ label: t('back'), href: '/mcp-server' }} title={t('notFoundTitle')}>
        <Card className="p-10 text-center">
          <p className="text-[var(--text-3)]">{t('notFound')}</p>
        </Card>
      </AppShell>
    );
  }

  const endpointUrl = `${apiUrl}/mcp/${id}`;

  const slug = server.slug || 'my-server';

  // Streamable-HTTP MCP config consumed by clients that accept a remote
  // "type": "http" entry in their mcpServers JSON — Cursor, VS Code and
  // Claude Code.
  // IMPORTANT: Claude *Desktop* does NOT accept this — its
  // claude_desktop_config.json only spawns local stdio commands, so a remote
  // http/url entry is silently skipped ("not a valid MCP server
  // configuration"). For Claude Desktop use Customize → Connectors, or
  // the mcp-remote bridge (claudeDesktopBridge* below).
  const claudeConfigOAuth = `{
  "mcpServers": {
    "${slug}": {
      "type": "http",
      "url": "${endpointUrl}"
    }
  }
}`;

  const claudeConfigApiKey = `{
  "mcpServers": {
    "${slug}": {
      "type": "http",
      "url": "${endpointUrl}",
      "headers": {
        "X-API-Key": "YOUR_MCP_API_KEY"
      }
    }
  }
}`;

  // Claude Desktop runs only local stdio servers from its config file, so a
  // remote server is bridged through the `mcp-remote` npm package (it proxies
  // stdio ↔ streamable HTTP and drives the OAuth flow in the browser).
  const claudeDesktopBridgeOAuth = `{
  "mcpServers": {
    "${slug}": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${endpointUrl}"]
    }
  }
}`;

  const claudeDesktopBridgeApiKey = `{
  "mcpServers": {
    "${slug}": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${endpointUrl}", "--header", "X-API-Key:YOUR_MCP_API_KEY"]
    }
  }
}`;

  const windsurfConfig = `{
  "mcpServers": {
    "${slug}": {
      "serverUrl": "${endpointUrl}"
    }
  }
}`;

  // GitHub Copilot (VS Code, Visual Studio desktop, JetBrains, Eclipse, Xcode)
  // reads MCP servers from an `.mcp.json` / `mcp.json` file that uses the
  // top-level "servers" key (not "mcpServers") with a remote "http" entry.
  const copilotConfig = `{
  "servers": {
    "${slug}": {
      "type": "http",
      "url": "${endpointUrl}"
    }
  }
}`;

  const copilotConfigApiKey = `{
  "servers": {
    "${slug}": {
      "type": "http",
      "url": "${endpointUrl}",
      "headers": {
        "X-API-Key": "YOUR_MCP_API_KEY"
      }
    }
  }
}`;

  const installTarget = { name: slug, url: endpointUrl };
  const cursorDeepLink = () => buildCursorDeepLink(installTarget);
  const vscodeDeepLink = () => buildVscodeDeepLink(installTarget);
  const badgesMarkdown = installBadgesMarkdown(installTarget);
  const badgesHtml = installBadgesHtml(installTarget);
  const badgesSupported = mcpAuthMode === 'oauth2' || mcpAuthMode === 'both';

  const aiClients: { id: string; name: string; init: string; tone: Tone }[] = [
    { id: 'cursor', name: 'Cursor', init: 'Cu', tone: 'info' },
    { id: 'vscode', name: 'VS Code', init: 'VS', tone: 'purple' },
    { id: 'copilot', name: 'GitHub Copilot', init: 'Co', tone: 'neutral' },
    { id: 'claude-web', name: 'Claude (Web)', init: 'Cl', tone: 'warn' },
    { id: 'claude-desktop', name: 'Claude Desktop', init: 'Cl', tone: 'warn' },
    { id: 'claude-code', name: 'Claude Code', init: 'Cl', tone: 'warn' },
    { id: 'chatgpt', name: 'ChatGPT', init: 'GP', tone: 'emerald' },
    { id: 'muse', name: 'Meta Muse', init: 'Mu', tone: 'info' },
    { id: 'gemini', name: 'Gemini CLI', init: 'Ge', tone: 'pink' },
    { id: 'windsurf', name: 'Windsurf', init: 'Wi', tone: 'success' },
    { id: 'inspector', name: 'MCP Inspector', init: 'In', tone: 'neutral' },
  ];

  // Tags for the translated instructions (`t.rich`), in this page's inline styles.
  const inlineCode = 'rounded bg-[var(--surface-2)] px-1 font-mono';
  const rich = {
    strong: (chunks: React.ReactNode) => <strong>{chunks}</strong>,
    em: (chunks: React.ReactNode) => <em>{chunks}</em>,
    code: (chunks: React.ReactNode) => <code className={inlineCode}>{chunks}</code>,
  };
  const richXs = {
    ...rich,
    code: (chunks: React.ReactNode) => <code className={`${inlineCode} text-xs`}>{chunks}</code>,
  };
  const richLabel = {
    ...rich,
    strong: (chunks: React.ReactNode) => <strong className="text-[var(--text-2)]">{chunks}</strong>,
  };

  const codeBlock = (text: string, label: string) => (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] text-[var(--text-3)]">{label}</span>
        <button
          onClick={() => handleCopy(text, `modal-${label}`)}
          className="text-[12px] font-semibold text-[var(--brand)] hover:underline"
        >
          {copied === `modal-${label}` ? t('copied') : t('copy')}
        </button>
      </div>
      <pre className="overflow-x-auto rounded-[10px] bg-[#0c0f16] p-[13px] font-mono text-[12px] leading-[1.6] text-[#cdd6e8]">{text}</pre>
    </div>
  );

  const assignedConnectors = allConnectors.filter((c) => assignedIds.has(c.id));

  // Says which connectors THIS url serves, next to every place it can be
  // copied. Servers look alike ("Default", "AutoSkill"…), and a client wired to
  // the wrong one showed tools the user thought they had removed.
  const exposesLine = (className = '') => (
    <p className={cn('text-[11.5px] leading-[1.5] text-[var(--text-3)]', className)}>
      {assignedConnectors.length === 0
        ? t.rich('exposesNone', richLabel)
        : t.rich('exposesSome', { ...richLabel, names: assignedConnectors.map((c) => c.name).join(', ') })}
    </p>
  );

  const endpointRow = (copyKey: string) => (
    <div>
      <label className="mb-1.5 block text-[11px] text-[var(--text-3)]">{t('endpointUrl')}</label>
      <div className="flex gap-2">
        <code className="flex-1 break-all rounded-[8px] border border-[var(--border)] bg-[var(--surface-2)] px-[11px] py-[9px] font-mono text-[12px] text-[var(--text-2)]">{endpointUrl}</code>
        <button
          onClick={() => handleCopy(endpointUrl, copyKey)}
          className={cn(buttonVariants({ variant: 'secondary', size: 'md' }), 'flex-shrink-0')}
        >
          {copied === copyKey ? t('copied') : t('copy')}
        </button>
      </div>
      {exposesLine('mt-1.5')}
    </div>
  );

  const linkAction = (href: string, label: string, external?: boolean) => (
    <a
      href={href}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      className={cn(buttonVariants({ variant: 'primary', size: 'lg' }))}
    >
      {label}
    </a>
  );

  // On Cloud only: AnythingMCP's listing in Claude's connector directory is a
  // one-click alternative to the custom connector. It connects the shared
  // /mcp endpoint, where the sign-in asks which servers to reach, so the
  // steps for this one server stay below it.
  const claudeDirectoryNote = () =>
    isCloud ? (
      <div className="space-y-2 rounded-[10px] border border-[var(--border)] bg-[var(--surface-2)] p-3" data-testid="claude-directory">
        <p className="text-[13px] font-semibold text-[var(--text)]">
          {t('directory.title')}
        </p>
        {linkAction(CLAUDE_DIRECTORY_URL, t('directory.open'), true)}
        <p className="text-xs leading-[1.55] text-[var(--text-3)]">
          {t.rich('directory.body', {
            code: (chunks) => <code className="rounded bg-[var(--surface)] px-1 font-mono">{chunks}</code>,
          })}
        </p>
      </div>
    ) : null;

  const renderModalContent = (clientId: string) => {
    switch (clientId) {
      case 'cursor':
        return (
          <div className="space-y-4">
            <p className="text-[13px] leading-[1.55] text-[var(--text-2)]">
              {t('modal.cursorBody')}
            </p>
            {linkAction(cursorDeepLink(), t('modal.openCursor'))}
          </div>
        );
      case 'vscode':
        return (
          <div className="space-y-4">
            <p className="text-[13px] leading-[1.55] text-[var(--text-2)]">
              {t('modal.vscodeBody')}
            </p>
            {linkAction(vscodeDeepLink(), t('modal.openVscode'))}
          </div>
        );
      case 'copilot':
        return (
          <div className="space-y-4">
            <p className="text-[13px] leading-[1.55] text-[var(--text-2)]">
              {t.rich('modal.copilotBody', rich)}
            </p>
            {codeBlock(copilotConfig, 'copilot-oauth')}
            <div className="space-y-1 text-[12px] leading-[1.6] text-[var(--text-3)]">
              <div>{t.rich('modal.copilotVscode', richLabel)}</div>
              <div>
                {t.rich('modal.copilotVisualStudio', {
                  ...richLabel,
                  solutionPath: '<solution>\\.mcp.json',
                  userPath: '%USERPROFILE%\\.mcp.json',
                })}
              </div>
              <div>{t.rich('modal.copilotOther', richLabel)}</div>
            </div>
            {linkAction(vscodeDeepLink(), t('modal.copilotOneClick'))}
            <details className="group pt-1">
              <summary className="cursor-pointer text-xs font-medium text-[var(--text-3)] hover:text-[var(--text)]">
                {t('modal.apiKeyInstead')}
              </summary>
              <div className="mt-3">{codeBlock(copilotConfigApiKey, 'copilot-apikey')}</div>
            </details>
          </div>
        );
      case 'claude-web':
        return (
          <div className="space-y-4">
            {claudeDirectoryNote()}
            <p className="text-[13px] leading-[1.55] text-[var(--text-2)]">
              {t.rich('modal.claudeWebStep1', rich)}<br />
              {t.rich('modal.claudeWebStep2', rich)}<br />
              {t.rich('modal.claudeWebStep3', rich)}
            </p>
            {linkAction(CLAUDE_ADD_CONNECTOR_URL, t('modal.addToClaude'), true)}
            <p className="text-xs leading-[1.55] text-[var(--text-3)]">
              {t.rich('modal.claudeWebFallback', rich)}
            </p>
            {endpointRow('modal-endpoint')}
          </div>
        );
      case 'claude-desktop':
        return (
          <div className="space-y-4">
            {claudeDirectoryNote()}
            <p className="text-[13px] leading-[1.55] text-[var(--text-2)]">
              {t.rich('modal.claudeDesktopRecommended', richXs)}
            </p>
            <p className="text-[13px] leading-[1.55] text-[var(--text-2)]">
              {t.rich('modal.claudeDesktopStep1', rich)}<br />
              {t.rich('modal.claudeDesktopStep2', rich)}<br />
              {t.rich('modal.claudeDesktopStep3', rich)}
            </p>
            {linkAction(CLAUDE_ADD_CONNECTOR_URL, t('modal.addToClaude'), true)}
            {endpointRow('modal-claude-desktop-url')}

            <details className="group pt-1">
              <summary className="cursor-pointer text-xs font-medium text-[var(--text-3)] hover:text-[var(--text)]">
                {t('modal.bridgeSummary')}
              </summary>
              <div className="mt-3 space-y-4">
                <p className="text-xs leading-[1.55] text-[var(--text-3)]">
                  {t.rich('modal.bridgeBody', rich)}
                </p>
                {codeBlock(claudeDesktopBridgeOAuth, 'claude-bridge-oauth')}
                {codeBlock(claudeDesktopBridgeApiKey, 'claude-bridge-apikey')}
              </div>
            </details>
          </div>
        );
      case 'claude-code': {
        const cmd = `claude mcp add --transport http ${slug} ${endpointUrl}`;
        return (
          <div className="space-y-4">
            <p className="text-[13px] leading-[1.55] text-[var(--text-2)]">
              {t('modal.runCommand')}
            </p>
            <div className="flex gap-2">
              <code className="flex-1 break-all rounded-[8px] border border-[var(--border)] bg-[var(--surface-2)] px-[11px] py-[9px] font-mono text-[12px] text-[var(--text-2)]">{cmd}</code>
              <button
                onClick={() => handleCopy(cmd, 'modal-claude-code')}
                className={cn(buttonVariants({ variant: 'secondary', size: 'md' }), 'flex-shrink-0')}
              >
                {copied === 'modal-claude-code' ? t('copied') : t('copy')}
              </button>
            </div>
          </div>
        );
      }
      case 'chatgpt':
        return (
          <div className="space-y-4">
            <p className="text-[13px] leading-[1.55] text-[var(--text-2)]">
              {t.rich('modal.chatgptStep1', rich)}<br />
              {t.rich('modal.chatgptStep2', rich)}<br />
              {t.rich('modal.chatgptStep3', rich)}<br />
              {t.rich('modal.chatgptStep4', rich)}
            </p>
            {linkAction('https://chatgpt.com/plugins', t('modal.openChatgpt'), true)}
            {endpointRow('modal-chatgpt-url')}
            <p className="text-xs leading-[1.55] text-[var(--text-3)]">
              {t.rich('modal.chatgptNote', rich)}
            </p>
          </div>
        );
      case 'muse': {
        // Meta's own documented setup: ask Muse in a chat to create the
        // connector. Works on web, iOS, Android and WhatsApp.
        const musePrompt = `Create a Custom Connector for a new remote MCP server, then connect to it:
Name: AnythingMCP
Transport: remote streamable HTTP
URL: ${endpointUrl}
Auth: OAuth`;
        return (
          <div className="space-y-4">
            <p className="text-[13px] leading-[1.55] text-[var(--text-2)]">
              {t.rich('modal.museStep1', rich)}<br />
              {t('modal.museStep2')}<br />
              {t('modal.museStep3')}<br />
              {t('modal.museStep4')}
            </p>
            {endpointRow('modal-muse-url')}
            <p className="text-[13px] leading-[1.55] text-[var(--text-2)]">
              {t('modal.museChat')}
            </p>
            {codeBlock(musePrompt, 'muse-chat')}
            <p className="text-xs leading-[1.55] text-[var(--text-3)]">
              {t.rich('modal.museNote', rich)}
            </p>
          </div>
        );
      }
      case 'gemini': {
        const cmd = `gemini mcp add --transport http ${slug} ${endpointUrl}`;
        return (
          <div className="space-y-4">
            <p className="text-[13px] leading-[1.55] text-[var(--text-2)]">
              {t('modal.runCommand')}
            </p>
            <div className="flex gap-2">
              <code className="flex-1 break-all rounded-[8px] border border-[var(--border)] bg-[var(--surface-2)] px-[11px] py-[9px] font-mono text-[12px] text-[var(--text-2)]">{cmd}</code>
              <button
                onClick={() => handleCopy(cmd, 'modal-gemini')}
                className={cn(buttonVariants({ variant: 'secondary', size: 'md' }), 'flex-shrink-0')}
              >
                {copied === 'modal-gemini' ? t('copied') : t('copy')}
              </button>
            </div>
          </div>
        );
      }
      case 'windsurf':
        return (
          <div className="space-y-4">
            <p className="text-[13px] leading-[1.55] text-[var(--text-2)]">
              {t.rich('modal.windsurfBody', richXs)}
            </p>
            {codeBlock(windsurfConfig, 'windsurf')}
          </div>
        );
      case 'inspector': {
        const cmd = inspectorCommand(endpointUrl);
        return (
          <div className="space-y-4">
            <p className="text-[13px] leading-[1.55] text-[var(--text-2)]">
              {t('modal.inspectorRun')}
            </p>
            <div className="flex gap-2">
              <code className="flex-1 break-all rounded-[8px] border border-[var(--border)] bg-[var(--surface-2)] px-[11px] py-[9px] font-mono text-[12px] text-[var(--text-2)]">{cmd}</code>
              <button
                onClick={() => handleCopy(cmd, 'modal-inspector')}
                className={cn(buttonVariants({ variant: 'secondary', size: 'md' }), 'flex-shrink-0')}
              >
                {copied === 'modal-inspector' ? t('copied') : t('copy')}
              </button>
            </div>
            <p className="text-[13px] leading-[1.55] text-[var(--text-2)]">
              {t('modal.inspectorOpens')}
            </p>
            {linkAction(INSPECTOR_URL, t('modal.openInspector'), true)}
            <p className="text-xs leading-[1.55] text-[var(--text-3)]">
              {t.rich('modal.inspectorToken', rich)}
            </p>
            <p className="text-[13px] leading-[1.55] text-[var(--text-2)]">
              {t.rich('modal.inspectorAuth', { ...richXs, headerFlag: '--header "X-API-Key: <your key>"' })}
            </p>
            {endpointRow('modal-inspector-url')}
          </div>
        );
      }
      default:
        return null;
    }
  };

  // Tools from assigned connectors
  const toolsList = assignedConnectors.flatMap((c) =>
    (c.tools || []).map((tool: any) => ({ ...tool, connectorName: c.name, connectorType: c.type })),
  );

  return (
    <AppShell
      backTo={{ label: t('back'), href: '/mcp-server' }}
      title={server.name}
      maxWidth={1200}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {/* The button names what it will do. Current state is the pill
              below it, which is where state belongs — labelling the button
              "Active" left it unclear whether it was a state or a switch. */}
          <Button variant="secondary" size="md" onClick={handleToggleActive}>
            {server.isActive ? t('deactivate') : t('activate')}
          </Button>
          <Button variant="outlineDanger" size="md" onClick={handleDeleteServer}>
            {t('delete')}
          </Button>
        </div>
      }
    >
      {/* Server identity header */}
      <div className="mb-[18px] flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-[13px]">
          <div
            className="flex h-12 w-12 items-center justify-center rounded-[12px]"
            style={{ background: 'var(--t-emerald-bg)', color: 'var(--t-emerald-fg)' }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect width="20" height="8" x="2" y="2" rx="2" /><rect width="20" height="8" x="2" y="14" rx="2" /></svg>
          </div>
          <div>
            <div className="flex items-center gap-[9px]">
              <span className="text-[18px] font-semibold tracking-[-0.02em]">{server.name}</span>
              <StatusPill tone={server.isActive ? 'success' : 'neutral'} dot={server.isActive ? 'var(--ok)' : 'var(--text-3)'}>
                {server.isActive ? t('active') : t('inactive')}
              </StatusPill>
            </div>
            <div className="mt-0.5 break-all font-mono text-[12.5px] text-[var(--text-3)]">{endpointUrl}</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
        {/* Connect a client — sticky right column on desktop, shown first on mobile */}
        <aside className="order-1 flex flex-col gap-4 lg:order-2 lg:sticky lg:top-4">
        {token && (
          <ConnectionCheck
            serverId={id}
            token={token}
            onFirstCall={() => setTimeout(() => setOfferKey((k) => k + 1), 3000)}
          />
        )}
        <FirstSuccessOffer via="connect" refreshKey={offerKey} />
        <Card className="p-[22px]">
          <div className="mb-[14px] text-sm font-semibold">{t('connect.title')}</div>
          <div className="mb-1.5 text-[11px] text-[var(--text-3)]">{t('connect.endpoint')}</div>
          <div className="mb-[18px] flex gap-2">
            <code className="flex-1 break-all rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-[10px] font-mono text-[12.5px] text-[var(--text-2)]">{endpointUrl}</code>
            <button
              onClick={() => handleCopy(endpointUrl, 'endpoint')}
              className={cn(buttonVariants({ variant: 'secondary', size: 'md' }), 'flex-shrink-0')}
            >
              {copied === 'endpoint' ? t('copied') : t('copy')}
            </button>
          </div>
          {exposesLine('mb-3')}

          <div className="mb-[10px] text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-3)]">
            {t('connect.quickConnect')}
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
            {aiClients.map((client) => (
              <button
                key={client.id}
                onClick={() => {
                  setConnectClient(client.id);
                  if (token) productEvents.track('client_tab_opened', token, { serverId: id, client: client.id });
                }}
                className="flex items-center gap-[9px] rounded-[10px] border border-[var(--border)] bg-[var(--surface)] px-3 py-[10px] text-left transition-colors hover:border-[var(--brand)] hover:bg-[var(--brand-tint)]"
              >
                <span
                  className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[7px] text-[11px] font-semibold"
                  style={{ background: `var(--t-${client.tone}-bg)`, color: `var(--t-${client.tone}-fg)` }}
                >
                  {client.init}
                </span>
                <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] font-medium">
                  {client.name}
                </span>
              </button>
            ))}
          </div>

          {/* Manual Config (collapsible) */}
          <details className="group mt-[18px]">
            <summary className="cursor-pointer text-sm font-medium text-[var(--text-3)] transition-colors hover:text-[var(--text)]">
              {t('connect.manual')}
            </summary>
            <div className="mt-3 space-y-4">
              {/* OAuth config */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h4 className="text-sm font-medium">{t('connect.oauthTitle')}</h4>
                  <button
                    onClick={() => handleCopy(claudeConfigOAuth, 'claude-oauth')}
                    className="text-[12px] font-semibold text-[var(--brand)] hover:underline"
                  >
                    {copied === 'claude-oauth' ? t('copied') : t('copyConfig')}
                  </button>
                </div>
                <pre className="overflow-x-auto rounded-[10px] bg-[#0c0f16] p-[13px] font-mono text-[12px] leading-[1.6] text-[#cdd6e8]">{claudeConfigOAuth}</pre>
                <p className="mt-2 text-[11.5px] text-[var(--text-3)]">
                  {t.rich('connect.oauthNote', rich)}
                </p>
              </div>

              {/* API Key config */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h4 className="text-sm font-medium">{t('connect.apiKeyTitle')}</h4>
                  <button
                    onClick={() => handleCopy(claudeConfigApiKey, 'claude-apikey')}
                    className="text-[12px] font-semibold text-[var(--brand)] hover:underline"
                  >
                    {copied === 'claude-apikey' ? t('copied') : t('copyConfig')}
                  </button>
                </div>
                <pre className="overflow-x-auto rounded-[10px] bg-[#0c0f16] p-[13px] font-mono text-[12px] leading-[1.6] text-[#cdd6e8]">{claudeConfigApiKey}</pre>
                <p className="mt-2 text-[11.5px] text-[var(--text-3)]">
                  {t.rich('connect.apiKeyNote', rich)}
                </p>
              </div>
            </div>
          </details>
        </Card>
        {mcpAuthMode && (
        <Card className="p-[22px]" data-testid="share-server">
          <div className="mb-[6px] text-sm font-semibold">{t('share.title')}</div>
          <p className="mb-[14px] text-[12px] text-[var(--text-3)]">
            {t('share.body')}
          </p>
          {!badgesSupported ? (
            <p className="text-[12px] text-[var(--text-2)]" data-testid="share-oauth-required">
              {t.rich('share.oauthRequired', rich)}
            </p>
          ) : (
            <div className="space-y-3">
              {isLocalOnlyUrl(endpointUrl) && (
                <p
                  className="rounded-[9px] px-3 py-2 text-[12px]"
                  style={{ background: 'var(--t-warn-bg)', color: 'var(--t-warn-fg)' }}
                  data-testid="share-localhost-warning"
                >
                  {t('share.localhost')}
                </p>
              )}
              {/* Local preview: styled links only, no remote images (offline installs). */}
              <div className="flex flex-wrap gap-2" data-testid="share-preview">
                <a
                  href={cursorInstallUrl(installTarget)}
                  className="inline-flex items-center overflow-hidden rounded-[6px] bg-[#0b1220] text-[12px] font-semibold text-white"
                >
                  <span className="px-2 py-1">Cursor</span>
                  <span className="bg-[#1f2937] px-2 py-1">{t('share.addToCursor')}</span>
                </a>
                <a
                  href={vscodeInstallUrl(installTarget)}
                  className="inline-flex items-center overflow-hidden rounded-[6px] bg-[#0b1220] text-[12px] font-semibold text-white"
                >
                  <span className="px-2 py-1">VS Code</span>
                  <span className="bg-[#0066CC] px-2 py-1">{t('share.addToVscode')}</span>
                </a>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => handleCopy(badgesMarkdown, 'badge-markdown')}
                  className={buttonVariants({ variant: 'secondary', size: 'md' })}
                >
                  {copied === 'badge-markdown' ? t('copied') : t('share.copyMarkdown')}
                </button>
                <button
                  onClick={() => handleCopy(badgesHtml, 'badge-html')}
                  className={buttonVariants({ variant: 'secondary', size: 'md' })}
                >
                  {copied === 'badge-html' ? t('copied') : t('share.copyHtml')}
                </button>
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-[10px] bg-[#0c0f16] p-[13px] font-mono text-[12px] leading-[1.6] text-[#cdd6e8]">{badgesMarkdown}</pre>
            </div>
          )}
        </Card>
        )}
        </aside>

        {/* Connect Modal */}
        {connectClient && (
          <div
            className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-5"
            onClick={() => setConnectClient(null)}
          >
            <div
              className="max-h-[86vh] w-full max-w-[540px] overflow-y-auto rounded-[16px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-base font-semibold">
                  {t('modal.title', { client: aiClients.find((c) => c.id === connectClient)?.name ?? '' })}
                </h3>
                <button
                  onClick={() => setConnectClient(null)}
                  className="flex h-[30px] w-[30px] items-center justify-center text-xl leading-none text-[var(--text-3)] hover:text-[var(--text)]"
                >
                  &times;
                </button>
              </div>
              {renderModalContent(connectClient)}
            </div>
          </div>
        )}

        {/* Main column — Server settings on top, then connectors, keys, tools */}
        <div className="order-2 flex min-w-0 flex-col gap-4 lg:order-1">
        {/* Assigned Connectors */}
        <Card className="p-[22px]">
          <div className="mb-1.5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="text-sm font-semibold">{t('assigned.title', { count: assignedIds.size })}</div>
              <span
                role="status"
                aria-live="polite"
                className="text-[12px]"
                style={{ color: assignStatus === 'error' ? 'var(--danger)' : 'var(--text-3)' }}
              >
                {assignStatus === 'saving' && t('assigned.saving')}
                {assignStatus === 'saved' && t('assigned.saved')}
                {assignStatus === 'error' && t('assigned.notSaved', { error: assignError })}
              </span>
            </div>
            {allConnectors.length > 0 && (
              <div className="flex gap-1.5">
                <button
                  onClick={() => saveAssignments(new Set(allConnectors.map((c) => c.id)))}
                  className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] px-[10px] py-[5px] text-[12px] text-[var(--text-2)] hover:border-[var(--border-strong)]"
                >
                  {t('assigned.selectAll')}
                </button>
                <button
                  onClick={() => saveAssignments(new Set())}
                  className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] px-[10px] py-[5px] text-[12px] text-[var(--text-2)] hover:border-[var(--border-strong)]"
                >
                  {t('assigned.deselectAll')}
                </button>
              </div>
            )}
          </div>
          <p className="mb-[14px] text-[12.5px] text-[var(--text-3)]">
            {t('assigned.description')}
          </p>
          {allConnectors.length === 0 ? (
            <p className="text-[12.5px] text-[var(--text-3)]">{t('assigned.none')}</p>
          ) : (
            <>
              <div className="mb-2 space-y-2">
                {allConnectors.map((c) => {
                  const checked = assignedIds.has(c.id);
                  return (
                    <label
                      key={c.id}
                      className="flex cursor-pointer items-center gap-[11px] rounded-[10px] border border-[var(--border)] bg-[var(--surface-2)] px-[11px] py-[10px]"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => handleToggleConnector(c.id)}
                        className="sr-only"
                      />
                      <span
                        className="flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-[5px] border-[1.5px]"
                        style={{
                          borderColor: checked ? 'var(--brand)' : 'var(--border-strong)',
                          background: checked ? 'var(--brand)' : 'transparent',
                        }}
                      >
                        {checked && (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                        )}
                      </span>
                      <span className="flex-1 text-[13.5px] font-medium">{c.name}</span>
                      <Badge tone="neutral">{c.type}</Badge>
                      <span className="min-w-[60px] whitespace-nowrap text-right text-[12px] text-[var(--text-3)]">
                        {t('assigned.tools', { count: (c.tools || []).length })}
                      </span>
                    </label>
                  );
                })}
              </div>
              {assignStatus === 'saved' && (
                // Clients fetch the tool list once, when they connect. Without
                // this, "I added the connector and Claude sees nothing" reads
                // as a broken server.
                <p className="mt-2 text-[12.5px] text-[var(--text-3)]">
                  {t.rich('assigned.refreshHint', {
                    menu: (chunks) => <span className="font-medium">{chunks}</span>,
                  })}
                </p>
              )}
            </>
          )}
        </Card>

        {/* API Keys */}
        <Card className="p-[22px]">
          <div className="mb-1.5 text-sm font-semibold">{t('keys.title')}</div>
          <p className="mb-[14px] text-[12.5px] text-[var(--text-3)]">
            {t('keys.description')}
          </p>

          <div className="mb-4 space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1 sm:max-w-sm">
                <label className="mb-1.5 block text-[12.5px] font-medium">{t('keys.label')}</label>
                <input
                  type="text"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  placeholder={t('keys.labelPlaceholder')}
                  className="h-[38px] w-full rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13.5px] outline-none focus:border-[var(--brand)]"
                />
              </div>
              <Button onClick={handleGenerateKey} disabled={!newKeyName.trim()} variant="primary" size="lg">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                {t('keys.generate')}
              </Button>
            </div>

            {generatedKey && (
              <div
                className="rounded-[10px] p-3"
                style={{ background: 'var(--t-success-bg)', border: '1px solid color-mix(in srgb, var(--t-success-fg) 25%, transparent)' }}
              >
                <p className="mb-1 text-[11.5px] font-semibold" style={{ color: 'var(--t-success-fg)' }}>
                  {t('keys.copyNow')}
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 select-all break-all rounded-[8px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 font-mono text-xs">
                    {generatedKey}
                  </code>
                  <button
                    onClick={async () =>
                      setKeyMsg(
                        (await copyText(generatedKey))
                          ? { text: t('copied'), error: false }
                          : { text: t('keys.copyBlocked'), error: true },
                      )
                    }
                    className={cn(buttonVariants({ variant: 'secondary', size: 'md' }), 'flex-shrink-0')}
                  >
                    {t('copy')}
                  </button>
                </div>
              </div>
            )}

            {keyMsg && (
              <p className="text-[13px]" style={{ color: keyMsg.error ? 'var(--danger)' : 'var(--ok)' }}>
                {keyMsg.text}
              </p>
            )}
          </div>

          {/* Key list */}
          {server.apiKeys && server.apiKeys.length > 0 && (
            <div>
              {server.apiKeys.map((k: any) => (
                <div key={k.id} className="flex flex-col gap-2 border-t border-[var(--border)] py-[11px] sm:flex-row sm:items-center sm:gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] font-medium">{k.name}</div>
                    <div className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[12px] text-[var(--text-3)]">
                      mcp_{'*'.repeat(24)}{k.key.slice(-8)}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <StatusPill tone={k.isActive ? 'success' : 'neutral'}>
                      {k.isActive ? t('keys.active') : t('keys.revoked')}
                    </StatusPill>
                    <span className="whitespace-nowrap text-[12px] text-[var(--text-3)]">
                      {k.lastUsedAt
                        ? t('keys.usedOn', { date: new Date(k.lastUsedAt).toLocaleDateString() })
                        : t('keys.usedNever')}
                    </span>
                    <div className="ml-auto flex gap-1 sm:ml-0">
                      {k.isActive && (
                        <button
                          onClick={() => handleRevokeKey(k.id)}
                          className="text-[12px] text-[var(--text-2)] hover:text-[var(--text)] hover:underline"
                        >
                          {t('keys.revoke')}
                        </button>
                      )}
                      <button
                        onClick={() => handleDeleteKey(k.id)}
                        className="text-[12px] text-[var(--danger)] hover:underline"
                      >
                        {t('keys.delete')}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Active Tools */}
        <Card className="p-[22px]">
          <div className="mb-[14px] text-sm font-semibold">{t('tools.title', { count: toolsList.length })}</div>
          {toolsList.length === 0 ? (
            <p className="text-[12.5px] text-[var(--text-3)]">
              {t('tools.none')}
            </p>
          ) : (
            <div className="space-y-2">
              {toolsList.map((tool: any) => (
                <div key={tool.id} className="flex flex-col gap-1 rounded-[10px] bg-[var(--surface-2)] p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span
                      className="h-2 w-2 flex-shrink-0 rounded-full"
                      style={{ background: tool.isEnabled ? 'var(--ok)' : 'var(--text-3)' }}
                    />
                    <span className="break-all font-mono text-[13.5px] font-medium">{tool.name}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2 pl-4 sm:justify-end sm:pl-0">
                    <span className="truncate text-[12px] text-[var(--text-3)]">{tool.connectorName}</span>
                    <StatusPill tone={tool.isEnabled ? 'success' : 'neutral'}>
                      {tool.isEnabled ? t('tools.enabled') : t('tools.disabled')}
                    </StatusPill>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Server settings + instructions — pinned to the top of the main column */}
        <Card className="order-first p-[22px]">
          <div className="mb-4 text-sm font-semibold">{t('settings.title')}</div>
          <div className="flex max-w-[520px] flex-col gap-[14px]">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-[12.5px] font-medium">{t('settings.name')}</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="h-[38px] w-full rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13.5px] outline-none focus:border-[var(--brand)]"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-[12.5px] font-medium">{t('settings.slug')}</label>
                <input
                  type="text"
                  value={server.slug}
                  disabled
                  className="h-[38px] w-full rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] px-3 font-mono text-[13.5px] text-[var(--text-3)]"
                />
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-[12.5px] font-medium">{t('settings.description')}</label>
              <input
                type="text"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder={t('settings.descriptionPlaceholder')}
                className="h-[38px] w-full rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13.5px] outline-none placeholder:text-[var(--text-3)] focus:border-[var(--brand)]"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[12.5px] font-medium">{t('settings.instructions')}</label>
              <textarea
                value={editInstructions}
                onChange={(e) => setEditInstructions(e.target.value)}
                placeholder={t('settings.instructionsPlaceholder')}
                rows={4}
                className="w-full resize-y rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 py-[10px] text-[13px] leading-[1.55] text-[var(--text-2)] outline-none placeholder:text-[var(--text-3)] focus:border-[var(--brand)]"
              />
              <p className="mt-1.5 text-[11.5px] text-[var(--text-3)]">
                {t('settings.instructionsHint')}
              </p>
            </div>
            <div>
              <label htmlFor="skills-delivery" className="mb-1.5 block text-[12.5px] font-medium">
                {t('settings.skills')}
              </label>
              <select
                id="skills-delivery"
                value={editSkillsDelivery}
                onChange={(e) => setEditSkillsDelivery(e.target.value as 'auto' | 'inline' | 'index')}
                className="h-[38px] w-full rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13.5px] outline-none focus:border-[var(--brand)]"
              >
                <option value="auto">{t('settings.skillsAuto')}</option>
                <option value="inline">{t('settings.skillsInline')}</option>
                <option value="index">{t('settings.skillsIndex')}</option>
              </select>
              <p className="mt-1.5 text-[11.5px] text-[var(--text-3)]">
                {t.rich('settings.skillsHint', {
                  link: (chunks) => (
                    <Link href="/knowledge-graph/skills" className="text-[var(--brand)] hover:underline">
                      {chunks}
                    </Link>
                  ),
                })}
              </p>
            </div>
            {saveMsg && (
              <p className="text-[13px]" style={{ color: saveMsg.error ? 'var(--danger)' : 'var(--ok)' }}>
                {saveMsg.text}
              </p>
            )}
            <Button onClick={handleSave} variant="primary" size="lg" className="self-start">
              {t('settings.save')}
            </Button>
          </div>
        </Card>
        </div>
      </div>
    </AppShell>
  );
}
