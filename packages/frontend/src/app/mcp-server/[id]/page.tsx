'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { mcpServers, connectors as connectorsApi, mcpKeys } from '@/lib/api';
import { NavBar } from '@/components/nav-bar';
import { Footer } from '@/components/footer';

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
      setAllConnectors(conns);
      setAssignedIds(new Set(srv.connectors?.map((c: any) => c.connector.id) || []));
    }).catch(() => {}).finally(() => setLoading(false));
  }, [token, id]);

  const apiUrl = typeof window !== 'undefined'
    ? `${window.location.protocol}//${window.location.hostname}:4000`
    : 'http://localhost:4000';

  const handleSave = async () => {
    if (!token || !id) return;
    try {
      const updated = await mcpServers.update(id, {
        name: editName.trim(),
        description: editDescription.trim() || undefined,
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

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--background)] flex flex-col">
        <NavBar breadcrumbs={[{ label: 'MCP Servers', href: '/mcp-server' }]} title="Loading..." />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 flex-1 w-full">
          <div className="animate-pulse space-y-6">
            <div className="h-8 bg-[var(--muted)] rounded w-1/3" />
            <div className="h-40 bg-[var(--muted)] rounded" />
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  if (!server) {
    return (
      <div className="min-h-screen bg-[var(--background)] flex flex-col">
        <NavBar breadcrumbs={[{ label: 'MCP Servers', href: '/mcp-server' }]} title="Not Found" />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 flex-1 w-full text-center">
          <p className="text-[var(--muted-foreground)]">MCP server not found.</p>
        </main>
        <Footer />
      </div>
    );
  }

  const endpointUrl = `${apiUrl}/mcp/${id}`;

  const slug = server.slug || 'my-server';

  const claudeConfigOAuth = `{
  "mcpServers": {
    "${slug}": {
      "type": "url",
      "url": "${endpointUrl}"
    }
  }
}`;

  const claudeConfigApiKey = `{
  "mcpServers": {
    "${slug}": {
      "type": "url",
      "url": "${endpointUrl}",
      "headers": {
        "X-API-Key": "YOUR_MCP_API_KEY"
      }
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

  const cursorDeepLink = () => {
    const config = btoa(JSON.stringify({ url: endpointUrl }));
    return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(slug)}&config=${config}`;
  };

  const vscodeDeepLink = () => {
    const config = { name: slug, type: 'http', url: endpointUrl };
    return `vscode:mcp/install?${encodeURIComponent(JSON.stringify(config))}`;
  };

  const aiClients = [
    { id: 'cursor', name: 'Cursor' },
    { id: 'vscode', name: 'VS Code / Copilot' },
    { id: 'claude-web', name: 'Claude (Web)' },
    { id: 'claude-desktop', name: 'Claude Desktop' },
    { id: 'claude-code', name: 'Claude Code' },
    { id: 'chatgpt', name: 'ChatGPT' },
    { id: 'gemini', name: 'Gemini CLI' },
    { id: 'windsurf', name: 'Windsurf' },
  ];

  const renderModalContent = (clientId: string) => {
    switch (clientId) {
      case 'cursor':
        return (
          <div className="space-y-4">
            <p className="text-sm text-[var(--muted-foreground)]">
              Click the button below to automatically add this MCP server to Cursor. Cursor must be installed on your machine.
            </p>
            <a
              href={cursorDeepLink()}
              className="inline-flex items-center gap-2 bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:opacity-90"
            >
              Open in Cursor
            </a>
          </div>
        );
      case 'vscode':
        return (
          <div className="space-y-4">
            <p className="text-sm text-[var(--muted-foreground)]">
              Click the button below to automatically add this MCP server to VS Code. GitHub Copilot extension required for MCP support.
            </p>
            <a
              href={vscodeDeepLink()}
              className="inline-flex items-center gap-2 bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:opacity-90"
            >
              Open in VS Code
            </a>
          </div>
        );
      case 'claude-web':
        return (
          <div className="space-y-4">
            <p className="text-sm text-[var(--muted-foreground)]">
              1. Click the button below to open Claude&apos;s connector settings.<br />
              2. Click <strong>Add custom connector</strong>.<br />
              3. Paste the MCP endpoint URL below.
            </p>
            <a
              href="https://claude.ai/settings/connectors"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:opacity-90"
            >
              Open Claude Settings
            </a>
            <div>
              <label className="block text-xs text-[var(--muted-foreground)] mb-1">MCP Endpoint URL</label>
              <div className="flex gap-2">
                <code className="flex-1 bg-[var(--muted)] px-3 py-2 rounded text-xs font-mono break-all">{endpointUrl}</code>
                <button
                  onClick={() => handleCopy(endpointUrl, 'modal-endpoint')}
                  className="border border-[var(--border)] px-3 py-2 rounded text-xs hover:bg-[var(--accent)] flex-shrink-0"
                >
                  {copied === 'modal-endpoint' ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
          </div>
        );
      case 'claude-desktop':
        return (
          <div className="space-y-4">
            <p className="text-sm text-[var(--muted-foreground)]">
              Add this to your <code className="font-mono text-xs bg-[var(--muted)] px-1 rounded">claude_desktop_config.json</code>:
            </p>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-[var(--muted-foreground)]">Config (OAuth)</label>
                <button
                  onClick={() => handleCopy(claudeConfigOAuth, 'modal-claude-oauth')}
                  className="text-xs text-[var(--brand)] hover:underline"
                >
                  {copied === 'modal-claude-oauth' ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <pre className="bg-[var(--muted)] p-3 rounded text-xs overflow-x-auto font-mono">{claudeConfigOAuth}</pre>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-[var(--muted-foreground)]">Config (API Key)</label>
                <button
                  onClick={() => handleCopy(claudeConfigApiKey, 'modal-claude-apikey')}
                  className="text-xs text-[var(--brand)] hover:underline"
                >
                  {copied === 'modal-claude-apikey' ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <pre className="bg-[var(--muted)] p-3 rounded text-xs overflow-x-auto font-mono">{claudeConfigApiKey}</pre>
            </div>
          </div>
        );
      case 'claude-code': {
        const cmd = `claude mcp add --transport http ${slug} ${endpointUrl}`;
        return (
          <div className="space-y-4">
            <p className="text-sm text-[var(--muted-foreground)]">
              Run this command in your terminal:
            </p>
            <div className="flex gap-2">
              <code className="flex-1 bg-[var(--muted)] px-3 py-2 rounded text-xs font-mono break-all">{cmd}</code>
              <button
                onClick={() => handleCopy(cmd, 'modal-claude-code')}
                className="border border-[var(--border)] px-3 py-2 rounded text-xs hover:bg-[var(--accent)] flex-shrink-0"
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
            <p className="text-sm text-[var(--muted-foreground)]">
              1. Click the button below to open ChatGPT&apos;s connector settings.<br />
              2. Click <strong>Add connector</strong> or <strong>Create</strong>.<br />
              3. Paste the MCP endpoint URL below.
            </p>
            <a
              href="https://chatgpt.com/admin/mcp"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:opacity-90"
            >
              Open ChatGPT Settings
            </a>
            <div>
              <label className="block text-xs text-[var(--muted-foreground)] mb-1">MCP Endpoint URL</label>
              <div className="flex gap-2">
                <code className="flex-1 bg-[var(--muted)] px-3 py-2 rounded text-xs font-mono break-all">{endpointUrl}</code>
                <button
                  onClick={() => handleCopy(endpointUrl, 'modal-chatgpt-url')}
                  className="border border-[var(--border)] px-3 py-2 rounded text-xs hover:bg-[var(--accent)] flex-shrink-0"
                >
                  {copied === 'modal-chatgpt-url' ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
          </div>
        );
      case 'gemini': {
        const cmd = `gemini mcp add --transport http ${slug} ${endpointUrl}`;
        return (
          <div className="space-y-4">
            <p className="text-sm text-[var(--muted-foreground)]">
              Run this command in your terminal:
            </p>
            <div className="flex gap-2">
              <code className="flex-1 bg-[var(--muted)] px-3 py-2 rounded text-xs font-mono break-all">{cmd}</code>
              <button
                onClick={() => handleCopy(cmd, 'modal-gemini')}
                className="border border-[var(--border)] px-3 py-2 rounded text-xs hover:bg-[var(--accent)] flex-shrink-0"
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
            <p className="text-sm text-[var(--muted-foreground)]">
              Add this to your <code className="font-mono text-xs bg-[var(--muted)] px-1 rounded">~/.codeium/windsurf/mcp_config.json</code>:
            </p>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-[var(--muted-foreground)]">Config</label>
                <button
                  onClick={() => handleCopy(windsurfConfig, 'modal-windsurf')}
                  className="text-xs text-[var(--brand)] hover:underline"
                >
                  {copied === 'modal-windsurf' ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <pre className="bg-[var(--muted)] p-3 rounded text-xs overflow-x-auto font-mono">{windsurfConfig}</pre>
            </div>
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
    <div className="min-h-screen bg-[var(--background)] flex flex-col">
      <NavBar
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'MCP Servers', href: '/mcp-server' },
        ]}
        title={server.name}
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={handleToggleActive}
              className={`px-3 py-1.5 rounded-md text-xs font-medium border ${
                server.isActive
                  ? 'border-[var(--success)] text-[var(--success)] hover:bg-[var(--success-bg)]'
                  : 'border-[var(--muted-foreground)] text-[var(--muted-foreground)] hover:bg-[var(--accent)]'
              }`}
            >
              {server.isActive ? 'Active' : 'Inactive'}
            </button>
            <button
              onClick={handleDeleteServer}
              className="border border-[var(--destructive)] text-[var(--destructive)] px-3 py-1.5 rounded-md text-xs font-medium hover:bg-[var(--destructive-bg)]"
            >
              Delete
            </button>
          </div>
        }
      />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6 flex-1 w-full">
        {/* Server Info */}
        <div className="border border-[var(--border)] rounded-lg p-6">
          <h3 className="text-lg font-medium mb-4">Server Settings</h3>
          <div className="space-y-4 max-w-md">
            <div>
              <label className="block text-sm font-medium mb-1">Name</label>
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Slug</label>
              <input
                type="text"
                value={server.slug}
                disabled
                className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--muted)] opacity-70 font-mono"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Description</label>
              <input
                type="text"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder="What this MCP server is for"
                className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
              />
            </div>
            {saveMsg && (
              <p className={`text-sm ${saveMsg.startsWith('Error') ? 'text-[var(--destructive)]' : 'text-[var(--success)]'}`}>
                {saveMsg}
              </p>
            )}
            <button
              onClick={handleSave}
              className="bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:opacity-90"
            >
              Save
            </button>
          </div>
        </div>

        {/* Connection Config */}
        <div className="border border-[var(--border)] rounded-lg p-6">
          <h3 className="text-lg font-medium mb-4">Connect Your MCP Client</h3>
          <div className="space-y-5">
            {/* MCP Endpoint */}
            <div>
              <label className="block text-sm text-[var(--muted-foreground)] mb-1">MCP Endpoint</label>
              <div className="flex gap-2">
                <code className="flex-1 bg-[var(--muted)] px-3 py-2 rounded text-sm font-mono break-all">{endpointUrl}</code>
                <button
                  onClick={() => handleCopy(endpointUrl, 'endpoint')}
                  className="border border-[var(--border)] px-3 py-2 rounded text-xs hover:bg-[var(--accent)] flex-shrink-0"
                >
                  {copied === 'endpoint' ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <p className="text-xs text-[var(--muted-foreground)] mt-1">
                Each MCP server has its own unique endpoint. Only tools from assigned connectors are exposed.
              </p>
            </div>

            {/* Quick Connect Grid */}
            <div>
              <h4 className="text-sm font-medium mb-3">Quick Connect</h4>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {aiClients.map((client) => (
                  <button
                    key={client.id}
                    onClick={() => setConnectClient(client.id)}
                    className="flex items-center justify-center gap-2 border border-[var(--border)] rounded-lg px-3 py-3 text-sm font-medium hover:bg-[var(--accent)] hover:border-[var(--brand)] transition-colors"
                  >
                    {client.name}
                  </button>
                ))}
              </div>
            </div>

            {/* Manual Config (collapsible) */}
            <details className="group">
              <summary className="text-sm font-medium cursor-pointer text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors">
                Manual Configuration (Advanced)
              </summary>
              <div className="mt-3 space-y-4">
                {/* OAuth config */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-sm font-medium">OAuth (Claude Desktop, ChatGPT, Cursor)</h4>
                    <button
                      onClick={() => handleCopy(claudeConfigOAuth, 'claude-oauth')}
                      className="text-xs text-[var(--brand)] hover:underline"
                    >
                      {copied === 'claude-oauth' ? 'Copied!' : 'Copy config'}
                    </button>
                  </div>
                  <pre className="bg-[var(--muted)] p-4 rounded text-xs overflow-x-auto font-mono">{claudeConfigOAuth}</pre>
                  <p className="text-xs text-[var(--muted-foreground)] mt-2">
                    The client will auto-discover OAuth endpoints and prompt you to log in.
                    Requires <code className="font-mono bg-[var(--muted)] px-1 rounded">MCP_AUTH_MODE=oauth2</code> or <code className="font-mono bg-[var(--muted)] px-1 rounded">both</code>.
                  </p>
                </div>

                {/* API Key config */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-sm font-medium">API Key (Claude Code, custom clients)</h4>
                    <button
                      onClick={() => handleCopy(claudeConfigApiKey, 'claude-apikey')}
                      className="text-xs text-[var(--brand)] hover:underline"
                    >
                      {copied === 'claude-apikey' ? 'Copied!' : 'Copy config'}
                    </button>
                  </div>
                  <pre className="bg-[var(--muted)] p-4 rounded text-xs overflow-x-auto font-mono">{claudeConfigApiKey}</pre>
                  <p className="text-xs text-[var(--muted-foreground)] mt-2">
                    Replace <code className="font-mono bg-[var(--muted)] px-1 rounded">YOUR_MCP_API_KEY</code> with a key generated below.
                    Requires <code className="font-mono bg-[var(--muted)] px-1 rounded">MCP_AUTH_MODE=legacy</code> or <code className="font-mono bg-[var(--muted)] px-1 rounded">both</code>.
                  </p>
                </div>
              </div>
            </details>
          </div>
        </div>

        {/* Connect Modal */}
        {connectClient && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setConnectClient(null)}>
            <div
              className="bg-[var(--background)] border border-[var(--border)] rounded-xl shadow-xl w-full max-w-lg mx-4 p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium">
                  Connect to {aiClients.find((c) => c.id === connectClient)?.name}
                </h3>
                <button
                  onClick={() => setConnectClient(null)}
                  className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] text-xl leading-none"
                >
                  &times;
                </button>
              </div>
              {renderModalContent(connectClient)}
            </div>
          </div>
        )}

        {/* Assigned Connectors */}
        <div className="border border-[var(--border)] rounded-lg p-6">
          <h3 className="text-lg font-medium mb-4">
            Assigned Connectors ({assignedIds.size})
          </h3>
          <p className="text-sm text-[var(--muted-foreground)] mb-4">
            Select which connectors expose their tools through this MCP server.
          </p>
          {allConnectors.length === 0 ? (
            <p className="text-sm text-[var(--muted-foreground)]">No connectors available. Create a connector first.</p>
          ) : (
            <>
              <div className="flex gap-2 mb-3">
                <button
                  onClick={() => setAssignedIds(new Set(allConnectors.map((c) => c.id)))}
                  className="border border-[var(--border)] px-3 py-1 rounded-md text-xs hover:bg-[var(--accent)]"
                >
                  Select All
                </button>
                <button
                  onClick={() => setAssignedIds(new Set())}
                  className="border border-[var(--border)] px-3 py-1 rounded-md text-xs hover:bg-[var(--accent)]"
                >
                  Deselect All
                </button>
              </div>
              <div className="space-y-2 mb-4">
                {allConnectors.map((c) => (
                  <label
                    key={c.id}
                    className="flex items-center gap-3 p-3 rounded-lg bg-[var(--muted)]/50 hover:bg-[var(--accent)]/50 cursor-pointer transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={assignedIds.has(c.id)}
                      onChange={() => handleToggleConnector(c.id)}
                      className="rounded"
                    />
                    <div className="flex-1">
                      <span className="text-sm font-medium">{c.name}</span>
                      <span className="text-xs text-[var(--muted-foreground)] ml-2">{c.type}</span>
                    </div>
                    <span className="text-xs text-[var(--muted-foreground)]">
                      {(c.tools || []).length} tools
                    </span>
                  </label>
                ))}
              </div>
              <button
                onClick={handleSaveConnectors}
                disabled={saving}
                className="bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Connector Assignments'}
              </button>
            </>
          )}
        </div>

        {/* API Keys */}
        <div className="border border-[var(--border)] rounded-lg p-6">
          <h3 className="text-lg font-medium mb-4">API Keys</h3>
          <p className="text-sm text-[var(--muted-foreground)] mb-4">
            Generate API keys scoped to this MCP server. Only tools from assigned connectors will be available.
          </p>

          <div className="space-y-3 mb-4">
            <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
              <div className="flex-1 sm:max-w-sm">
                <label className="block text-sm font-medium mb-1">Key Label</label>
                <input
                  type="text"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  placeholder="e.g. Claude Desktop, Cursor"
                  className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                />
              </div>
              <button
                onClick={handleGenerateKey}
                disabled={!newKeyName.trim()}
                className="bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50"
              >
                Generate Key
              </button>
            </div>

            {generatedKey && (
              <div className="border border-[var(--success-border)] bg-[var(--success-bg)] rounded-md p-3">
                <p className="text-xs font-medium text-[var(--success-text)] mb-1">
                  Copy this key now! It will not be shown again.
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs font-mono bg-[var(--background)] px-3 py-2 rounded border border-[var(--border)] select-all break-all">
                    {generatedKey}
                  </code>
                  <button
                    onClick={() => { navigator.clipboard.writeText(generatedKey); setKeyMsg('Copied!'); }}
                    className="border border-[var(--border)] px-3 py-1.5 rounded text-xs hover:bg-[var(--accent)]"
                  >
                    Copy
                  </button>
                </div>
              </div>
            )}

            {keyMsg && (
              <p className={`text-sm ${keyMsg.startsWith('Error') ? 'text-[var(--destructive)]' : 'text-[var(--success)]'}`}>
                {keyMsg}
              </p>
            )}
          </div>

          {/* Key list */}
          {server.apiKeys && server.apiKeys.length > 0 && (
            <>
              {/* Desktop table */}
              <div className="hidden sm:block border border-[var(--border)] rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-[var(--muted)]">
                    <tr>
                      <th className="text-left px-4 py-2 font-medium text-xs">Label</th>
                      <th className="text-left px-4 py-2 font-medium text-xs">Key</th>
                      <th className="text-left px-4 py-2 font-medium text-xs">Status</th>
                      <th className="text-left px-4 py-2 font-medium text-xs">Last Used</th>
                      <th className="text-right px-4 py-2 font-medium text-xs">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {server.apiKeys.map((k: any) => (
                      <tr key={k.id} className="border-t border-[var(--border)]">
                        <td className="px-4 py-2 text-sm">{k.name}</td>
                        <td className="px-4 py-2 font-mono text-xs text-[var(--muted-foreground)]">
                          mcp_{'*'.repeat(24)}{k.key.slice(-8)}
                        </td>
                        <td className="px-4 py-2">
                          <span className={`text-xs px-1.5 py-0.5 rounded ${k.isActive ? 'bg-[var(--success-bg)] text-[var(--success-text)]' : 'bg-[var(--muted)] text-[var(--muted-foreground)]'}`}>
                            {k.isActive ? 'active' : 'revoked'}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-xs text-[var(--muted-foreground)]">
                          {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : 'never'}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <div className="flex gap-1 justify-end">
                            {k.isActive && (
                              <button
                                onClick={() => handleRevokeKey(k.id)}
                                className="border border-[var(--border)] px-2 py-1 rounded text-xs hover:bg-[var(--accent)]"
                              >
                                Revoke
                              </button>
                            )}
                            <button
                              onClick={() => handleDeleteKey(k.id)}
                              className="border border-[var(--destructive)] text-[var(--destructive)] px-2 py-1 rounded text-xs hover:bg-[var(--destructive-bg)]"
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* Mobile card layout */}
              <div className="sm:hidden space-y-3">
                {server.apiKeys.map((k: any) => (
                  <div key={k.id} className="border border-[var(--border)] rounded-lg p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">{k.name}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded ${k.isActive ? 'bg-[var(--success-bg)] text-[var(--success-text)]' : 'bg-[var(--muted)] text-[var(--muted-foreground)]'}`}>
                        {k.isActive ? 'active' : 'revoked'}
                      </span>
                    </div>
                    <p className="font-mono text-xs text-[var(--muted-foreground)] break-all">
                      mcp_{'*'.repeat(16)}{k.key.slice(-8)}
                    </p>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-[var(--muted-foreground)]">
                        Last used: {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : 'never'}
                      </span>
                      <div className="flex gap-1">
                        {k.isActive && (
                          <button
                            onClick={() => handleRevokeKey(k.id)}
                            className="border border-[var(--border)] px-2 py-1 rounded text-xs hover:bg-[var(--accent)]"
                          >
                            Revoke
                          </button>
                        )}
                        <button
                          onClick={() => handleDeleteKey(k.id)}
                          className="border border-[var(--destructive)] text-[var(--destructive)] px-2 py-1 rounded text-xs hover:bg-[var(--destructive-bg)]"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Active Tools */}
        <div className="border border-[var(--border)] rounded-lg p-6">
          <h3 className="text-lg font-medium mb-4">Active Tools ({toolsList.length})</h3>
          {toolsList.length === 0 ? (
            <p className="text-sm text-[var(--muted-foreground)]">
              No tools available. Assign connectors with enabled tools above.
            </p>
          ) : (
            <div className="space-y-2">
              {toolsList.map((t: any) => (
                <div key={t.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-3 p-3 bg-[var(--muted)] rounded-lg">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${t.isEnabled ? 'bg-[var(--success)]' : 'bg-[var(--muted-foreground)]'}`} />
                    <span className="font-mono text-sm font-medium break-all">{t.name}</span>
                  </div>
                  <div className="flex items-center justify-between sm:justify-end gap-2 pl-4 sm:pl-0">
                    <span className="text-xs text-[var(--muted-foreground)] truncate">
                      {t.connectorName}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded flex-shrink-0 ${t.isEnabled ? 'bg-[var(--success-bg)] text-[var(--success-text)]' : 'bg-[var(--muted)] text-[var(--muted-foreground)]'}`}>
                      {t.isEnabled ? 'enabled' : 'disabled'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
