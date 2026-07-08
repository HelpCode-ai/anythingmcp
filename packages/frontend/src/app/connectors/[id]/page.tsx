'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { connectors, tools } from '@/lib/api';
import { findDemoByTool } from '@/lib/demo-connectors';
import { ToolEditor } from '@/components/tool-editor';
import { McpAssignModal } from '@/components/mcp-assign-modal';
import { AppSelect } from '@/components/ui/select';
import { AppShell } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge, StatusPill } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const IMPORT_SOURCES = [
  { id: 'openapi', label: 'OpenAPI / Swagger', placeholder: 'Paste OpenAPI JSON/YAML or enter URL...' },
  { id: 'postman', label: 'Postman Collection', placeholder: 'Paste Postman Collection JSON or enter URL...' },
  { id: 'curl', label: 'cURL Command', placeholder: 'curl -X GET https://api.example.com/users -H "Authorization: Bearer {{token}}"' },
  { id: 'graphql', label: 'GraphQL Introspection', placeholder: 'Enter GraphQL endpoint URL...' },
  { id: 'wsdl', label: 'WSDL', placeholder: 'Enter WSDL URL...' },
  { id: 'json', label: 'JSON Definition', placeholder: '[\n  {\n    "name": "get_users",\n    "description": "Fetch users",\n    "parameters": { "type": "object", "properties": { "limit": { "type": "number" } } },\n    "endpointMapping": { "method": "GET", "path": "/users", "queryParams": { "limit": "$limit" } }\n  }\n]' },
  { id: 'mcp', label: 'MCP Discovery', placeholder: 'Enter MCP endpoint path (default: /mcp)' },
];

export default function ConnectorDetailPage() {
  const { token } = useAuth();
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = params.id as string;

  const [connector, setConnector] = useState<any>(null);
  const [toolList, setToolList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  // Whether CONNECTOR_PROXY_URL is configured on this instance — drives
  // visibility of the per-tool "Use proxy" checkbox.
  const [proxyAvailable, setProxyAvailable] = useState(false);

  // OAuth + MCP discovery
  const [authorizing, setAuthorizing] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editBaseUrl, setEditBaseUrl] = useState('');
  const [editHealthcheckPath, setEditHealthcheckPath] = useState('');
  const [editActive, setEditActive] = useState(true);
  const [editAuthType, setEditAuthType] = useState('NONE');
  const [editAuthKey, setEditAuthKey] = useState('');
  const [editAuthValue, setEditAuthValue] = useState('');
  const [editDbReadOnly, setEditDbReadOnly] = useState(true);
  const [editInstructions, setEditInstructions] = useState('');
  const [msg, setMsg] = useState('');
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
    kind?: 'ok' | 'auth_failed' | 'not_found' | 'unreachable' | 'unsupported' | 'error';
    httpStatus?: number;
    suggestedFix?: { action: string; hostname?: string; url?: string };
  } | null>(null);

  // Tool editor state
  const [showNewTool, setShowNewTool] = useState(false);
  const [editingToolId, setEditingToolId] = useState<string | null>(null);
  const [savingTool, setSavingTool] = useState(false);

  // Tool playground state
  const [testingToolId, setTestingToolId] = useState<string | null>(null);
  const [testParams, setTestParams] = useState('{}');
  const [testRunning, setTestRunning] = useState(false);
  const [toolTestResult, setToolTestResult] = useState<{ ok: boolean; durationMs: number; result?: unknown; error?: string; [key: string]: unknown } | null>(null);

  // Import modal
  const [showImport, setShowImport] = useState(false);
  const [importSource, setImportSource] = useState('openapi');
  const [importContent, setImportContent] = useState('');
  const [importUrl, setImportUrl] = useState('');
  const [importing, setImporting] = useState(false);

  // MCP assign modal — shown when tools are added and connector is not yet assigned
  const [showMcpAssign, setShowMcpAssign] = useState(false);

  // Environment variables
  const [showEnvVars, setShowEnvVars] = useState(false);
  const [envVarEntries, setEnvVarEntries] = useState<{ key: string; value: string }[]>([]);
  const [savingEnvVars, setSavingEnvVars] = useState(false);

  const fetchConnector = async () => {
    if (!token) return;
    try {
      // Cheap, instance-wide flag — drives the per-tool proxy checkbox.
      connectors
        .proxyAvailability(token)
        .then((r) => setProxyAvailable(!!r.available))
        .catch(() => setProxyAvailable(false));
      const c = await connectors.get(id, token);
      setConnector(c);
      setEditName(c.name);
      setEditBaseUrl(c.baseUrl);
      setEditHealthcheckPath(c.healthcheckPath || '');
      setEditActive(c.isActive);
      setEditAuthType(c.authType || 'NONE');
      setEditInstructions(c.instructions || '');
      // Don't pre-fill credentials — they are encrypted on the server
      setEditAuthKey('');
      setEditAuthValue('');
      setEditDbReadOnly((c.config as any)?.readOnly !== false);
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
    // Handle OAuth callback query params
    const oauthStatus = searchParams.get('oauth');
    if (oauthStatus === 'success') {
      const toolsImported = searchParams.get('tools');
      setMsg(
        toolsImported && Number(toolsImported) > 0
          ? `OAuth2 authorization successful! ${toolsImported} tools discovered and imported.`
          : 'OAuth2 authorization successful! You can now discover tools.',
      );
      // Clean URL
      window.history.replaceState({}, '', `/connectors/${id}`);
    } else if (oauthStatus === 'error') {
      const message = searchParams.get('message') || 'Authorization failed';
      setMsg(`OAuth2 error: ${message}`);
      window.history.replaceState({}, '', `/connectors/${id}`);
    }

    fetchConnector();
  }, [token, id]);

  const buildAuthConfig = () => {
    // Only send authConfig if the user filled in credential fields;
    // empty fields mean "keep existing credentials on the server".
    switch (editAuthType) {
      case 'API_KEY':
        if (!editAuthValue) return undefined;
        return { headerName: editAuthKey || 'X-API-Key', apiKey: editAuthValue };
      case 'BEARER_TOKEN':
        if (!editAuthValue) return undefined;
        return { token: editAuthValue };
      case 'BASIC_AUTH':
        if (!editAuthKey && !editAuthValue) return undefined;
        return { username: editAuthKey, password: editAuthValue };
      default:
        return undefined;
    }
  };

  const handleSave = async () => {
    if (!token) return;
    try {
      const data: Record<string, unknown> = {
        name: editName,
        baseUrl: editBaseUrl,
        healthcheckPath: editHealthcheckPath.trim() || null,
        isActive: editActive,
        authType: editAuthType,
        instructions: editInstructions.trim() || null,
      };
      const authConfig = buildAuthConfig();
      if (authConfig) data.authConfig = authConfig;
      if (connector.type === 'DATABASE') {
        data.config = { readOnly: editDbReadOnly };
      }
      await connectors.update(id, data, token);
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

  /** Check if connector is assigned to any MCP server; if not, show the assign modal */
  const promptMcpAssignIfNeeded = async () => {
    if (!token) return;
    try {
      const fresh = await connectors.get(id, token);
      const isAssigned = (fresh.mcpServers?.length || 0) > 0;
      const hasTools = (fresh.tools?.length || 0) > 0;
      if (!isAssigned && hasTools) {
        setShowMcpAssign(true);
      }
    } catch {}
  };

  const handleImportSpec = async () => {
    if (!token) return;
    setMsg('Importing specification...');
    try {
      const result = await connectors.importSpec(id, token);
      setMsg(result.message);
      fetchConnector();
      promptMcpAssignIfNeeded();
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
        promptMcpAssignIfNeeded();
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

  const handleToggleProxy = async (toolId: string, useProxy: boolean) => {
    if (!token) return;
    // Optimistic flip; revert on error.
    setToolList((prev) =>
      prev.map((t) => (t.id === toolId ? { ...t, useProxy: !useProxy } : t)),
    );
    try {
      await tools.setProxy(id, toolId, !useProxy, token);
    } catch (err: any) {
      setToolList((prev) =>
        prev.map((t) => (t.id === toolId ? { ...t, useProxy } : t)),
      );
      setMsg(`Error: ${err.message}`);
    }
  };

  const handleTestTool = async (toolId: string, paramsOverride?: unknown) => {
    if (!token) return;
    setTestRunning(true);
    setToolTestResult(null);
    try {
      const params =
        paramsOverride !== undefined ? paramsOverride : JSON.parse(testParams);
      const result = await tools.test(id, toolId, params, token);
      setToolTestResult(result);
    } catch (err: any) {
      setToolTestResult({ ok: false, durationMs: 0, error: err.message });
    } finally {
      setTestRunning(false);
    }
  };

  // Onboarding demo auto-run: arriving from /welcome with ?demoTool&autorun=1,
  // open that tool's playground and fire a real call immediately so the user's
  // very first action produces a successful result.
  const demoRan = useRef(false);
  useEffect(() => {
    if (demoRan.current) return;
    if (!token || !toolList.length) return;
    const demoTool = searchParams.get('demoTool');
    if (!demoTool || searchParams.get('autorun') !== '1') return;
    const tool = toolList.find((t: any) => t.name === demoTool);
    if (!tool) return;
    demoRan.current = true;
    const params = findDemoByTool(demoTool)?.params ?? {};
    setTestingToolId(tool.id);
    setTestParams(JSON.stringify(params, null, 2));
    setMsg('Running your first tool call…');
    void handleTestTool(tool.id, params);
    window.history.replaceState({}, '', `/connectors/${id}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolList, token, searchParams, id]);

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
      promptMcpAssignIfNeeded();
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

  const handleOAuthAuthorize = async () => {
    if (!token) return;
    setAuthorizing(true);
    try {
      const result = await connectors.oauthAuthorize(id, token);
      if (result.authorizationUrl) {
        window.location.href = result.authorizationUrl;
      } else if (result.error) {
        setMsg(result.error);
      }
    } catch (err: any) {
      setMsg(`Authorization failed: ${err.message}`);
    } finally {
      setAuthorizing(false);
    }
  };

  const handleDiscoverTools = async () => {
    if (!token) return;
    setDiscovering(true);
    try {
      const result = await connectors.discoverTools(id, token);
      if (result.error) {
        setMsg(result.error);
      } else {
        setMsg(result.message);
        fetchConnector();
      }
    } catch (err: any) {
      setMsg(`Discovery failed: ${err.message}`);
    } finally {
      setDiscovering(false);
    }
  };


  if (loading) {
    return (
      <AppShell backTo={{ label: 'Connectors', href: '/connectors' }} title="Connector">
        <div className="flex items-center justify-center py-24">
          <div className="text-center">
            <div className="inline-block w-6 h-6 border-2 border-[var(--brand)] border-t-transparent rounded-full animate-spin mb-3"></div>
            <p className="text-[var(--text-3)]">Loading...</p>
          </div>
        </div>
      </AppShell>
    );
  }

  if (!connector) return null;

  const monoMethodTone = (method?: string): string => {
    switch ((method || '').toUpperCase()) {
      case 'GET':
        return 'bg-[var(--t-info-bg)] text-[var(--t-info-fg)]';
      case 'POST':
        return 'bg-[var(--t-success-bg)] text-[var(--t-success-fg)]';
      case 'PUT':
      case 'PATCH':
        return 'bg-[var(--t-warn-bg)] text-[var(--t-warn-fg)]';
      case 'DELETE':
        return 'bg-[var(--t-danger-bg)] text-[var(--t-danger-fg)]';
      default:
        return 'bg-[var(--t-neutral-bg)] text-[var(--t-neutral-fg)]';
    }
  };

  const connectorInitials = (connector.name || '?')
    .split(/\s+/)
    .map((w: string) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <AppShell
      backTo={{ label: 'Connectors', href: '/connectors' }}
      title={connector.name}
      maxWidth={880}
      actions={
        <div className="flex gap-2 flex-wrap">
          <Button variant="secondary" size="md" onClick={handleTest}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5L20 7" /></svg>
            Test
          </Button>
          <Button variant="secondary" size="md" onClick={() => setEditing(!editing)}>
            {editing ? 'Cancel' : 'Edit'}
          </Button>
          <Button
            variant="secondary"
            size="md"
            onClick={handleDelete}
            className="border-[var(--danger)] text-[var(--danger)] hover:border-[var(--danger)] hover:bg-[var(--t-danger-bg)] hover:text-[var(--danger)]"
          >
            Delete
          </Button>
        </div>
      }
    >
      <div className="space-y-6">
        {/* Connector identity header */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3.5">
          <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-[12px] bg-[var(--surface-2)] text-[15px] font-semibold text-[var(--text-2)]">
            {connectorInitials}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className="text-lg font-semibold tracking-[-0.02em]">{connector.name}</span>
              <Badge tone="info">{connector.type}</Badge>
              <StatusPill
                tone={connector.isActive ? 'success' : 'neutral'}
                dot={connector.isActive ? 'var(--ok)' : 'var(--text-3)'}
              >
                {connector.isActive ? 'Active' : 'Inactive'}
              </StatusPill>
            </div>
            <div className="mt-0.5 break-all font-mono text-[12.5px] text-[var(--text-3)]">
              {connector.baseUrl}
            </div>
          </div>
        </div>

        {msg && (
          <div className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm text-[var(--text-2)]">
            {msg}
            <button onClick={() => setMsg('')} className="ml-2 underline">
              dismiss
            </button>
          </div>
        )}
        {testResult && (
          <div
            className="rounded-[10px] border p-3 text-sm"
            style={
              testResult.ok
                ? { background: 'var(--t-success-bg)', color: 'var(--t-success-fg)', borderColor: 'var(--t-success-bg)' }
                : testResult.kind === 'auth_failed'
                  ? { background: 'var(--t-warn-bg)', color: 'var(--t-warn-fg)', borderColor: 'var(--t-warn-bg)' }
                  : { background: 'var(--t-danger-bg)', color: 'var(--t-danger-fg)', borderColor: 'var(--t-danger-bg)' }
            }
          >
            {testResult.kind && testResult.kind !== 'ok' && (
              <span className="font-semibold mr-1">
                {testResult.kind === 'auth_failed' && 'Auth rejected: '}
                {testResult.kind === 'not_found' && 'Not found: '}
                {testResult.kind === 'unreachable' && 'Unreachable: '}
                {testResult.kind === 'error' && 'Error: '}
              </span>
            )}
            {testResult.message}
            {testResult.suggestedFix?.action === 'add-to-ssrf-allowlist' &&
              testResult.suggestedFix.hostname && (
                <div className="mt-2 pt-2 border-t border-current/20">
                  <a
                    href={testResult.suggestedFix.url || '/admin/settings#ssrf'}
                    className="underline text-sm font-medium hover:no-underline"
                  >
                    → Add <code>{testResult.suggestedFix.hostname}</code> to
                    the SSRF allowlist
                  </a>
                </div>
              )}
          </div>
        )}

        {/* Connector Details */}
        <Card className="p-[22px]">
          <h3 className="text-sm font-semibold mb-4">Connector Details</h3>
          {editing ? (
            <div className="space-y-4 max-w-md">
              <div>
                <label className="block text-sm font-medium mb-1">Name</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Base URL</label>
                <input
                  type="text"
                  value={editBaseUrl}
                  onChange={(e) => setEditBaseUrl(e.target.value)}
                  className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]"
                />
              </div>
              {connector.type === 'REST' && (
                <div>
                  <label className="block text-sm font-medium mb-1">
                    Healthcheck path
                    <span className="ml-2 text-xs text-[var(--text-3)] font-normal">
                      optional — defaults to /
                    </span>
                  </label>
                  <input
                    type="text"
                    value={editHealthcheckPath}
                    onChange={(e) => setEditHealthcheckPath(e.target.value)}
                    placeholder="/health"
                    className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] font-mono focus:outline-none focus:border-[var(--border-strong)]"
                  />
                  <p className="text-xs text-[var(--text-3)] mt-1">
                    Path used by "Test connection". Set to an endpoint that
                    returns 2xx without auth (e.g. <code>/health</code>) if the
                    API has no root handler.
                  </p>
                </div>
              )}
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="isActive"
                  checked={editActive}
                  onChange={(e) => setEditActive(e.target.checked)}
                />
                <label htmlFor="isActive" className="text-sm">Active</label>
              </div>
              {connector.type === 'DATABASE' && (
                <div>
                  <label className="block text-sm font-medium mb-2">Access Mode</label>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setEditDbReadOnly(true)}
                      className={`px-3 py-1.5 rounded-[9px] text-sm font-medium border transition-all ${
                        editDbReadOnly
                          ? 'bg-[var(--brand)] text-white border-[var(--brand)]'
                          : 'border-[var(--border)] hover:bg-[var(--surface-2)]'
                      }`}
                    >
                      Read-only
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditDbReadOnly(false)}
                      className={`px-3 py-1.5 rounded-[9px] text-sm font-medium border transition-all ${
                        !editDbReadOnly
                          ? 'bg-[var(--brand)] text-white border-[var(--brand)]'
                          : 'border-[var(--border)] hover:bg-[var(--surface-2)]'
                      }`}
                    >
                      Read &amp; Write
                    </button>
                  </div>
                  <p className="text-xs text-[var(--text-3)] mt-1.5">
                    {editDbReadOnly
                      ? 'Only SELECT queries are allowed. Safe for analytics and reporting.'
                      : 'All SQL operations (SELECT, INSERT, UPDATE, DELETE) are allowed. Use with caution.'}
                  </p>
                </div>
              )}
              <div>
                <label className="block text-sm font-medium mb-1">Authentication</label>
                <AppSelect
                  value={editAuthType}
                  onValueChange={(v) => { setEditAuthType(v); setEditAuthKey(''); setEditAuthValue(''); }}
                  className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]"
                  options={[
                    { value: 'NONE', label: 'None' },
                    { value: 'API_KEY', label: 'API Key' },
                    { value: 'BEARER_TOKEN', label: 'Bearer Token' },
                    { value: 'BASIC_AUTH', label: 'Basic Auth' },
                    { value: 'OAUTH2', label: 'OAuth 2.0' },
                  ]}
                />
              </div>
              {editAuthType === 'API_KEY' && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">Header Name</label>
                    <input type="text" value={editAuthKey} onChange={(e) => setEditAuthKey(e.target.value)} placeholder="X-API-Key" className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">API Key</label>
                    <input type="password" value={editAuthValue} onChange={(e) => setEditAuthValue(e.target.value)} placeholder="Leave empty to keep current" className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]" />
                  </div>
                </div>
              )}
              {editAuthType === 'BEARER_TOKEN' && (
                <div>
                  <label className="block text-sm font-medium mb-1">Bearer Token</label>
                  <input type="password" value={editAuthValue} onChange={(e) => setEditAuthValue(e.target.value)} placeholder="Leave empty to keep current" className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]" />
                </div>
              )}
              {editAuthType === 'BASIC_AUTH' && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">Username</label>
                    <input type="text" value={editAuthKey} onChange={(e) => setEditAuthKey(e.target.value)} placeholder="Leave empty to keep current" className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Password</label>
                    <input type="password" value={editAuthValue} onChange={(e) => setEditAuthValue(e.target.value)} placeholder="Leave empty to keep current" className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]" />
                  </div>
                </div>
              )}
              {editAuthType === 'OAUTH2' && connector.type !== 'MCP' && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium mb-1">Client ID</label>
                      <input type="text" value={editAuthKey} onChange={(e) => setEditAuthKey(e.target.value)} placeholder="Leave empty to keep current" className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Client Secret</label>
                      <input type="password" value={editAuthValue} onChange={(e) => setEditAuthValue(e.target.value)} placeholder="Leave empty to keep current" className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]" />
                    </div>
                  </div>
                  <p className="text-xs text-[var(--text-3)]">
                    Leave credential fields empty to keep the current values. Authorization URL, Token URL, and Scopes are preserved from initial setup.
                  </p>
                </div>
              )}
              {editAuthType !== 'NONE' && editAuthType !== 'OAUTH2' && (
                <p className="text-xs text-[var(--text-3)]">
                  Leave credential fields empty to keep the current values.
                </p>
              )}
              <div>
                <label className="block text-sm font-medium mb-1">Instructions</label>
                <textarea
                  value={editInstructions}
                  onChange={(e) => setEditInstructions(e.target.value)}
                  placeholder="Instructions sent to AI clients when using this connector's tools (e.g. date formats, field values, API conventions)."
                  rows={4}
                  className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] resize-y focus:outline-none focus:border-[var(--border-strong)]"
                />
                <p className="text-xs text-[var(--text-3)] mt-1">
                  Sent via MCP protocol to help AI understand how to use this connector.
                </p>
              </div>
              <Button variant="primary" size="lg" onClick={handleSave}>
                Save Changes
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-[var(--text-3)]">Name</p>
                <p className="font-medium">{connector.name}</p>
              </div>
              <div>
                <p className="text-[var(--text-3)]">Type</p>
                <p className="font-medium">{connector.type}</p>
              </div>
              <div>
                <p className="text-[var(--text-3)]">Base URL</p>
                <p className="font-medium font-mono text-xs break-all">{connector.baseUrl}</p>
              </div>
              <div>
                <p className="text-[var(--text-3)]">Auth Type</p>
                <p className="font-medium">{connector.authType}</p>
              </div>
              <div>
                <p className="text-[var(--text-3)]">Status</p>
                <p className="font-medium">{connector.isActive ? 'Active' : 'Inactive'}</p>
              </div>
              {connector.type === 'DATABASE' && (
                <div>
                  <p className="text-[var(--text-3)]">Access Mode</p>
                  <p className="font-medium">
                    {(connector.config as any)?.readOnly === false ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-amber-500"></span>
                        Read &amp; Write
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                        Read-only
                      </span>
                    )}
                  </p>
                </div>
              )}
              <div>
                <p className="text-[var(--text-3)]">Created</p>
                <p className="font-medium">{new Date(connector.createdAt).toLocaleDateString()}</p>
              </div>
              {connector.specUrl && (
                <div className="col-span-2">
                  <p className="text-[var(--text-3)]">Spec URL</p>
                  <p className="font-medium font-mono text-xs break-all">{connector.specUrl}</p>
                </div>
              )}
              {connector.instructions && (
                <div className="col-span-2">
                  <p className="text-[var(--text-3)]">Instructions</p>
                  <p className="font-medium text-xs whitespace-pre-wrap">{connector.instructions}</p>
                </div>
              )}
            </div>
          )}
        </Card>

        {/* OAuth2 Authorization */}
        {connector.authType === 'OAUTH2' && (
          <Card className="p-[22px]">
            <h3 className="text-sm font-semibold mb-2">OAuth2 Authorization</h3>
            <p className="text-sm text-[var(--text-3)] mb-4">
              {connector.type === 'MCP'
                ? 'Authorize this connector to access the remote MCP server. After authorization, tools will be automatically discovered.'
                : 'Authorize this connector with the OAuth2 provider. After authorization, tokens will be stored securely for API calls.'}
            </p>
            <div className="flex gap-3 flex-wrap">
              <Button variant="primary" size="lg" onClick={handleOAuthAuthorize} disabled={authorizing}>
                {authorizing ? 'Redirecting...' : connector.type === 'MCP' ? 'Authorize with Remote Server' : 'Authorize with Provider'}
              </Button>
              {connector.type === 'MCP' && (
                <Button variant="secondary" size="lg" onClick={handleDiscoverTools} disabled={discovering}>
                  {discovering ? 'Discovering...' : 'Re-discover Tools'}
                </Button>
              )}
            </div>
          </Card>
        )}

        {/* Environment Variables */}
        <Card className="p-[22px]">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold">Environment Variables</h3>
              <p className="text-xs text-[var(--text-3)] mt-1">
                Use {'{{VAR_NAME}}'} in URLs, paths, headers, and body fields. Variables are interpolated at runtime.
                <strong className="block mt-1">Parameter override:</strong> If a variable name matches a tool parameter (e.g. <code className="bg-[var(--surface-2)] px-1 rounded">sContextTokenP</code>), the value is injected automatically and the parameter is hidden from the AI.
              </p>
            </div>
            <Button variant="secondary" size="md" onClick={() => setShowEnvVars(!showEnvVars)}>
              {showEnvVars ? 'Hide' : `Edit (${envVarEntries.length})`}
            </Button>
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
                    className="w-1/3 border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] font-mono focus:outline-none focus:border-[var(--border-strong)]"
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
                    className="flex-1 border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] font-mono focus:outline-none focus:border-[var(--border-strong)]"
                  />
                  <button
                    onClick={() => setEnvVarEntries(envVarEntries.filter((_, j) => j !== i))}
                    className="text-[var(--danger)] px-2 py-1 text-sm hover:underline"
                  >
                    Remove
                  </button>
                </div>
              ))}
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="md"
                  onClick={() => setEnvVarEntries([...envVarEntries, { key: '', value: '' }])}
                >
                  + Add Variable
                </Button>
                <Button variant="primary" size="md" onClick={handleSaveEnvVars} disabled={savingEnvVars}>
                  {savingEnvVars ? 'Saving...' : 'Save Variables'}
                </Button>
              </div>
            </div>
          )}
        </Card>

        {/* Tools Section */}
        <Card className="p-[22px]">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
            <h3 className="text-sm font-semibold">
              MCP Tools ({toolList.length})
            </h3>
            <div className="flex gap-2 flex-wrap">
              <Button variant="secondary" size="md" onClick={() => setShowImport(!showImport)}>
                {showImport ? 'Cancel Import' : 'Import Tools'}
              </Button>
              {(connector.type === 'REST' || connector.type === 'GRAPHQL' || connector.type === 'SOAP') && (
                <Button variant="secondary" size="md" onClick={handleImportSpec}>
                  Auto-Import from Spec
                </Button>
              )}
              {connector.type === 'MCP' && (
                <Button
                  variant="secondary"
                  size="md"
                  onClick={handleDiscoverTools}
                  disabled={discovering}
                  className="border-[var(--t-purple-fg)] text-[var(--t-purple-fg)] hover:bg-[var(--t-purple-bg)] hover:text-[var(--t-purple-fg)]"
                >
                  {discovering ? 'Discovering...' : 'Discover from MCP Server'}
                </Button>
              )}
              <Button variant="primary" size="md" onClick={() => setShowNewTool(!showNewTool)}>
                {showNewTool ? 'Cancel' : 'Add Tool'}
              </Button>
            </div>
          </div>

          {/* Import Panel */}
          {showImport && (
            <div className="border border-[var(--border)] rounded-[14px] bg-[var(--surface-2)] p-4 mb-4 space-y-3">
              <h4 className="text-sm font-semibold">Import Tools From</h4>
              <div className="flex gap-2 flex-wrap">
                {IMPORT_SOURCES.map((src) => (
                  <button
                    key={src.id}
                    onClick={() => { setImportSource(src.id); setImportContent(''); setImportUrl(''); }}
                    className={`px-3 py-1.5 rounded-[8px] text-xs border transition-colors ${
                      importSource === src.id
                        ? 'border-[var(--brand)] bg-[var(--brand-tint)] text-[var(--brand)] font-semibold'
                        : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-2)] hover:border-[var(--brand)]'
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
                    className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] focus:outline-none focus:border-[var(--border-strong)]"
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
                  className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] font-mono focus:outline-none focus:border-[var(--border-strong)]"
                />
              </div>

              <Button
                variant="primary"
                size="lg"
                onClick={handleImportTools}
                disabled={importing || (!importContent && !importUrl)}
              >
                {importing ? 'Importing...' : 'Import'}
              </Button>
            </div>
          )}

          {/* New Tool Editor */}
          {showNewTool && (
            <div className="mb-4">
              <ToolEditor
                connectorType={connector.type}
                envVarKeys={new Set(envVarEntries.map((e) => e.key.trim()).filter(Boolean))}
                onSave={handleCreateTool}
                onCancel={() => setShowNewTool(false)}
                saving={savingTool}
              />
            </div>
          )}

          {toolList.length === 0 ? (
            <p className="text-sm text-[var(--text-3)] py-4 text-center">
              No tools configured. Import from a spec, Postman collection, or cURL command, or add tools manually.
            </p>
          ) : (
            <div className="space-y-3">
              {toolList.map((tool) => (
                <div key={tool.id}>
                  {editingToolId === tool.id ? (
                    <ToolEditor
                      connectorType={connector.type}
                      envVarKeys={new Set(envVarEntries.map((e) => e.key.trim()).filter(Boolean))}
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
                    <div className="border border-[var(--border)] bg-[var(--surface-2)] rounded-[12px] p-3 hover:border-[var(--border-strong)] transition-colors">
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-sm font-mono break-all">{tool.name}</span>
                            {tool.endpointMapping?.method && (
                              <span className={cn('text-[10px] px-1.5 py-0.5 rounded font-mono font-semibold flex-shrink-0', monoMethodTone(tool.endpointMapping.method))}>
                                {tool.endpointMapping.method}
                              </span>
                            )}
                            <Badge tone={tool.isEnabled ? 'success' : 'neutral'} className="flex-shrink-0">
                              {tool.isEnabled ? 'enabled' : 'disabled'}
                            </Badge>
                            {tool.deprecatedAt && (
                              <Badge
                                tone="warn"
                                className="flex-shrink-0"
                                title={`Removed from the source spec on ${new Date(tool.deprecatedAt).toLocaleString()}. Role assignments and history are preserved.`}
                              >
                                deprecated
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-[var(--text-3)] mt-0.5 line-clamp-2 sm:truncate">
                            {tool.description}
                          </p>
                          {/* Show mapping summary */}
                          <div className="flex gap-3 mt-1.5 text-[10px] text-[var(--text-3)] flex-wrap">
                            {tool.endpointMapping?.path && (
                              <span className="font-mono break-all">{tool.endpointMapping.path}</span>
                            )}
                            {tool.parameters?.properties && (() => {
                              const allParams = Object.keys(tool.parameters.properties);
                              const envKeys = new Set(envVarEntries.map((e) => e.key.trim()).filter(Boolean));
                              const envCovered = allParams.filter((k) => envKeys.has(k)).length;
                              return (
                                <span>
                                  {allParams.length} params{envCovered > 0 && (
                                    <span className="text-[var(--brand)]" title={`${envCovered} parameter(s) auto-filled from environment variables`}> ({envCovered} from env)</span>
                                  )}
                                </span>
                              );
                            })()}
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
                        <div className="flex gap-2 flex-wrap sm:flex-nowrap sm:ml-4 flex-shrink-0">
                          <button
                            onClick={() => {
                              if (testingToolId === tool.id) {
                                setTestingToolId(null);
                              } else {
                                setTestingToolId(tool.id);
                                setToolTestResult(null);
                                // Pre-fill params from tool's parameter schema,
                                // excluding params covered by environment variables
                                const props = tool.parameters?.properties || {};
                                const envKeys = new Set(envVarEntries.map((e) => e.key.trim()).filter(Boolean));
                                const example: Record<string, unknown> = {};
                                for (const [k, v] of Object.entries(props)) {
                                  if (envKeys.has(k)) continue; // skip env-var-covered params
                                  const prop = v as any;
                                  if (prop.type === 'string') example[k] = '';
                                  else if (prop.type === 'number' || prop.type === 'integer') example[k] = 0;
                                  else if (prop.type === 'boolean') example[k] = false;
                                }
                                setTestParams(JSON.stringify(example, null, 2));
                              }
                            }}
                            className="inline-flex items-center justify-center rounded-[7px] border border-[var(--brand)] bg-[var(--brand-tint)] text-[var(--brand)] px-2.5 py-1 text-xs font-semibold transition-colors hover:bg-[var(--brand)] hover:text-white"
                          >
                            {testingToolId === tool.id ? 'Close' : 'Test'}
                          </button>
                          <button
                            onClick={() => {
                              setEditingToolId(tool.id);
                              setShowNewTool(false);
                            }}
                            className="inline-flex items-center justify-center rounded-[7px] border border-[var(--border)] bg-[var(--surface)] text-[var(--text-2)] px-2.5 py-1 text-xs font-medium transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)]"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleToggleTool(tool.id, tool.isEnabled)}
                            className="inline-flex items-center justify-center rounded-[7px] border border-[var(--border)] bg-[var(--surface)] text-[var(--text-2)] px-2.5 py-1 text-xs font-medium transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)]"
                          >
                            {tool.isEnabled ? 'Disable' : 'Enable'}
                          </button>
                          {proxyAvailable && (
                            <label
                              className="flex items-center gap-1 rounded-[7px] border border-[var(--border)] bg-[var(--surface)] text-[var(--text-2)] px-2.5 py-1 text-xs cursor-pointer transition-colors hover:border-[var(--border-strong)]"
                              title="Route this tool's request through the configured proxy / web-unblocker. Recommended for anti-bot, geo-restricted, or rate-limited APIs."
                            >
                              <input
                                type="checkbox"
                                checked={!!tool.useProxy}
                                onChange={() => handleToggleProxy(tool.id, !!tool.useProxy)}
                                className="accent-[var(--brand)]"
                              />
                              Proxy
                            </label>
                          )}
                          <button
                            onClick={() => handleDeleteTool(tool.id)}
                            className="inline-flex items-center justify-center rounded-[7px] border border-[var(--danger)] bg-transparent text-[var(--danger)] px-2.5 py-1 text-xs font-medium transition-colors hover:bg-[var(--t-danger-bg)]"
                          >
                            Delete
                          </button>
                        </div>
                      </div>

                      {/* Tool Playground */}
                      {testingToolId === tool.id && (() => {
                        const envKeys = new Set(envVarEntries.map((e) => e.key.trim()).filter(Boolean));
                        const allParamNames = Object.keys(tool.parameters?.properties || {});
                        const envCoveredParams = allParamNames.filter((k) => envKeys.has(k));
                        return (
                        <div className="mt-3 pt-3 border-t border-[var(--border)]">
                          {envCoveredParams.length > 0 && (
                            <div className="flex items-start gap-2 px-3 py-2 mb-3 rounded-[9px] bg-[var(--brand-tint)] border border-[var(--brand)] text-xs text-[var(--text-2)]">
                              <span className="text-sm leading-none mt-0.5">&#9889;</span>
                              <span>
                                <strong>Auto-filled from env:</strong>{' '}
                                {envCoveredParams.map((p) => (
                                  <code key={p} className="mx-0.5 px-1 py-0.5 rounded bg-[var(--surface-2)] font-mono text-[11px]">{p}</code>
                                ))}
                                <span className="text-[var(--text-3)]"> — injected at runtime, no need to include in test params</span>
                              </span>
                            </div>
                          )}
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div>
                              <label className="block text-xs font-medium mb-1">Input Parameters (JSON)</label>
                              <textarea
                                value={testParams}
                                onChange={(e) => setTestParams(e.target.value)}
                                rows={5}
                                className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-xs bg-[var(--surface)] font-mono focus:outline-none focus:border-[var(--border-strong)]"
                                placeholder='{ "param": "value" }'
                              />
                              <Button variant="primary" size="sm" className="mt-2" onClick={() => handleTestTool(tool.id)} disabled={testRunning}>
                                {testRunning ? 'Running...' : 'Run Test'}
                              </Button>
                            </div>
                            <div>
                              <label className="block text-xs font-medium mb-1">
                                Response
                                {toolTestResult && (
                                  <span className={`ml-2 ${toolTestResult.ok ? 'text-[var(--ok)]' : 'text-[var(--danger)]'}`}>
                                    {toolTestResult.ok ? 'Success' : 'Error'} ({toolTestResult.durationMs}ms)
                                  </span>
                                )}
                              </label>
                              {toolTestResult && !toolTestResult.ok && typeof toolTestResult.hint === 'string' && (
                                <div
                                  className="mb-2 p-2 rounded-[9px] text-xs border"
                                  style={
                                    toolTestResult.kind === 'auth_failed'
                                      ? { background: 'var(--t-warn-bg)', color: 'var(--t-warn-fg)', borderColor: 'var(--t-warn-bg)' }
                                      : { background: 'var(--t-danger-bg)', color: 'var(--t-danger-fg)', borderColor: 'var(--t-danger-bg)' }
                                  }
                                >
                                  <span className="font-semibold mr-1">
                                    {toolTestResult.kind === 'auth_failed' && 'Credentials rejected:'}
                                    {toolTestResult.kind === 'bad_request' && 'Invalid request:'}
                                    {toolTestResult.kind === 'not_found' && 'Not found:'}
                                    {toolTestResult.kind === 'rate_limited' && 'Rate limited:'}
                                    {toolTestResult.kind === 'upstream_error' && 'Upstream error:'}
                                    {toolTestResult.kind === 'unreachable' && 'Unreachable:'}
                                    {toolTestResult.kind === 'error' && 'Failed:'}
                                  </span>
                                  {String(toolTestResult.hint)}
                                </div>
                              )}
                              <pre className="w-full border border-[var(--border)] rounded-[9px] px-3 py-2 text-xs bg-[var(--surface-2)] font-mono overflow-auto max-h-40 min-h-[8rem]">
                                {toolTestResult
                                  ? toolTestResult.ok
                                    ? JSON.stringify(toolTestResult.result, null, 2)
                                    : JSON.stringify(toolTestResult, null, 2)
                                  : 'Click "Run Test" to execute this tool...'}
                              </pre>
                            </div>
                          </div>
                        </div>
                        );
                      })()}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Danger zone */}
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border p-[18px]"
          style={{ borderColor: 'var(--t-danger-bg)', background: 'color-mix(in srgb, var(--danger) 5%, transparent)' }}
        >
          <div>
            <div className="text-[13.5px] font-semibold text-[var(--danger)]">Delete connector</div>
            <div className="text-[12.5px] text-[var(--text-3)]">
              Removes this connector and unassigns it from all MCP servers.
            </div>
          </div>
          <button
            onClick={handleDelete}
            className="inline-flex h-9 items-center rounded-[9px] border border-[var(--danger)] bg-transparent px-3.5 text-[13px] font-semibold text-[var(--danger)] transition-colors hover:bg-[var(--t-danger-bg)]"
          >
            Delete
          </button>
        </div>
      </div>

      {/* MCP Server Assignment Modal — shown after tools are added and connector is unassigned */}
      {showMcpAssign && connector && token && (
        <McpAssignModal
          connectorId={id}
          connectorName={connector.name}
          token={token}
          onDone={() => setShowMcpAssign(false)}
          onClose={() => setShowMcpAssign(false)}
        />
      )}
    </AppShell>
  );
}
