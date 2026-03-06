'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { connectors } from '@/lib/api';
import { NavBar } from '@/components/nav-bar';
import { Footer } from '@/components/footer';

const CONNECTOR_TYPES = [
  { id: 'REST', name: 'REST API', description: 'Connect to any REST API. Import from OpenAPI/Swagger spec or configure manually.', color: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-500/10 dark:text-blue-400 dark:border-blue-500/30', iconBg: 'bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400' },
  { id: 'SOAP', name: 'SOAP Service', description: 'Connect to SOAP web services via WSDL.', color: 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-500/10 dark:text-orange-400 dark:border-orange-500/30', iconBg: 'bg-orange-50 dark:bg-orange-500/10 text-orange-600 dark:text-orange-400' },
  { id: 'GRAPHQL', name: 'GraphQL', description: 'Connect to GraphQL APIs with schema introspection.', color: 'bg-pink-100 text-pink-700 border-pink-200 dark:bg-pink-500/10 dark:text-pink-400 dark:border-pink-500/30', iconBg: 'bg-pink-50 dark:bg-pink-500/10 text-pink-600 dark:text-pink-400' },
  { id: 'MCP', name: 'MCP Server', description: 'Bridge to another MCP server — aggregate multiple MCP servers into one.', color: 'bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-500/10 dark:text-purple-400 dark:border-purple-500/30', iconBg: 'bg-purple-50 dark:bg-purple-500/10 text-purple-600 dark:text-purple-400' },
  { id: 'DATABASE', name: 'Database', description: 'Connect to PostgreSQL, MySQL, MariaDB, MSSQL, Oracle, MongoDB, or SQLite for read-only queries.', color: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/30', iconBg: 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
];

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
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

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

      const created = await connectors.create(data, token);

      if (specUrl && (selectedType === 'REST' || selectedType === 'SOAP' || selectedType === 'GRAPHQL')) {
        try {
          await connectors.importSpec(created.id, token);
        } catch {}
      }

      // For OAuth2 connectors, redirect to the detail page so the user can authorize
      if (authType === 'OAUTH2') {
        router.push(`/connectors/${created.id}`);
      } else {
        router.push('/connectors');
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
    <div className="min-h-screen bg-[var(--background)] flex flex-col">
      <NavBar
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Connectors', href: '/connectors' },
        ]}
        title="New Connector"
      />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 flex-1 w-full">
        <h2 className="text-lg font-medium mb-2">Choose connector type</h2>
        <p className="text-sm text-[var(--muted-foreground)] mb-6">Select the type of API you want to connect to.</p>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {CONNECTOR_TYPES.map((type) => (
            <button
              key={type.id}
              onClick={() => setSelectedType(type.id)}
              className={`text-left border rounded-lg p-5 transition-all ${
                selectedType === type.id
                  ? 'border-[var(--brand)] ring-2 ring-[var(--brand)] ring-opacity-20 bg-[var(--brand-light)]'
                  : 'border-[var(--border)] hover:border-[var(--brand)] hover:shadow-sm'
              }`}
            >
              <div className="flex items-center gap-3 mb-2">
                <div className={`w-10 h-10 rounded-lg ${type.iconBg} flex items-center justify-center`}>
                  {TYPE_ICONS[type.id]}
                </div>
                <span className="font-medium">{type.name}</span>
              </div>
              <p className="text-sm text-[var(--muted-foreground)]">{type.description}</p>
            </button>
          ))}
        </div>

        {selectedType && (
          <div className="mt-8 border border-[var(--border)] rounded-lg p-6">
            <h3 className="text-lg font-medium mb-4">
              Configure {CONNECTOR_TYPES.find((t) => t.id === selectedType)?.name}
            </h3>

            {error && (
              <div className="mb-4 p-3 rounded-md bg-[var(--destructive-bg)] text-[var(--destructive-text)] text-sm border border-[var(--destructive-border)]">{error}</div>
            )}
            {testResult && (
              <div className={`mb-4 p-3 rounded-md text-sm border ${testResult.ok ? 'bg-[var(--success-bg)] text-[var(--success-text)] border-[var(--success-border)]' : 'bg-[var(--destructive-bg)] text-[var(--destructive-text)] border-[var(--destructive-border)]'}`}>
                {testResult.message}
              </div>
            )}

            <form className="space-y-4" onSubmit={handleSubmit}>
              <div>
                <label className="block text-sm font-medium mb-1">Connector Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., My REST API"
                  className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">
                  {selectedType === 'DATABASE' ? 'Connection String' : 'Base URL'}
                </label>
                <input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={selectedType === 'DATABASE' ? 'postgresql://user:pass@host:5432/db  or  mysql://user:pass@host:3306/db' : 'https://api.example.com/v1'}
                  className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                  required
                />
              </div>

              {(selectedType === 'REST' || selectedType === 'SOAP' || selectedType === 'GRAPHQL') && (
                <div>
                  <label className="block text-sm font-medium mb-1">
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
                    className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                  />
                  <p className="text-xs text-[var(--muted-foreground)] mt-1">
                    Provide a spec URL to auto-generate MCP tools
                  </p>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium mb-1">Authentication</label>
                <select
                  value={authType}
                  onChange={(e) => setAuthType(e.target.value)}
                  className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                >
                  <option value="NONE">None</option>
                  <option value="API_KEY">API Key</option>
                  <option value="BEARER_TOKEN">Bearer Token</option>
                  <option value="BASIC_AUTH">Basic Auth</option>
                  <option value="OAUTH2">OAuth 2.0</option>
                </select>
              </div>

              {selectedType === 'MCP' && authType === 'OAUTH2' && (
                <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-md p-3 text-sm text-blue-700 dark:text-blue-300">
                  After creating the connector, you will be redirected to authorize with the remote MCP server via OAuth. Tools will be discovered automatically after authorization.
                </div>
              )}

              {authType === 'OAUTH2' && selectedType !== 'MCP' && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium mb-1">Client ID</label>
                      <input type="text" value={oauthClientId} onChange={(e) => setOauthClientId(e.target.value)} placeholder="your-client-id" className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Client Secret</label>
                      <input type="password" value={oauthClientSecret} onChange={(e) => setOauthClientSecret(e.target.value)} placeholder="optional" className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Authorization URL</label>
                    <input type="text" value={oauthAuthUrl} onChange={(e) => setOauthAuthUrl(e.target.value)} placeholder="https://provider.com/oauth/authorize" className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Token URL</label>
                    <input type="text" value={oauthTokenUrl} onChange={(e) => setOauthTokenUrl(e.target.value)} placeholder="https://provider.com/oauth/token" className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Scopes</label>
                    <input type="text" value={oauthScopes} onChange={(e) => setOauthScopes(e.target.value)} placeholder="read write (space-separated, optional)" className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]" />
                  </div>
                  <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-md p-3 text-sm text-blue-700 dark:text-blue-300">
                    <p>After creating the connector, you will be redirected to authorize via OAuth2. Tokens will be stored securely.</p>
                    <p className="mt-1.5 text-xs text-blue-600 dark:text-blue-400">
                      Set the <strong>Redirect / Callback URI</strong> in your OAuth provider to: <code className="bg-blue-100 dark:bg-blue-900/50 px-1 py-0.5 rounded font-mono">{typeof window !== 'undefined' ? window.location.origin.replace(':3000', ':4000') : 'http://localhost:4000'}/api/mcp-oauth/callback</code>
                    </p>
                  </div>
                </div>
              )}

              {authType === 'API_KEY' && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">Header Name</label>
                    <input type="text" value={authKey} onChange={(e) => setAuthKey(e.target.value)} placeholder="X-API-Key" className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">API Key</label>
                    <input type="password" value={authValue} onChange={(e) => setAuthValue(e.target.value)} placeholder="sk-..." className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]" />
                  </div>
                </div>
              )}
              {authType === 'BEARER_TOKEN' && (
                <div>
                  <label className="block text-sm font-medium mb-1">Bearer Token</label>
                  <input type="password" value={authValue} onChange={(e) => setAuthValue(e.target.value)} placeholder="eyJ..." className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]" />
                </div>
              )}
              {authType === 'BASIC_AUTH' && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">Username</label>
                    <input type="text" value={authKey} onChange={(e) => setAuthKey(e.target.value)} className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Password</label>
                    <input type="password" value={authValue} onChange={(e) => setAuthValue(e.target.value)} className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]" />
                  </div>
                </div>
              )}

              <div className="flex gap-3 pt-4">
                <button
                  type="submit"
                  disabled={loading}
                  className="bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:brightness-90 disabled:opacity-50"
                >
                  {loading ? 'Creating...' : 'Create Connector'}
                </button>
                <button
                  type="button"
                  onClick={handleTest}
                  disabled={loading || !baseUrl}
                  className="border border-[var(--border)] px-4 py-2 rounded-md text-sm font-medium hover:bg-[var(--accent)] disabled:opacity-50"
                >
                  Test Connection
                </button>
              </div>
            </form>
          </div>
        )}
      </main>
      <Footer />
    </div>
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
