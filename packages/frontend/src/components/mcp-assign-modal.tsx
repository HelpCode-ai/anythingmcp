'use client';

import { useEffect, useState } from 'react';
import { mcpServers } from '@/lib/api';

interface McpAssignModalProps {
  connectorId: string;
  connectorName: string;
  token: string;
  onDone: (mcpServerId?: string) => void;
  onClose: () => void;
}

export function McpAssignModal({ connectorId, connectorName, token, onDone, onClose }: McpAssignModalProps) {
  const [servers, setServers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createNew, setCreateNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    mcpServers.list(token).then((list) => {
      setServers(list);
      if (list.length === 0) {
        setCreateNew(true);
      }
    }).catch(() => {}).finally(() => setLoading(false));
  }, [token]);

  const filtered = servers.filter((s) =>
    !search || s.name.toLowerCase().includes(search.toLowerCase())
  );

  const handleSubmit = async () => {
    setSaving(true);
    setError('');
    try {
      let targetId: string;

      if (createNew) {
        if (!newName.trim()) {
          setError('Enter a name for the new MCP server');
          setSaving(false);
          return;
        }
        const created = await mcpServers.create({ name: newName.trim() }, token);
        targetId = created.id;
      } else if (selectedId) {
        targetId = selectedId;
      } else {
        setError('Select an MCP server or create a new one');
        setSaving(false);
        return;
      }

      // Get existing connectors for this MCP server, then add the new one
      const srv = await mcpServers.get(targetId, token);
      const existingIds = srv.connectors?.map((c: any) => c.connector.id) || [];
      if (!existingIds.includes(connectorId)) {
        existingIds.push(connectorId);
      }
      await mcpServers.assignConnectors(targetId, existingIds, token);

      onDone(targetId);
    } catch (err: any) {
      setError(err.message || 'Failed to assign connector');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-[var(--background)] border border-[var(--border)] rounded-lg shadow-lg w-full max-w-md mx-4 p-6 max-h-[80vh] flex flex-col">
        <button
          onClick={onClose}
          className="absolute top-3 right-3 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          aria-label="Close"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6 6 18" /><path d="m6 6 12 12" />
          </svg>
        </button>

        <h3 className="text-lg font-semibold mb-1">Add to MCP Server</h3>
        <p className="text-sm text-[var(--muted-foreground)] mb-4">
          Choose which MCP server should expose <strong>{connectorName}</strong> tools to AI agents.
        </p>

        {error && (
          <div className="mb-3 p-2.5 rounded-md bg-[var(--destructive-bg)] text-[var(--destructive-text)] text-sm border border-[var(--destructive-border)]">
            {error}
          </div>
        )}

        {loading ? (
          <div className="py-8 text-center text-sm text-[var(--muted-foreground)]">Loading MCP servers...</div>
        ) : (
          <div className="flex-1 overflow-y-auto min-h-0">
            {/* Existing servers */}
            {servers.length > 0 && (
              <>
                {servers.length > 5 && (
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search MCP servers..."
                    autoComplete="off"
                    className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)] mb-3"
                  />
                )}

                <div className="space-y-2 mb-4">
                  {filtered.map((srv) => {
                    const connCount = srv.connectors?.length || srv._count?.connectors || 0;
                    return (
                      <label
                        key={srv.id}
                        className={`flex items-center gap-3 p-3 rounded-md border cursor-pointer transition-colors ${
                          selectedId === srv.id && !createNew
                            ? 'border-[var(--brand)] bg-[var(--brand-light)]'
                            : 'border-[var(--border)] hover:border-[var(--brand)]'
                        }`}
                        onClick={() => { setSelectedId(srv.id); setCreateNew(false); }}
                      >
                        <input
                          type="radio"
                          name="mcp-server"
                          checked={selectedId === srv.id && !createNew}
                          onChange={() => { setSelectedId(srv.id); setCreateNew(false); }}
                          className="accent-[var(--brand)]"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm truncate">{srv.name}</div>
                          <div className="text-xs text-[var(--muted-foreground)]">
                            {connCount} connector{connCount !== 1 ? 's' : ''}
                            {srv.description && ` · ${srv.description}`}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>

                <div className="border-t border-[var(--border)] pt-3 mb-3">
                  <label
                    className={`flex items-center gap-3 p-3 rounded-md border cursor-pointer transition-colors ${
                      createNew
                        ? 'border-[var(--brand)] bg-[var(--brand-light)]'
                        : 'border-[var(--border)] hover:border-[var(--brand)]'
                    }`}
                    onClick={() => setCreateNew(true)}
                  >
                    <input
                      type="radio"
                      name="mcp-server"
                      checked={createNew}
                      onChange={() => setCreateNew(true)}
                      className="accent-[var(--brand)]"
                    />
                    <div className="flex-1">
                      <div className="font-medium text-sm flex items-center gap-1.5">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M5 12h14" /><path d="M12 5v14" />
                        </svg>
                        Create new MCP server
                      </div>
                    </div>
                  </label>
                </div>
              </>
            )}

            {/* New server name input */}
            {createNew && (
              <div className="mb-3">
                <label className="block text-sm font-medium mb-1">Server name</label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. My API Server"
                  autoFocus
                  className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                />
              </div>
            )}
          </div>
        )}

        <div className="flex gap-3 justify-end pt-3 border-t border-[var(--border)] mt-auto">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-md text-sm border border-[var(--border)] hover:bg-[var(--muted)]"
          >
            Skip for now
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving || (!selectedId && !createNew) || (createNew && !newName.trim())}
            className="bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50"
          >
            {saving ? 'Assigning...' : 'Assign to MCP Server'}
          </button>
        </div>
      </div>
    </div>
  );
}
