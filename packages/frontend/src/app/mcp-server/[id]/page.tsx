'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { mcpServers, connectors as connectorsApi, mcpKeys } from '@/lib/api';
import { AppShell } from '@/components/app-shell';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge, StatusPill, type Tone } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export default function McpServerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { token } = useAuth();
  const router = useRouter();

  const [server, setServer] = useState<any>(null);
  const [allConnectors, setAllConnectors] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Edit state
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editInstructions, setEditInstructions] = useState('');
  const [saveMsg, setSaveMsg] = useState('');

  // API key state
  const [newKeyName, setNewKeyName] = useState('');
  const [generatedKey, setGeneratedKey] = useState('');
  const [keyMsg, setKeyMsg] = useState('');

  // Connector assignment state
  const [assignedIds, setAssignedIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const [copied, setCopied] = useState('');
  const [connectClient, setConnectClient] = useState<string | null>(null);

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
      setAllConnectors(conns);
      setAssignedIds(new Set(srv.connectors?.map((c: any) => c.connector.id) || []));
    }).catch(() => {}).finally(() => setLoading(false));
  }, [token, id]);

  const apiUrl = typeof window !== 'undefined'
    ? window.location.hostname === 'localhost'
      ? `${window.location.protocol}//${window.location.hostname}:4000`
      : window.location.origin
    : 'http://localhost:4000';

  const handleSave = async () => {
    if (!token || !id) return;
    try {
      const updated = await mcpServers.update(id, {
        name: editName.trim(),
        description: editDescription.trim() || undefined,
        instructions: editInstructions.trim() || undefined,
      }, token);
      setServer((prev: any) => ({ ...prev, ...updated }));
      setSaveMsg('Saved');
      setTimeout(() => setSaveMsg(''), 2000);
    } catch (err: any) {
      setSaveMsg(`Error: ${err.message}`);
    }
  };

  const handleToggleActive = async () => {
    if (!token || !id || !server) return;
    try {
      const updated = await mcpServers.update(id, { isActive: !server.isActive }, token);
      setServer((prev: any) => ({ ...prev, ...updated }));
    } catch {}
  };

  const handleToggleConnector = (connectorId: string) => {
    setAssignedIds((prev) => {
      const next = new Set(prev);
      if (next.has(connectorId)) next.delete(connectorId);
      else next.add(connectorId);
      return next;
    });
  };

  const handleSaveConnectors = async () => {
    if (!token || !id) return;
    setSaving(true);
    try {
      await mcpServers.assignConnectors(id, Array.from(assignedIds), token);
      setSaveMsg('Connectors updated');
      setTimeout(() => setSaveMsg(''), 2000);
    } catch (err: any) {
      setSaveMsg(`Error: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleGenerateKey = async () => {
    if (!token || !newKeyName.trim()) return;
    try {
      const result = await mcpKeys.generate(newKeyName.trim(), token, id);
      setGeneratedKey(result.key);
      setNewKeyName('');
      setKeyMsg('Key generated! Copy it now — it will not be shown again.');
      // Reload server to refresh key list
      const srv = await mcpServers.get(id, token);
      setServer(srv);
    } catch (err: any) {
      setKeyMsg(`Error: ${err.message}`);
    }
  };

  const handleRevokeKey = async (keyId: string) => {
    if (!token) return;
    try {
      await mcpKeys.revoke(keyId, token);
      const srv = await mcpServers.get(id, token);
      setServer(srv);
      setKeyMsg('Key revoked');
    } catch (err: any) {
      setKeyMsg(`Error: ${err.message}`);
    }
  };

  const handleDeleteKey = async (keyId: string) => {
    if (!token || !confirm('Delete this API key permanently?')) return;
    try {
      await mcpKeys.delete(keyId, token);
      const srv = await mcpServers.get(id, token);
      setServer(srv);
      setKeyMsg('Key deleted');
    } catch (err: any) {
      setKeyMsg(`Error: ${err.message}`);
    }
  };

  const handleDeleteServer = async () => {
    if (!token || !id || !confirm('Delete this MCP server? API keys will be unlinked.')) return;
    try {
      await mcpServers.delete(id, token);
      router.push('/mcp-server');
    } catch {}
  };

  const handleCopy = async (text: string, label: string) => {
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {}
    if (!ok) {
      // Fallback for non-secure contexts (e.g. plain-HTTP LAN deployments)
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '0';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        ok = document.execCommand('copy');
      } catch {}
      document.body.removeChild(ta);
    }
    if (ok) {
      setCopied(label);
      setTimeout(() => setCopied(''), 2000);
    }
  };

  if (loading) {
    return (
      <AppShell backTo={{ label: 'MCP Servers', href: '/mcp-server' }} title="Loading...">
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
      <AppShell backTo={{ label: 'MCP Servers', href: '/mcp-server' }} title="Not Found">
        <Card className="p-10 text-center">
          <p className="text-[var(--text-3)]">MCP server not found.</p>
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
  // configuration"). For Claude Desktop use the Settings → Connectors UI, or
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

  const cursorDeepLink = () => {
    const config = btoa(JSON.stringify({ url: endpointUrl }));
    return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(slug)}&config=${config}`;
  };

  const vscodeDeepLink = () => {
    const config = { name: slug, type: 'http', url: endpointUrl };
    return `vscode:mcp/install?${encodeURIComponent(JSON.stringify(config))}`;
  };

  const aiClients: { id: string; name: string; init: string; tone: Tone }[] = [
    { id: 'cursor', name: 'Cursor', init: 'Cu', tone: 'info' },
    { id: 'vscode', name: 'VS Code', init: 'VS', tone: 'purple' },
    { id: 'copilot', name: 'GitHub Copilot', init: 'Co', tone: 'neutral' },
    { id: 'claude-web', name: 'Claude (Web)', init: 'Cl', tone: 'warn' },
    { id: 'claude-desktop', name: 'Claude Desktop', init: 'Cl', tone: 'warn' },
    { id: 'claude-code', name: 'Claude Code', init: 'Cl', tone: 'warn' },
    { id: 'chatgpt', name: 'ChatGPT', init: 'GP', tone: 'emerald' },
    { id: 'gemini', name: 'Gemini CLI', init: 'Ge', tone: 'pink' },
    { id: 'windsurf', name: 'Windsurf', init: 'Wi', tone: 'success' },
  ];

  const codeBlock = (text: string, label: string) => (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] text-[var(--text-3)]">{label}</span>
        <button
          onClick={() => handleCopy(text, `modal-${label}`)}
          className="text-[12px] font-semibold text-[var(--brand)] hover:underline"
        >
          {copied === `modal-${label}` ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto rounded-[10px] bg-[#0c0f16] p-[13px] font-mono text-[12px] leading-[1.6] text-[#cdd6e8]">{text}</pre>
    </div>
  );

  const endpointRow = (copyKey: string) => (
    <div>
      <label className="mb-1.5 block text-[11px] text-[var(--text-3)]">MCP Endpoint URL</label>
      <div className="flex gap-2">
        <code className="flex-1 break-all rounded-[8px] border border-[var(--border)] bg-[var(--surface-2)] px-[11px] py-[9px] font-mono text-[12px] text-[var(--text-2)]">{endpointUrl}</code>
        <button
          onClick={() => handleCopy(endpointUrl, copyKey)}
          className={cn(buttonVariants({ variant: 'secondary', size: 'md' }), 'flex-shrink-0')}
        >
          {copied === copyKey ? 'Copied!' : 'Copy'}
        </button>
      </div>
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

  const renderModalContent = (clientId: string) => {
    switch (clientId) {
      case 'cursor':
        return (
          <div className="space-y-4">
            <p className="text-[13px] leading-[1.55] text-[var(--text-2)]">
              Click the button below to automatically add this MCP server to Cursor. Cursor must be installed on your machine.
            </p>
            {linkAction(cursorDeepLink(), 'Open in Cursor')}
          </div>
        );
      case 'vscode':
        return (
          <div className="space-y-4">
            <p className="text-[13px] leading-[1.55] text-[var(--text-2)]">
              Click the button below to automatically add this MCP server to VS Code. GitHub Copilot extension required for MCP support.
            </p>
            {linkAction(vscodeDeepLink(), 'Open in VS Code')}
          </div>
        );
      case 'copilot':
        return (
          <div className="space-y-4">
            <p className="text-[13px] leading-[1.55] text-[var(--text-2)]">
              GitHub Copilot supports remote MCP servers in <strong>VS Code</strong>,{' '}
              <strong>Visual Studio</strong> (desktop), JetBrains, Eclipse and Xcode.
              Add the config below to the matching file for your IDE, then start the
              server from the Copilot Chat → <strong>Tools</strong> menu.
            </p>
            {codeBlock(copilotConfig, 'copilot-oauth')}
            <div className="space-y-1 text-[12px] leading-[1.6] text-[var(--text-3)]">
              <div><strong className="text-[var(--text-2)]">VS Code:</strong> workspace <code className="rounded bg-[var(--surface-2)] px-1 font-mono">.vscode/mcp.json</code> (or use the one-click button below).</div>
              <div><strong className="text-[var(--text-2)]">Visual Studio (desktop):</strong> <code className="rounded bg-[var(--surface-2)] px-1 font-mono">{'<solution>\\.mcp.json'}</code> or <code className="rounded bg-[var(--surface-2)] px-1 font-mono">%USERPROFILE%\\.mcp.json</code>.</div>
              <div><strong className="text-[var(--text-2)]">JetBrains / Eclipse / Xcode:</strong> Copilot Chat → MCP settings → add server, paste the endpoint URL.</div>
            </div>
            {linkAction(vscodeDeepLink(), 'One-click add to VS Code')}
            <details className="group pt-1">
              <summary className="cursor-pointer text-xs font-medium text-[var(--text-3)] hover:text-[var(--text)]">
                Using an API key instead of OAuth?
              </summary>
              <div className="mt-3">{codeBlock(copilotConfigApiKey, 'copilot-apikey')}</div>
            </details>
          </div>
        );
      case 'claude-web':
        return (
          <div className="space-y-4">
            <p className="text-[13px] leading-[1.55] text-[var(--text-2)]">
              1. Click the button below to open Claude&apos;s connector settings.<br />
              2. Click <strong>Add custom connector</strong>.<br />
              3. Paste the MCP endpoint URL below.
            </p>
            {linkAction('https://claude.ai/customize/connectors', 'Open Claude Settings', true)}
            {endpointRow('modal-endpoint')}
          </div>
        );
      case 'claude-desktop':
        return (
          <div className="space-y-4">
            <p className="text-[13px] leading-[1.55] text-[var(--text-2)]">
              <strong>Recommended:</strong> add this server from Claude Desktop&apos;s
              built-in connector settings — it runs the OAuth login for you, with
              no file editing. Editing <code className="rounded bg-[var(--surface-2)] px-1 font-mono text-xs">claude_desktop_config.json</code> with
              a remote URL does <em>not</em> work: that file only launches local
              commands, so Claude skips it as &ldquo;not a valid MCP server configuration&rdquo;.
            </p>
            <p className="text-[13px] leading-[1.55] text-[var(--text-2)]">
              1. Open <strong>Settings → Connectors</strong> (button below).<br />
              2. Click <strong>Add custom connector</strong>.<br />
              3. Paste the MCP endpoint URL below.
            </p>
            {linkAction('https://claude.ai/customize/connectors', 'Open Claude Settings', true)}
            {endpointRow('modal-claude-desktop-url')}

            <details className="group pt-1">
              <summary className="cursor-pointer text-xs font-medium text-[var(--text-3)] hover:text-[var(--text)]">
                Prefer the config file? Use the mcp-remote bridge
              </summary>
              <div className="mt-3 space-y-4">
                <p className="text-xs leading-[1.55] text-[var(--text-3)]">
                  Requires Node.js. The <code className="rounded bg-[var(--surface-2)] px-1 font-mono">mcp-remote</code> package
                  wraps the remote server as a local command. Add to <code className="rounded bg-[var(--surface-2)] px-1 font-mono">claude_desktop_config.json</code> and
                  restart Claude Desktop.
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
              Run this command in your terminal:
            </p>
            <div className="flex gap-2">
              <code className="flex-1 break-all rounded-[8px] border border-[var(--border)] bg-[var(--surface-2)] px-[11px] py-[9px] font-mono text-[12px] text-[var(--text-2)]">{cmd}</code>
              <button
                onClick={() => handleCopy(cmd, 'modal-claude-code')}
                className={cn(buttonVariants({ variant: 'secondary', size: 'md' }), 'flex-shrink-0')}
              >
                {copied === 'modal-claude-code' ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>
        );
      }
      case 'chatgpt':
        return (
          <div className="space-y-4">
            <p className="text-[13px] leading-[1.55] text-[var(--text-2)]">
              1. Click the button below to open ChatGPT&apos;s connector settings.<br />
              2. Click <strong>Add connector</strong> or <strong>Create</strong>.<br />
              3. Paste the MCP endpoint URL below.
            </p>
            {linkAction('https://chatgpt.com/admin/mcp', 'Open ChatGPT Settings', true)}
            {endpointRow('modal-chatgpt-url')}
          </div>
        );
      case 'gemini': {
        const cmd = `gemini mcp add --transport http ${slug} ${endpointUrl}`;
        return (
          <div className="space-y-4">
            <p className="text-[13px] leading-[1.55] text-[var(--text-2)]">
              Run this command in your terminal:
            </p>
            <div className="flex gap-2">
              <code className="flex-1 break-all rounded-[8px] border border-[var(--border)] bg-[var(--surface-2)] px-[11px] py-[9px] font-mono text-[12px] text-[var(--text-2)]">{cmd}</code>
              <button
                onClick={() => handleCopy(cmd, 'modal-gemini')}
                className={cn(buttonVariants({ variant: 'secondary', size: 'md' }), 'flex-shrink-0')}
              >
                {copied === 'modal-gemini' ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>
        );
      }
      case 'windsurf':
        return (
          <div className="space-y-4">
            <p className="text-[13px] leading-[1.55] text-[var(--text-2)]">
              Add this to your <code className="rounded bg-[var(--surface-2)] px-1 font-mono text-xs">~/.codeium/windsurf/mcp_config.json</code>:
            </p>
            {codeBlock(windsurfConfig, 'windsurf')}
          </div>
        );
      default:
        return null;
    }
  };

  // Tools from assigned connectors
  const assignedConnectors = allConnectors.filter((c) => assignedIds.has(c.id));
  const toolsList = assignedConnectors.flatMap((c) =>
    (c.tools || []).map((t: any) => ({ ...t, connectorName: c.name, connectorType: c.type })),
  );

  return (
    <AppShell
      backTo={{ label: 'MCP Servers', href: '/mcp-server' }}
      title={server.name}
      maxWidth={1200}
      actions={
        <div className="flex items-center gap-2">
          <button
            onClick={handleToggleActive}
            className={cn(
              'h-9 rounded-[9px] border px-[13px] text-[12.5px] font-semibold transition-colors',
              server.isActive
                ? 'border-[var(--ok)] text-[var(--ok)] hover:bg-[var(--t-success-bg)]'
                : 'border-[var(--border)] text-[var(--text-3)] hover:bg-[var(--surface-2)]'
            )}
          >
            {server.isActive ? 'Active' : 'Inactive'}
          </button>
          <button
            onClick={handleDeleteServer}
            className="h-9 rounded-[9px] border border-[var(--danger)] px-[13px] text-[12.5px] font-semibold text-[var(--danger)] transition-colors hover:bg-[var(--t-danger-bg)]"
          >
            Delete
          </button>
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
                {server.isActive ? 'Active' : 'Inactive'}
              </StatusPill>
            </div>
            <div className="mt-0.5 break-all font-mono text-[12.5px] text-[var(--text-3)]">{endpointUrl}</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
        {/* Connect a client — sticky right column on desktop, shown first on mobile */}
        <aside className="order-1 flex flex-col gap-4 lg:order-2 lg:sticky lg:top-4">
        <Card className="p-[22px]">
          <div className="mb-[14px] text-sm font-semibold">Connect your MCP client</div>
          <div className="mb-1.5 text-[11px] text-[var(--text-3)]">MCP endpoint</div>
          <div className="mb-[18px] flex gap-2">
            <code className="flex-1 break-all rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-[10px] font-mono text-[12.5px] text-[var(--text-2)]">{endpointUrl}</code>
            <button
              onClick={() => handleCopy(endpointUrl, 'endpoint')}
              className={cn(buttonVariants({ variant: 'secondary', size: 'md' }), 'flex-shrink-0')}
            >
              {copied === 'endpoint' ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <p className="mb-3 text-[11.5px] text-[var(--text-3)]">
            Each MCP server has its own unique endpoint. Only tools from assigned connectors are exposed.
          </p>

          <div className="mb-[10px] text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-3)]">
            Quick Connect
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
            {aiClients.map((client) => (
              <button
                key={client.id}
                onClick={() => setConnectClient(client.id)}
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
              Manual Configuration (Advanced)
            </summary>
            <div className="mt-3 space-y-4">
              {/* OAuth config */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h4 className="text-sm font-medium">OAuth (Cursor, VS Code, Claude Code)</h4>
                  <button
                    onClick={() => handleCopy(claudeConfigOAuth, 'claude-oauth')}
                    className="text-[12px] font-semibold text-[var(--brand)] hover:underline"
                  >
                    {copied === 'claude-oauth' ? 'Copied!' : 'Copy config'}
                  </button>
                </div>
                <pre className="overflow-x-auto rounded-[10px] bg-[#0c0f16] p-[13px] font-mono text-[12px] leading-[1.6] text-[#cdd6e8]">{claudeConfigOAuth}</pre>
                <p className="mt-2 text-[11.5px] text-[var(--text-3)]">
                  The client will auto-discover OAuth endpoints and prompt you to log in.
                  Requires <code className="rounded bg-[var(--surface-2)] px-1 font-mono">MCP_AUTH_MODE=oauth2</code> or <code className="rounded bg-[var(--surface-2)] px-1 font-mono">both</code>.
                </p>
              </div>

              {/* API Key config */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h4 className="text-sm font-medium">API Key (Claude Code, custom clients)</h4>
                  <button
                    onClick={() => handleCopy(claudeConfigApiKey, 'claude-apikey')}
                    className="text-[12px] font-semibold text-[var(--brand)] hover:underline"
                  >
                    {copied === 'claude-apikey' ? 'Copied!' : 'Copy config'}
                  </button>
                </div>
                <pre className="overflow-x-auto rounded-[10px] bg-[#0c0f16] p-[13px] font-mono text-[12px] leading-[1.6] text-[#cdd6e8]">{claudeConfigApiKey}</pre>
                <p className="mt-2 text-[11.5px] text-[var(--text-3)]">
                  Replace <code className="rounded bg-[var(--surface-2)] px-1 font-mono">YOUR_MCP_API_KEY</code> with a key generated below.
                  Requires <code className="rounded bg-[var(--surface-2)] px-1 font-mono">MCP_AUTH_MODE=legacy</code> or <code className="rounded bg-[var(--surface-2)] px-1 font-mono">both</code>.
                </p>
              </div>
            </div>
          </details>
        </Card>
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
                  Connect to {aiClients.find((c) => c.id === connectClient)?.name}
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
            <div className="text-sm font-semibold">Assigned connectors ({assignedIds.size})</div>
            {allConnectors.length > 0 && (
              <div className="flex gap-1.5">
                <button
                  onClick={() => setAssignedIds(new Set(allConnectors.map((c) => c.id)))}
                  className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] px-[10px] py-[5px] text-[12px] text-[var(--text-2)] hover:border-[var(--border-strong)]"
                >
                  Select all
                </button>
                <button
                  onClick={() => setAssignedIds(new Set())}
                  className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] px-[10px] py-[5px] text-[12px] text-[var(--text-2)] hover:border-[var(--border-strong)]"
                >
                  Deselect all
                </button>
              </div>
            )}
          </div>
          <p className="mb-[14px] text-[12.5px] text-[var(--text-3)]">
            Select which connectors expose their tools through this server.
          </p>
          {allConnectors.length === 0 ? (
            <p className="text-[12.5px] text-[var(--text-3)]">No connectors available. Create a connector first.</p>
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
                      <span className="w-[60px] text-right text-[12px] text-[var(--text-3)]">
                        {(c.tools || []).length} tools
                      </span>
                    </label>
                  );
                })}
              </div>
              <Button onClick={handleSaveConnectors} disabled={saving} variant="primary" size="lg" className="mt-1.5">
                {saving ? 'Saving...' : 'Save assignments'}
              </Button>
            </>
          )}
        </Card>

        {/* API Keys */}
        <Card className="p-[22px]">
          <div className="mb-1.5 text-sm font-semibold">API keys</div>
          <p className="mb-[14px] text-[12.5px] text-[var(--text-3)]">
            Keys scoped to this server. Only tools from assigned connectors are available.
          </p>

          <div className="mb-4 space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1 sm:max-w-sm">
                <label className="mb-1.5 block text-[12.5px] font-medium">Key label</label>
                <input
                  type="text"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  placeholder="e.g. Claude Desktop, Cursor"
                  className="h-[38px] w-full rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13.5px] outline-none focus:border-[var(--brand)]"
                />
              </div>
              <Button onClick={handleGenerateKey} disabled={!newKeyName.trim()} variant="primary" size="lg">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                Generate
              </Button>
            </div>

            {generatedKey && (
              <div
                className="rounded-[10px] p-3"
                style={{ background: 'var(--t-success-bg)', border: '1px solid color-mix(in srgb, var(--t-success-fg) 25%, transparent)' }}
              >
                <p className="mb-1 text-[11.5px] font-semibold" style={{ color: 'var(--t-success-fg)' }}>
                  Copy this key now! It will not be shown again.
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 select-all break-all rounded-[8px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 font-mono text-xs">
                    {generatedKey}
                  </code>
                  <button
                    onClick={() => { navigator.clipboard.writeText(generatedKey); setKeyMsg('Copied!'); }}
                    className={cn(buttonVariants({ variant: 'secondary', size: 'md' }), 'flex-shrink-0')}
                  >
                    Copy
                  </button>
                </div>
              </div>
            )}

            {keyMsg && (
              <p className="text-[13px]" style={{ color: keyMsg.startsWith('Error') ? 'var(--danger)' : 'var(--ok)' }}>
                {keyMsg}
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
                      {k.isActive ? 'active' : 'revoked'}
                    </StatusPill>
                    <span className="whitespace-nowrap text-[12px] text-[var(--text-3)]">
                      Used {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : 'never'}
                    </span>
                    <div className="ml-auto flex gap-1 sm:ml-0">
                      {k.isActive && (
                        <button
                          onClick={() => handleRevokeKey(k.id)}
                          className="text-[12px] text-[var(--text-2)] hover:text-[var(--text)] hover:underline"
                        >
                          Revoke
                        </button>
                      )}
                      <button
                        onClick={() => handleDeleteKey(k.id)}
                        className="text-[12px] text-[var(--danger)] hover:underline"
                      >
                        Delete
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
          <div className="mb-[14px] text-sm font-semibold">Active tools ({toolsList.length})</div>
          {toolsList.length === 0 ? (
            <p className="text-[12.5px] text-[var(--text-3)]">
              No tools available. Assign connectors with enabled tools above.
            </p>
          ) : (
            <div className="space-y-2">
              {toolsList.map((t: any) => (
                <div key={t.id} className="flex flex-col gap-1 rounded-[10px] bg-[var(--surface-2)] p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span
                      className="h-2 w-2 flex-shrink-0 rounded-full"
                      style={{ background: t.isEnabled ? 'var(--ok)' : 'var(--text-3)' }}
                    />
                    <span className="break-all font-mono text-[13.5px] font-medium">{t.name}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2 pl-4 sm:justify-end sm:pl-0">
                    <span className="truncate text-[12px] text-[var(--text-3)]">{t.connectorName}</span>
                    <StatusPill tone={t.isEnabled ? 'success' : 'neutral'}>
                      {t.isEnabled ? 'enabled' : 'disabled'}
                    </StatusPill>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Server settings + instructions — pinned to the top of the main column */}
        <Card className="order-first p-[22px]">
          <div className="mb-4 text-sm font-semibold">Server settings</div>
          <div className="flex max-w-[520px] flex-col gap-[14px]">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-[12.5px] font-medium">Name</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="h-[38px] w-full rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13.5px] outline-none focus:border-[var(--brand)]"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-[12.5px] font-medium">Slug</label>
                <input
                  type="text"
                  value={server.slug}
                  disabled
                  className="h-[38px] w-full rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] px-3 font-mono text-[13.5px] text-[var(--text-3)]"
                />
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-[12.5px] font-medium">Description</label>
              <input
                type="text"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder="What this MCP server is for"
                className="h-[38px] w-full rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13.5px] outline-none placeholder:text-[var(--text-3)] focus:border-[var(--brand)]"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[12.5px] font-medium">Instructions</label>
              <textarea
                value={editInstructions}
                onChange={(e) => setEditInstructions(e.target.value)}
                placeholder="Custom instructions sent to AI clients when they connect to this MCP server. These are combined with instructions from assigned connectors."
                rows={4}
                className="w-full resize-y rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 py-[10px] text-[13px] leading-[1.55] text-[var(--text-2)] outline-none placeholder:text-[var(--text-3)] focus:border-[var(--brand)]"
              />
              <p className="mt-1.5 text-[11.5px] text-[var(--text-3)]">
                Sent to AI clients on connect, combined with connector-level instructions.
              </p>
            </div>
            {saveMsg && (
              <p className="text-[13px]" style={{ color: saveMsg.startsWith('Error') ? 'var(--danger)' : 'var(--ok)' }}>
                {saveMsg}
              </p>
            )}
            <Button onClick={handleSave} variant="primary" size="lg" className="self-start">
              Save
            </Button>
          </div>
        </Card>
        </div>
      </div>
    </AppShell>
  );
}
