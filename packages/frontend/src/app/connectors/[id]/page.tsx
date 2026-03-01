'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { connectors, tools, ai } from '@/lib/api';
import { NavBar } from '@/components/nav-bar';
import { Footer } from '@/components/footer';
import { ToolEditor } from '@/components/tool-editor';

const IMPORT_SOURCES = [
  { id: 'openapi', label: 'OpenAPI / Swagger', placeholder: 'Paste OpenAPI JSON/YAML or enter URL...' },
  { id: 'postman', label: 'Postman Collection', placeholder: 'Paste Postman Collection JSON or enter URL...' },
  { id: 'curl', label: 'cURL Command', placeholder: 'curl -X GET https://api.example.com/users -H "Authorization: Bearer {{token}}"' },
  { id: 'graphql', label: 'GraphQL Introspection', placeholder: 'Enter GraphQL endpoint URL...' },
  { id: 'wsdl', label: 'WSDL', placeholder: 'Enter WSDL URL...' },
  { id: 'json', label: 'JSON Definition', placeholder: '[\n  {\n    "name": "get_users",\n    "description": "Fetch users",\n    "parameters": { "type": "object", "properties": { "limit": { "type": "number" } } },\n    "endpointMapping": { "method": "GET", "path": "/users", "queryParams": { "limit": "$limit" } }\n  }\n]' },
];

export default function ConnectorDetailPage() {
  const { token } = useAuth();
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [connector, setConnector] = useState<any>(null);
  const [toolList, setToolList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editBaseUrl, setEditBaseUrl] = useState('');
  const [editActive, setEditActive] = useState(true);
  const [msg, setMsg] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Tool editor state
  const [showNewTool, setShowNewTool] = useState(false);
  const [editingToolId, setEditingToolId] = useState<string | null>(null);
  const [savingTool, setSavingTool] = useState(false);

  // Tool playground state
  const [testingToolId, setTestingToolId] = useState<string | null>(null);
  const [testParams, setTestParams] = useState('{}');
  const [testRunning, setTestRunning] = useState(false);
  const [toolTestResult, setToolTestResult] = useState<{ ok: boolean; durationMs: number; result?: unknown; error?: string } | null>(null);

  // Import modal
  const [showImport, setShowImport] = useState(false);
  const [importSource, setImportSource] = useState('openapi');
  const [importContent, setImportContent] = useState('');
  const [importUrl, setImportUrl] = useState('');
  const [importing, setImporting] = useState(false);

  // Environment variables
  const [showEnvVars, setShowEnvVars] = useState(false);
  const [envVarEntries, setEnvVarEntries] = useState<{ key: string; value: string }[]>([]);
  const [savingEnvVars, setSavingEnvVars] = useState(false);
  const [enhancingToolId, setEnhancingToolId] = useState<string | null>(null);

  const fetchConnector = async () => {
    if (!token) return;
    try {
      const c = await connectors.get(id, token);
      setConnector(c);
      setEditName(c.name);
      setEditBaseUrl(c.baseUrl);
      setEditActive(c.isActive);
      setToolList(c.tools || []);
      // Load env vars
      const ev = c.envVars as Record<string, string> | null;
      if (ev && typeof ev === 'object') {
        setEnvVarEntries(Object.entries(ev).map(([key, value]) => ({ key, value: String(value) })));
      }
    } catch {
      router.push('/connectors');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchConnector();
  }, [token, id]);

  const handleSave = async () => {
    if (!token) return;
    try {
      await connectors.update(id, { name: editName, baseUrl: editBaseUrl, isActive: editActive }, token);
      setMsg('Connector updated');
      setEditing(false);
      fetchConnector();
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    }
  };

  const handleTest = async () => {
    if (!token) return;
    setTestResult(null);
    try {
      const result = await connectors.test(id, token);
      setTestResult(result);
    } catch (err: any) {
      setTestResult({ ok: false, message: err.message });
    }
  };

  const handleImportSpec = async () => {
    if (!token) return;
    setMsg('Importing specification...');
    try {
      const result = await connectors.importSpec(id, token);
      setMsg(result.message);
      fetchConnector();
    } catch (err: any) {
      setMsg(`Import failed: ${err.message}`);
    }
  };

  const handleImportTools = async () => {
    if (!token) return;
    setImporting(true);
    try {
      const data: { source: string; content?: string; url?: string } = { source: importSource };
      if (importSource === 'curl' || importSource === 'json') {
        data.content = importContent;
      } else if (importUrl) {
        data.url = importUrl;
      } else if (importContent) {
        data.content = importContent;
      }
      const result = await connectors.importTools(id, data, token) as any;
      if (result.error) {
        setMsg(result.error);
      } else {
        setMsg(result.message);
        setShowImport(false);
        setImportContent('');
        setImportUrl('');
        fetchConnector();
      }
    } catch (err: any) {
      setMsg(`Import failed: ${err.message}`);
    } finally {
      setImporting(false);
    }
  };

  const handleDelete = async () => {
    if (!token || !confirm('Delete this connector and all its tools?')) return;
    try {
      await connectors.delete(id, token);
      router.push('/connectors');
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    }
  };

  const handleDeleteTool = async (toolId: string) => {
    if (!token || !confirm('Delete this tool?')) return;
    try {
      await tools.delete(id, toolId, token);
      setToolList((prev) => prev.filter((t) => t.id !== toolId));
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    }
  };

  const handleToggleTool = async (toolId: string, isEnabled: boolean) => {
    if (!token) return;
    try {
      await tools.update(id, toolId, { isEnabled: !isEnabled }, token);
      setToolList((prev) =>
        prev.map((t) => (t.id === toolId ? { ...t, isEnabled: !isEnabled } : t)),
      );
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    }
  };

  const handleTestTool = async (toolId: string) => {
    if (!token) return;
    setTestRunning(true);
    setToolTestResult(null);
    try {
      const params = JSON.parse(testParams);
      const result = await tools.test(id, toolId, params, token);
      setToolTestResult(result);
    } catch (err: any) {
      setToolTestResult({ ok: false, durationMs: 0, error: err.message });
    } finally {
      setTestRunning(false);
    }
  };

  const handleCreateTool = async (data: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    endpointMapping: Record<string, unknown>;
    responseMapping?: Record<string, unknown>;
  }) => {
    if (!token) return;
    setSavingTool(true);
    try {
      await tools.create(id, data, token);
      setShowNewTool(false);
      setMsg('Tool created successfully');
      fetchConnector();
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    } finally {
      setSavingTool(false);
    }
  };

  const handleUpdateTool = async (
    toolId: string,
    data: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      endpointMapping: Record<string, unknown>;
      responseMapping?: Record<string, unknown>;
    },
  ) => {
    if (!token) return;
    setSavingTool(true);
    try {
      await tools.update(id, toolId, data, token);
      setEditingToolId(null);
      setMsg('Tool updated successfully');
      fetchConnector();
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    } finally {
      setSavingTool(false);
    }
  };

  const handleSaveEnvVars = async () => {
    if (!token) return;
    setSavingEnvVars(true);
    try {
      const envVars: Record<string, string> = {};
      for (const entry of envVarEntries) {
        if (entry.key.trim()) {
          envVars[entry.key.trim()] = entry.value;
        }
      }
      await connectors.updateEnvVars(id, envVars, token);
      setMsg('Environment variables saved');
      fetchConnector();
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    } finally {
      setSavingEnvVars(false);
    }
  };

  const handleAiEnhance = async (toolId: string, toolName: string, toolDescription: string) => {
    if (!token) return;
    setEnhancingToolId(toolId);
    try {
      const result: any = await ai.improveDescription(
        { toolName, currentDescription: toolDescription, apiContext: connector?.name || '' },
        token,
      );
      if (result?.description) {
        await tools.update(id, toolId, { description: result.description }, token);
        setToolList((prev) =>
          prev.map((t) => (t.id === toolId ? { ...t, description: result.description } : t)),
        );
        setMsg('Description enhanced by AI');
      }
    } catch (err: any) {
      setMsg(`AI enhance failed: ${err.message}`);
    } finally {
      setEnhancingToolId(null);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--background)] flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block w-6 h-6 border-2 border-[var(--brand)] border-t-transparent rounded-full animate-spin mb-3"></div>
          <p className="text-[var(--muted-foreground)]">Loading...</p>
        </div>
      </div>
    );
  }

  if (!connector) return null;

  return (
    <div className="min-h-screen bg-[var(--background)] flex flex-col">
      <NavBar
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Connectors', href: '/connectors' },
        ]}
        title={connector.name}
        actions={
          <div className="flex gap-2">
            <button
              onClick={handleTest}
              className="border border-[var(--border)] px-3 py-1.5 rounded text-sm hover:bg-[var(--accent)]"
            >
              Test Connection
            </button>
            <button
              onClick={() => setEditing(!editing)}
              className="border border-[var(--border)] px-3 py-1.5 rounded text-sm hover:bg-[var(--accent)]"
            >
              {editing ? 'Cancel' : 'Edit'}
            </button>
            <button
              onClick={handleDelete}
              className="border border-[var(--destructive)] text-[var(--destructive)] px-3 py-1.5 rounded text-sm hover:bg-[var(--destructive-bg)]"
            >
              Delete
            </button>
          </div>
        }
      />

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-6 flex-1 w-full">
        {msg && (
          <div className="p-3 rounded-md bg-[var(--info-bg)] text-[var(--info-text)] text-sm border border-[var(--info-border)]">
            {msg}
            <button onClick={() => setMsg('')} className="ml-2 underline">
              dismiss
            </button>
          </div>
        )}
        {testResult && (
          <div
            className={`p-3 rounded-md text-sm border ${testResult.ok ? 'bg-[var(--success-bg)] text-[var(--success-text)] border-[var(--success-border)]' : 'bg-[var(--destructive-bg)] text-[var(--destructive-text)] border-[var(--destructive-border)]'}`}
          >
            {testResult.message}
          </div>
        )}

        {/* Connector Details */}
        <div className="border border-[var(--border)] rounded-lg p-6">
          <h3 className="text-lg font-medium mb-4">Connector Details</h3>
          {editing ? (
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
                <label className="block text-sm font-medium mb-1">Base URL</label>
                <input
                  type="text"
                  value={editBaseUrl}
                  onChange={(e) => setEditBaseUrl(e.target.value)}
                  className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="isActive"
                  checked={editActive}
                  onChange={(e) => setEditActive(e.target.checked)}
                />
                <label htmlFor="isActive" className="text-sm">Active</label>
              </div>
              <button
                onClick={handleSave}
                className="bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:brightness-90"
              >
                Save Changes
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-[var(--muted-foreground)]">Name</p>
                <p className="font-medium">{connector.name}</p>
              </div>
              <div>
                <p className="text-[var(--muted-foreground)]">Type</p>
                <p className="font-medium">{connector.type}</p>
              </div>
              <div>
                <p className="text-[var(--muted-foreground)]">Base URL</p>
                <p className="font-medium font-mono text-xs break-all">{connector.baseUrl}</p>
              </div>
              <div>
                <p className="text-[var(--muted-foreground)]">Auth Type</p>
                <p className="font-medium">{connector.authType}</p>
              </div>
              <div>
                <p className="text-[var(--muted-foreground)]">Status</p>
                <p className="font-medium">{connector.isActive ? 'Active' : 'Inactive'}</p>
              </div>
              <div>
                <p className="text-[var(--muted-foreground)]">Created</p>
                <p className="font-medium">{new Date(connector.createdAt).toLocaleDateString()}</p>
              </div>
              {connector.specUrl && (
                <div className="col-span-2">
                  <p className="text-[var(--muted-foreground)]">Spec URL</p>
                  <p className="font-medium font-mono text-xs break-all">{connector.specUrl}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Environment Variables */}
        <div className="border border-[var(--border)] rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-lg font-medium">Environment Variables</h3>
              <p className="text-xs text-[var(--muted-foreground)] mt-1">
                Use {'{{VAR_NAME}}'} in URLs, paths, headers, and body fields. Variables are interpolated at runtime.
              </p>
            </div>
            <button
              onClick={() => setShowEnvVars(!showEnvVars)}
              className="border border-[var(--border)] px-3 py-1.5 rounded text-sm hover:bg-[var(--accent)]"
            >
              {showEnvVars ? 'Hide' : `Edit (${envVarEntries.length})`}
            </button>
          </div>

          {showEnvVars && (
            <div className="space-y-3">
              {envVarEntries.map((entry, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input
                    type="text"
                    value={entry.key}
                    onChange={(e) => {
                      const updated = [...envVarEntries];
                      updated[i] = { ...entry, key: e.target.value };
                      setEnvVarEntries(updated);
                    }}
                    placeholder="VAR_NAME"
                    className="w-1/3 border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)] font-mono"
                  />
                  <input
                    type="text"
                    value={entry.value}
                    onChange={(e) => {
                      const updated = [...envVarEntries];
                      updated[i] = { ...entry, value: e.target.value };
                      setEnvVarEntries(updated);
                    }}
                    placeholder="value"
                    className="flex-1 border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)] font-mono"
                  />
                  <button
                    onClick={() => setEnvVarEntries(envVarEntries.filter((_, j) => j !== i))}
                    className="text-[var(--destructive)] px-2 py-1 text-sm hover:underline"
                  >
                    Remove
                  </button>
                </div>
              ))}
              <div className="flex gap-2">
                <button
                  onClick={() => setEnvVarEntries([...envVarEntries, { key: '', value: '' }])}
                  className="border border-[var(--border)] px-3 py-1.5 rounded text-sm hover:bg-[var(--accent)]"
                >
                  + Add Variable
                </button>
                <button
                  onClick={handleSaveEnvVars}
                  disabled={savingEnvVars}
                  className="bg-[var(--brand)] text-white px-4 py-1.5 rounded text-sm font-medium hover:brightness-90 disabled:opacity-50"
                >
                  {savingEnvVars ? 'Saving...' : 'Save Variables'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Tools Section */}
        <div className="border border-[var(--border)] rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-medium">
              MCP Tools ({toolList.length})
            </h3>
            <div className="flex gap-2">
              <button
                onClick={() => setShowImport(!showImport)}
                className="border border-[var(--border)] px-3 py-1.5 rounded text-sm hover:bg-[var(--accent)]"
              >
                {showImport ? 'Cancel Import' : 'Import Tools'}
              </button>
              {(connector.type === 'REST' || connector.type === 'GRAPHQL' || connector.type === 'SOAP') && (
                <button
                  onClick={handleImportSpec}
                  className="border border-[var(--border)] px-3 py-1.5 rounded text-sm hover:bg-[var(--accent)]"
                >
                  Auto-Import from Spec
                </button>
              )}
              <button
                onClick={() => setShowNewTool(!showNewTool)}
                className="bg-[var(--brand)] text-white px-3 py-1.5 rounded text-sm font-medium hover:brightness-90"
              >
                {showNewTool ? 'Cancel' : 'Add Tool'}
              </button>
            </div>
          </div>

          {/* Import Panel */}
          {showImport && (
            <div className="border border-[var(--border)] rounded-lg p-4 mb-4 space-y-3">
              <h4 className="text-sm font-medium">Import Tools From</h4>
              <div className="flex gap-2 flex-wrap">
                {IMPORT_SOURCES.map((src) => (
                  <button
                    key={src.id}
                    onClick={() => { setImportSource(src.id); setImportContent(''); setImportUrl(''); }}
                    className={`px-3 py-1.5 rounded text-xs border transition-colors ${
                      importSource === src.id
                        ? 'border-[var(--ring)] bg-[var(--accent)] font-medium'
                        : 'border-[var(--border)] hover:border-[var(--ring)]'
                    }`}
                  >
                    {src.label}
                  </button>
                ))}
              </div>

              {importSource !== 'curl' && importSource !== 'json' && (
                <div>
                  <label className="block text-xs font-medium mb-1">URL (fetch spec from URL)</label>
                  <input
                    type="text"
                    value={importUrl}
                    onChange={(e) => setImportUrl(e.target.value)}
                    placeholder="https://..."
                    className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                  />
                </div>
              )}

              <div>
                <label className="block text-xs font-medium mb-1">
                  {importSource === 'curl' ? 'cURL Command(s)' : importSource === 'json' ? 'JSON Tool Definitions' : 'Or paste content directly'}
                </label>
                <textarea
                  value={importContent}
                  onChange={(e) => setImportContent(e.target.value)}
                  rows={6}
                  placeholder={IMPORT_SOURCES.find((s) => s.id === importSource)?.placeholder}
                  className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)] font-mono"
                />
              </div>

              <button
                onClick={handleImportTools}
                disabled={importing || (!importContent && !importUrl)}
                className="bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:brightness-90 disabled:opacity-50"
              >
                {importing ? 'Importing...' : 'Import'}
              </button>
            </div>
          )}

          {/* New Tool Editor */}
          {showNewTool && (
            <div className="mb-4">
              <ToolEditor
                connectorType={connector.type}
                onSave={handleCreateTool}
                onCancel={() => setShowNewTool(false)}
                saving={savingTool}
              />
            </div>
          )}

          {toolList.length === 0 ? (
            <p className="text-sm text-[var(--muted-foreground)] py-4 text-center">
              No tools configured. Import from a spec, Postman collection, or cURL command, or add tools manually.
            </p>
          ) : (
            <div className="space-y-3">
              {toolList.map((tool) => (
                <div key={tool.id}>
                  {editingToolId === tool.id ? (
                    <ToolEditor
                      connectorType={connector.type}
                      existingTool={{
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.parameters || { type: 'object', properties: {} },
                        endpointMapping: tool.endpointMapping || { method: 'GET', path: '/' },
                      }}
                      onSave={(data) => handleUpdateTool(tool.id, data)}
                      onCancel={() => setEditingToolId(null)}
                      saving={savingTool}
                    />
                  ) : (
                    <div className="border border-[var(--border)] rounded-md p-3 hover:border-[var(--ring)] transition-colors">
                      <div className="flex items-center justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm font-mono">{tool.name}</span>
                            {tool.endpointMapping?.method && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--info-bg)] text-[var(--info-text)] font-mono">
                                {tool.endpointMapping.method}
                              </span>
                            )}
                            <span
                              className={`text-xs px-1.5 py-0.5 rounded ${tool.isEnabled ? 'bg-[var(--success-bg)] text-[var(--success-text)]' : 'bg-[var(--muted)] text-[var(--muted-foreground)]'}`}
                            >
                              {tool.isEnabled ? 'enabled' : 'disabled'}
                            </span>
                          </div>
                          <p className="text-xs text-[var(--muted-foreground)] mt-0.5 truncate">
                            {tool.description}
                          </p>
                          {/* Show mapping summary */}
                          <div className="flex gap-3 mt-1.5 text-[10px] text-[var(--muted-foreground)]">
                            {tool.endpointMapping?.path && (
                              <span className="font-mono">{tool.endpointMapping.path}</span>
                            )}
                            {tool.parameters?.properties && (
                              <span>
                                {Object.keys(tool.parameters.properties).length} params
                              </span>
                            )}
                            {tool.endpointMapping?.queryParams && (
                              <span>{Object.keys(tool.endpointMapping.queryParams).length} query</span>
                            )}
                            {tool.endpointMapping?.bodyMapping && (
                              <span>{Object.keys(tool.endpointMapping.bodyMapping).length} body</span>
                            )}
                            {tool.endpointMapping?.headers && (
                              <span>{Object.keys(tool.endpointMapping.headers).length} headers</span>
                            )}
                          </div>
                        </div>
                        <div className="flex gap-2 ml-4">
                          <button
                            onClick={() => {
                              if (testingToolId === tool.id) {
                                setTestingToolId(null);
                              } else {
                                setTestingToolId(tool.id);
                                setToolTestResult(null);
                                // Pre-fill params from tool's parameter schema
                                const props = tool.parameters?.properties || {};
                                const example: Record<string, unknown> = {};
                                for (const [k, v] of Object.entries(props)) {
                                  const prop = v as any;
                                  if (prop.type === 'string') example[k] = '';
                                  else if (prop.type === 'number' || prop.type === 'integer') example[k] = 0;
                                  else if (prop.type === 'boolean') example[k] = false;
                                }
                                setTestParams(JSON.stringify(example, null, 2));
                              }
                            }}
                            className="border border-[var(--brand)] text-[var(--brand)] px-2 py-1 rounded text-xs hover:bg-[var(--brand-light)]"
                          >
                            {testingToolId === tool.id ? 'Close' : 'Test'}
                          </button>
                          <button
                            onClick={() => handleAiEnhance(tool.id, tool.name, tool.description)}
                            disabled={enhancingToolId === tool.id}
                            className="border border-[var(--brand)] text-[var(--brand)] px-2 py-1 rounded text-xs hover:bg-[var(--brand-light)] disabled:opacity-50"
                            title="Use AI to improve this tool's description"
                          >
                            {enhancingToolId === tool.id ? 'Enhancing...' : 'AI Enhance'}
                          </button>
                          <button
                            onClick={() => {
                              setEditingToolId(tool.id);
                              setShowNewTool(false);
                            }}
                            className="border border-[var(--border)] px-2 py-1 rounded text-xs hover:bg-[var(--accent)]"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleToggleTool(tool.id, tool.isEnabled)}
                            className="border border-[var(--border)] px-2 py-1 rounded text-xs hover:bg-[var(--accent)]"
                          >
                            {tool.isEnabled ? 'Disable' : 'Enable'}
                          </button>
                          <button
                            onClick={() => handleDeleteTool(tool.id)}
                            className="border border-[var(--destructive)] text-[var(--destructive)] px-2 py-1 rounded text-xs hover:bg-[var(--destructive-bg)]"
                          >
                            Delete
                          </button>
                        </div>
                      </div>

                      {/* Tool Playground */}
                      {testingToolId === tool.id && (
                        <div className="mt-3 pt-3 border-t border-[var(--border)]">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div>
                              <label className="block text-xs font-medium mb-1">Input Parameters (JSON)</label>
                              <textarea
                                value={testParams}
                                onChange={(e) => setTestParams(e.target.value)}
                                rows={5}
                                className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-xs bg-[var(--background)] font-mono"
                                placeholder='{ "param": "value" }'
                              />
                              <button
                                onClick={() => handleTestTool(tool.id)}
                                disabled={testRunning}
                                className="mt-2 bg-[var(--brand)] text-white px-4 py-1.5 rounded text-xs font-medium hover:brightness-90 disabled:opacity-50"
                              >
                                {testRunning ? 'Running...' : 'Run Test'}
                              </button>
                            </div>
                            <div>
                              <label className="block text-xs font-medium mb-1">
                                Response
                                {toolTestResult && (
                                  <span className={`ml-2 ${toolTestResult.ok ? 'text-[var(--success)]' : 'text-[var(--destructive)]'}`}>
                                    {toolTestResult.ok ? 'Success' : 'Error'} ({toolTestResult.durationMs}ms)
                                  </span>
                                )}
                              </label>
                              <pre className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-xs bg-[var(--muted)] font-mono overflow-auto max-h-40 min-h-[8rem]">
                                {toolTestResult
                                  ? toolTestResult.ok
                                    ? JSON.stringify(toolTestResult.result, null, 2)
                                    : toolTestResult.error
                                  : 'Click "Run Test" to execute this tool...'}
                              </pre>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
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
