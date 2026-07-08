'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { connectors } from '@/lib/api';
import { AppShell } from '@/components/app-shell';
import { Card } from '@/components/ui/card';
import { McpAssignModal } from '@/components/mcp-assign-modal';
import { AppSelect } from '@/components/ui/select';
import { cn } from '@/lib/utils';

const CONNECTOR_TYPES = [
  { id: 'REST', name: 'REST API', description: 'Connect to any REST API. Import from OpenAPI/Swagger spec or configure manually.', tone: 'bg-[var(--t-info-bg)] text-[var(--t-info-fg)]' },
  { id: 'SOAP', name: 'SOAP Service', description: 'Connect to SOAP web services via WSDL.', tone: 'bg-[var(--t-warn-bg)] text-[var(--t-warn-fg)]' },
  { id: 'GRAPHQL', name: 'GraphQL', description: 'Connect to GraphQL APIs with schema introspection.', tone: 'bg-[var(--t-pink-bg)] text-[var(--t-pink-fg)]' },
  { id: 'MCP', name: 'MCP Server', description: 'Bridge to another MCP server — aggregate multiple MCP servers into one.', tone: 'bg-[var(--t-purple-bg)] text-[var(--t-purple-fg)]' },
  { id: 'DATABASE', name: 'Database', description: 'Connect to PostgreSQL, MySQL, MariaDB, MSSQL, Oracle, MongoDB, or SQLite. Supports read-only or read-write mode.', tone: 'bg-[var(--t-emerald-bg)] text-[var(--t-emerald-fg)]' },
];

const inputClass =
  'h-9 w-full rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13.5px] text-[var(--text)] placeholder:text-[var(--text-3)] outline-none focus:border-[var(--border-strong)]';
const labelClass = 'mb-1.5 block text-[12.5px] font-medium text-[var(--text)]';

const TYPE_ICONS: Record<string, React.ReactNode> = {
  REST: <RestIcon />,
  SOAP: <SoapIcon />,
  GRAPHQL: <GraphqlIcon />,
  MCP: <McpIcon />,
  DATABASE: <DatabaseIcon />,
};

export default function NewConnectorPage() {
  const { token } = useAuth();
  const router = useRouter();
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [specUrl, setSpecUrl] = useState('');
  const [authType, setAuthType] = useState('NONE');
  const [authKey, setAuthKey] = useState('');
  const [authValue, setAuthValue] = useState('');
  const [oauthClientId, setOauthClientId] = useState('');
  const [oauthClientSecret, setOauthClientSecret] = useState('');
  const [oauthAuthUrl, setOauthAuthUrl] = useState('');
  const [oauthTokenUrl, setOauthTokenUrl] = useState('');
  const [oauthScopes, setOauthScopes] = useState('');
  const [dbReadOnly, setDbReadOnly] = useState(true);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
    kind?: 'ok' | 'auth_failed' | 'not_found' | 'unreachable' | 'unsupported' | 'error';
    httpStatus?: number;
    suggestedFix?: { action: string; hostname?: string; url?: string };
  } | null>(null);
  const [createdConnector, setCreatedConnector] = useState<{ id: string; name: string } | null>(null);

  const buildAuthConfig = () => {
    switch (authType) {
      case 'API_KEY':
        return { headerName: authKey || 'X-API-Key', apiKey: authValue };
      case 'BEARER_TOKEN':
        return { token: authValue };
      case 'BASIC_AUTH':
        return { username: authKey, password: authValue };
      case 'OAUTH2':
        if (selectedType !== 'MCP') {
          return {
            clientId: oauthClientId,
            clientSecret: oauthClientSecret || undefined,
            authorizationUrl: oauthAuthUrl,
            tokenUrl: oauthTokenUrl,
            scopes: oauthScopes || undefined,
          };
        }
        return undefined;
      default:
        return undefined;
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !selectedType) return;
    setError('');
    setLoading(true);

    try {
      const data: any = {
        name,
        type: selectedType,
        baseUrl,
        authType,
      };
      const authConfig = buildAuthConfig();
      if (authConfig) data.authConfig = authConfig;
      if (specUrl) data.specUrl = specUrl;
      if (selectedType === 'DATABASE') {
        data.config = { readOnly: dbReadOnly };
      }

      const created = await connectors.create(data, token);

      if (specUrl && (selectedType === 'REST' || selectedType === 'SOAP' || selectedType === 'GRAPHQL')) {
        try {
          await connectors.importSpec(created.id, token);
        } catch {}
      }

      // Check if the connector has tools — only show MCP assignment if it does
      const full = await connectors.get(created.id, token);
      const hasTools = (full.tools?.length || 0) > 0;

      if (hasTools) {
        setCreatedConnector({ id: created.id, name: name || created.name });
      } else {
        router.push(`/connectors/${created.id}`);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleTest = async () => {
    if (!token || !selectedType) return;
    setTestResult(null);
    setLoading(true);

    try {
      const data: any = { name: name || 'Test', type: selectedType, baseUrl, authType };
      const authConfig = buildAuthConfig();
      if (authConfig) data.authConfig = authConfig;

      const created = await connectors.create(data, token);
      const result = await connectors.test(created.id, token);
      setTestResult(result);
      await connectors.delete(created.id, token);
    } catch (err: any) {
      setTestResult({ ok: false, message: err.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <AppShell
      backTo={{ label: 'Connectors', href: '/connectors' }}
      title="New connector"
      maxWidth={880}
    >
      <div className="mx-auto w-full max-w-[880px]">
        <h2 className="mb-[3px] text-[15px] font-semibold text-[var(--text)]">Choose connector type</h2>
        <p className="mb-4 text-[13px] text-[var(--text-3)]">Select the type of API you want to connect to.</p>

        <div className="mb-6 grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
          {CONNECTOR_TYPES.map((type) => (
            <button
              key={type.id}
              onClick={() => setSelectedType(type.id)}
              className={cn(
                'rounded-[13px] border bg-[var(--surface)] p-4 text-left transition-all',
                selectedType === type.id
                  ? 'border-[var(--brand)] bg-[var(--brand-tint)]'
                  : 'border-[var(--border)] hover:border-[var(--brand)] hover:bg-[var(--brand-tint)]'
              )}
            >
              <div className="mb-[9px] flex items-center gap-[11px]">
                <span className={cn('flex h-[38px] w-[38px] items-center justify-center rounded-[10px]', type.tone)}>
                  {TYPE_ICONS[type.id]}
                </span>
                <span className="text-[14px] font-semibold text-[var(--text)]">{type.name}</span>
              </div>
              <p className="text-[12px] leading-[1.5] text-[var(--text-3)]">{type.description}</p>
            </button>
          ))}
        </div>

        {selectedType && (
          <Card className="rounded-[14px] p-[22px] shadow-[var(--shadow-sm)]">
            <h3 className="mb-4 text-[14px] font-semibold text-[var(--text)]">
              Configure {CONNECTOR_TYPES.find((t) => t.id === selectedType)?.name}
            </h3>

            {error && (
              <div className="mb-4 rounded-[9px] border border-[var(--danger)]/30 bg-[var(--t-danger-bg)] p-3 text-sm text-[var(--t-danger-fg)]">{error}</div>
            )}
            {testResult && (
              <div
                className={cn(
                  'mb-4 rounded-[9px] border p-3 text-sm',
                  testResult.ok
                    ? 'border-[var(--ok)]/30 bg-[var(--t-success-bg)] text-[var(--t-success-fg)]'
                    : testResult.kind === 'auth_failed'
                      ? 'border-[var(--warn)]/30 bg-[var(--t-warn-bg)] text-[var(--t-warn-fg)]'
                      : 'border-[var(--danger)]/30 bg-[var(--t-danger-bg)] text-[var(--t-danger-fg)]'
                )}
              >
                {testResult.kind && testResult.kind !== 'ok' && (
                  <span className="font-semibold mr-1">
                    {testResult.kind === 'auth_failed' &&
                      `Credentials rejected${testResult.httpStatus ? ` (${testResult.httpStatus})` : ''}: `}
                    {testResult.kind === 'not_found' && 'Not found: '}
                    {testResult.kind === 'unreachable' && 'Unreachable: '}
                    {testResult.kind === 'error' && 'Error: '}
                  </span>
                )}
                {testResult.message}
                {testResult.kind === 'auth_failed' && (
                  <div className="mt-1 opacity-90">
                    Double-check the API key / token / OAuth credentials for this
                    connector, then test again.
                  </div>
                )}
                {testResult.suggestedFix?.action === 'add-to-ssrf-allowlist' &&
                  testResult.suggestedFix.hostname && (
                    <div className="mt-2 pt-2 border-t border-current/20">
                      <a
                        href={testResult.suggestedFix.url || '/admin/settings#ssrf'}
                        className="underline text-sm font-medium hover:no-underline"
                      >
                        → Add <code>{testResult.suggestedFix.hostname}</code> to the
                        SSRF allowlist
                      </a>
                    </div>
                  )}
              </div>
            )}

            <form className="flex max-w-[560px] flex-col gap-[15px]" onSubmit={handleSubmit}>
              <div>
                <label className={labelClass}>Connector name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., My REST API"
                  className={inputClass}
                  required
                />
              </div>

              <div>
                <label className={labelClass}>
                  {selectedType === 'DATABASE' ? 'Connection String' : 'Base URL'}
                </label>
                <input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={selectedType === 'DATABASE' ? 'postgresql://user:pass@host:5432/db  or  mysql://user:pass@host:3306/db' : 'https://api.example.com/v1'}
                  className={cn(inputClass, 'font-mono text-[13px]')}
                  required
                />
              </div>

              {selectedType === 'DATABASE' && (
                <div>
                  <label className={labelClass}>Access mode</label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setDbReadOnly(true)}
                      className={cn(
                        'rounded-[9px] px-[13px] py-[7px] text-[13px] font-semibold transition-all',
                        dbReadOnly
                          ? 'bg-[var(--brand)] text-white'
                          : 'border border-[var(--border)] text-[var(--text-2)] hover:border-[var(--border-strong)]'
                      )}
                    >
                      Read-only
                    </button>
                    <button
                      type="button"
                      onClick={() => setDbReadOnly(false)}
                      className={cn(
                        'rounded-[9px] px-[13px] py-[7px] text-[13px] font-semibold transition-all',
                        !dbReadOnly
                          ? 'bg-[var(--brand)] text-white'
                          : 'border border-[var(--border)] text-[var(--text-2)] hover:border-[var(--border-strong)]'
                      )}
                    >
                      Read &amp; Write
                    </button>
                  </div>
                  <p className="mt-2 text-[11.5px] text-[var(--text-3)]">
                    {dbReadOnly
                      ? 'Only SELECT queries will be allowed. Safe for analytics and reporting.'
                      : 'All SQL operations (SELECT, INSERT, UPDATE, DELETE) will be allowed. Use with caution.'}
                  </p>
                </div>
              )}

              {(selectedType === 'REST' || selectedType === 'SOAP' || selectedType === 'GRAPHQL') && (
                <div>
                  <label className={labelClass}>
                    {selectedType === 'REST'
                      ? 'OpenAPI Spec URL (optional)'
                      : selectedType === 'GRAPHQL'
                        ? 'GraphQL Introspection URL (optional)'
                        : 'WSDL URL (optional)'}
                  </label>
                  <input
                    type="text"
                    value={specUrl}
                    onChange={(e) => setSpecUrl(e.target.value)}
                    placeholder={
                      selectedType === 'REST'
                        ? 'https://api.example.com/openapi.json'
                        : selectedType === 'GRAPHQL'
                          ? 'https://api.example.com/graphql'
                          : 'https://service.example.com?wsdl'
                    }
                    className={cn(inputClass, 'font-mono text-[13px]')}
                  />
                  <p className="mt-1.5 text-[11.5px] text-[var(--text-3)]">
                    Provide a spec URL to auto-generate MCP tools.
                  </p>
                </div>
              )}

              <div>
                <label className={labelClass}>Authentication</label>
                <AppSelect
                  value={authType}
                  onValueChange={setAuthType}
                  className={inputClass}
                  options={[
                    { value: 'NONE', label: 'None' },
                    { value: 'API_KEY', label: 'API Key' },
                    { value: 'BEARER_TOKEN', label: 'Bearer Token' },
                    { value: 'BASIC_AUTH', label: 'Basic Auth' },
                    { value: 'OAUTH2', label: 'OAuth 2.0' },
                  ]}
                />
              </div>

              {selectedType === 'MCP' && authType === 'OAUTH2' && (
                <div className="rounded-[9px] border border-[var(--t-info-fg)]/20 bg-[var(--t-info-bg)] p-3 text-sm text-[var(--t-info-fg)]">
                  After creating the connector, you will be redirected to authorize with the remote MCP server via OAuth. Tools will be discovered automatically after authorization.
                </div>
              )}

              {authType === 'OAUTH2' && selectedType !== 'MCP' && (
                <div className="flex flex-col gap-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={labelClass}>Client ID</label>
                      <input type="text" value={oauthClientId} onChange={(e) => setOauthClientId(e.target.value)} placeholder="your-client-id" className={cn(inputClass, 'font-mono text-[13px]')} />
                    </div>
                    <div>
                      <label className={labelClass}>Client Secret</label>
                      <input type="password" value={oauthClientSecret} onChange={(e) => setOauthClientSecret(e.target.value)} placeholder="optional" className={cn(inputClass, 'font-mono text-[13px]')} />
                    </div>
                  </div>
                  <div>
                    <label className={labelClass}>Authorization URL</label>
                    <input type="text" value={oauthAuthUrl} onChange={(e) => setOauthAuthUrl(e.target.value)} placeholder="https://provider.com/oauth/authorize" className={cn(inputClass, 'font-mono text-[13px]')} />
                  </div>
                  <div>
                    <label className={labelClass}>Token URL</label>
                    <input type="text" value={oauthTokenUrl} onChange={(e) => setOauthTokenUrl(e.target.value)} placeholder="https://provider.com/oauth/token" className={cn(inputClass, 'font-mono text-[13px]')} />
                  </div>
                  <div>
                    <label className={labelClass}>Scopes</label>
                    <input type="text" value={oauthScopes} onChange={(e) => setOauthScopes(e.target.value)} placeholder="read write (space-separated, optional)" className={cn(inputClass, 'font-mono text-[13px]')} />
                  </div>
                  <div className="rounded-[9px] border border-[var(--t-info-fg)]/20 bg-[var(--t-info-bg)] p-3 text-sm text-[var(--t-info-fg)]">
                    <p>After creating the connector, you will be redirected to authorize via OAuth2. Tokens will be stored securely.</p>
                    <p className="mt-1.5 text-xs opacity-90">
                      Set the <strong>Redirect / Callback URI</strong> in your OAuth provider to: <code className="rounded bg-[var(--surface-2)] px-1 py-0.5 font-mono">{typeof window !== 'undefined' ? (window.location.hostname === 'localhost' ? window.location.origin.replace(':3000', ':4000') : window.location.origin) : 'http://localhost:4000'}/api/mcp-oauth/callback</code>
                    </p>
                  </div>
                </div>
              )}

              {authType === 'API_KEY' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelClass}>Header name</label>
                    <input type="text" value={authKey} onChange={(e) => setAuthKey(e.target.value)} placeholder="X-API-Key" className={cn(inputClass, 'font-mono text-[13px]')} />
                  </div>
                  <div>
                    <label className={labelClass}>API key</label>
                    <input type="password" value={authValue} onChange={(e) => setAuthValue(e.target.value)} placeholder="sk-..." className={cn(inputClass, 'font-mono text-[13px]')} />
                  </div>
                </div>
              )}
              {authType === 'BEARER_TOKEN' && (
                <div>
                  <label className={labelClass}>Bearer Token</label>
                  <input type="password" value={authValue} onChange={(e) => setAuthValue(e.target.value)} placeholder="eyJ..." className={cn(inputClass, 'font-mono text-[13px]')} />
                </div>
              )}
              {authType === 'BASIC_AUTH' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelClass}>Username</label>
                    <input type="text" value={authKey} onChange={(e) => setAuthKey(e.target.value)} className={inputClass} />
                  </div>
                  <div>
                    <label className={labelClass}>Password</label>
                    <input type="password" value={authValue} onChange={(e) => setAuthValue(e.target.value)} className={inputClass} />
                  </div>
                </div>
              )}

              <div className="flex gap-[10px] pt-1">
                <button
                  type="submit"
                  disabled={loading}
                  className="h-10 rounded-[9px] bg-[var(--brand)] px-[18px] text-[13px] font-semibold text-white hover:bg-[var(--brand-strong)] disabled:opacity-50"
                >
                  {loading ? 'Creating...' : 'Create connector'}
                </button>
                <button
                  type="button"
                  onClick={handleTest}
                  disabled={loading || !baseUrl}
                  className="h-10 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-4 text-[13px] font-medium text-[var(--text-2)] hover:border-[var(--border-strong)] disabled:opacity-50"
                >
                  Test connection
                </button>
              </div>
            </form>
          </Card>
        )}
      </div>

      {/* MCP Server Assignment Modal */}
      {createdConnector && token && (
        <McpAssignModal
          connectorId={createdConnector.id}
          connectorName={createdConnector.name}
          token={token}
          onDone={(mcpServerId) => {
            setCreatedConnector(null);
            if (mcpServerId) {
              router.push(`/mcp-server/${mcpServerId}`);
            } else {
              router.push(`/connectors/${createdConnector.id}`);
            }
          }}
          onClose={() => {
            setCreatedConnector(null);
            router.push(`/connectors/${createdConnector.id}`);
          }}
        />
      )}
    </AppShell>
  );
}

/* Connector type SVG icons */
function RestIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7c0-1.1.9-2 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7z" />
      <path d="M9 12h6" />
      <path d="M12 9v6" />
    </svg>
  );
}
function SoapIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m18 16 4-4-4-4" />
      <path d="m6 8-4 4 4 4" />
      <path d="m14.5 4-5 16" />
    </svg>
  );
}
function GraphqlIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5" />
      <line x1="12" y1="22" x2="12" y2="15.5" />
      <polyline points="22 8.5 12 15.5 2 8.5" />
    </svg>
  );
}
function McpIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="8" height="8" rx="1" />
      <rect x="14" y="6" width="8" height="8" rx="1" />
      <path d="M10 10h4" />
    </svg>
  );
}
function DatabaseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
      <path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" />
    </svg>
  );
}
