'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { connectors } from '@/lib/api';
import { NavBar } from '@/components/nav-bar';

export default function McpServerPage() {
  const { token } = useAuth();
  const [toolsList, setToolsList] = useState<any[]>([]);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    if (!token) return;
    connectors.list(token).then((list) => {
      const allTools: any[] = [];
      for (const c of list) {
        for (const t of c.tools || []) {
          allTools.push({ ...t, connectorName: c.name, connectorType: c.type });
        }
      }
      setToolsList(allTools);
    }).catch(() => {});
  }, [token]);

  const apiUrl = typeof window !== 'undefined'
    ? `${window.location.protocol}//${window.location.hostname}:4000`
    : 'http://localhost:4000';

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  };

  const claudeConfig = `{
  "mcpServers": {
    "anything-to-mcp": {
      "type": "url",
      "url": "${apiUrl}/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      }
    }
  }
}`;

  return (
    <div className="min-h-screen bg-[var(--background)]">
      <NavBar
        breadcrumbs={[{ label: 'Dashboard', href: '/' }]}
        title="MCP Server"
      />

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-6">
        {/* Server Status */}
        <div className="border border-[var(--border)] rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-medium">Server Status</h3>
            <span className="flex items-center gap-2 text-sm text-[var(--success)] font-medium">
              <span className="w-2 h-2 bg-[var(--success)] rounded-full animate-pulse"></span>
              Running
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-[var(--muted-foreground)] mb-1">MCP Endpoint (Streamable HTTP)</label>
              <div className="flex gap-2">
                <code className="flex-1 bg-[var(--muted)] px-3 py-2 rounded text-sm font-mono">{apiUrl}/mcp</code>
                <button
                  onClick={() => handleCopy(`${apiUrl}/mcp`, 'endpoint')}
                  className="border border-[var(--border)] px-3 py-2 rounded text-xs hover:bg-[var(--accent)]"
                >
                  {copied === 'endpoint' ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-sm text-[var(--muted-foreground)] mb-1">Server Name</label>
              <code className="block bg-[var(--muted)] px-3 py-2 rounded text-sm font-mono">anything-to-mcp v0.1.0</code>
            </div>
          </div>
        </div>

        {/* Connect Your MCP Client */}
        <div className="border border-[var(--border)] rounded-lg p-6">
          <h3 className="text-lg font-medium mb-4">Connect Your MCP Client</h3>

          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm font-medium">Claude Desktop / Claude Code</h4>
                <button
                  onClick={() => handleCopy(claudeConfig, 'claude')}
                  className="text-xs text-[var(--brand)] hover:underline"
                >
                  {copied === 'claude' ? 'Copied!' : 'Copy config'}
                </button>
              </div>
              <pre className="bg-[var(--muted)] p-4 rounded text-xs overflow-x-auto font-mono">{claudeConfig}</pre>
            </div>

            <div>
              <h4 className="text-sm font-medium mb-2">Cursor IDE</h4>
              <div className="bg-[var(--muted)] p-4 rounded text-sm">
                <p>Settings &rarr; MCP &rarr; Add Server &rarr; URL: <code className="font-mono text-xs">{apiUrl}/mcp</code></p>
              </div>
            </div>

            <div>
              <h4 className="text-sm font-medium mb-2">API Key / Token</h4>
              <p className="text-sm text-[var(--muted-foreground)]">
                Set <code className="font-mono text-xs bg-[var(--muted)] px-1.5 py-0.5 rounded">MCP_BEARER_TOKEN</code> or{' '}
                <code className="font-mono text-xs bg-[var(--muted)] px-1.5 py-0.5 rounded">MCP_API_KEY</code>{' '}
                in your server&apos;s environment variables to secure the MCP endpoint.
              </p>
            </div>
          </div>
        </div>

        {/* Active Tools */}
        <div className="border border-[var(--border)] rounded-lg p-6">
          <h3 className="text-lg font-medium mb-4">Active Tools ({toolsList.length})</h3>
          {toolsList.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-[var(--muted-foreground)] text-sm">
                No tools configured yet. Add a connector and import its spec to generate MCP tools.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {toolsList.map((t) => (
                <div key={t.id} className="flex items-center justify-between p-3 bg-[var(--muted)] rounded-lg">
                  <div className="flex items-center gap-3">
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${t.isEnabled ? 'bg-[var(--success)]' : 'bg-[var(--muted-foreground)]'}`} />
                    <span className="font-mono text-sm font-medium">{t.name}</span>
                    <span className="text-xs text-[var(--muted-foreground)]">
                      {t.connectorName} / {t.connectorType}
                    </span>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded ${t.isEnabled ? 'bg-[var(--success-bg)] text-[var(--success-text)]' : 'bg-[var(--muted)] text-[var(--muted-foreground)]'}`}>
                    {t.isEnabled ? 'enabled' : 'disabled'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
