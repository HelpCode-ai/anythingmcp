'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';
import { users, server, ai, mcpKeys } from '@/lib/api';
import { NavBar } from '@/components/nav-bar';
import { Footer } from '@/components/footer';

const AUTH_MODE_LABELS: Record<string, string> = {
  none: 'None (not recommended)',
  legacy: 'Legacy (Bearer Token / API Key)',
  oauth2: 'OAuth 2.0 (Authorization Code + Client Credentials)',
  both: 'Both (OAuth 2.0 + Legacy)',
};

interface ModelOption {
  id: string;
  label: string;
}

export default function SettingsPage() {
  const { token, user } = useAuth();
  const [profileName, setProfileName] = useState(user?.name || '');
  const [profileMsg, setProfileMsg] = useState('');
  // Change password
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [passwordMsg, setPasswordMsg] = useState('');
  const [aiProvider, setAiProvider] = useState('');
  const [aiModel, setAiModel] = useState('');
  const [aiApiKey, setAiApiKey] = useState('');
  const [hasExistingKey, setHasExistingKey] = useState(false);
  const [hasEnvApiKey, setHasEnvApiKey] = useState(false);
  const [aiMsg, setAiMsg] = useState('');
  const [mcpAuthMode, setMcpAuthMode] = useState('');
  const [oauthEndpoints, setOauthEndpoints] = useState<Record<string, string> | null>(null);
  const [serverUrl, setServerUrl] = useState('');
  const [modelOptions, setModelOptions] = useState<{
    anthropic: { models: ModelOption[]; default: string };
    openai: { models: ModelOption[]; default: string };
  } | null>(null);

  // MCP API Keys
  const [keyList, setKeyList] = useState<any[]>([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [generatedKey, setGeneratedKey] = useState('');
  const [keyMsg, setKeyMsg] = useState('');

  // Load server info
  useEffect(() => {
    server.info().then((info) => {
      setMcpAuthMode(info.mcpAuthMode);
      setOauthEndpoints(info.oauthEndpoints);
      setServerUrl(info.serverUrl);
    }).catch(() => {});
  }, []);

  // Load user's saved AI config + available models
  useEffect(() => {
    if (!token) return;

    users.me(token).then((profile) => {
      if (profile.aiProvider) setAiProvider(profile.aiProvider);
      if (profile.aiModel) setAiModel(profile.aiModel);
      if (profile.hasAiApiKey) setHasExistingKey(true);
      if (profile.hasEnvApiKey) setHasEnvApiKey(true);
    }).catch(() => {});

    ai.models(token).then((data) => {
      setModelOptions(data);
    }).catch(() => {});

    mcpKeys.list(token).then(setKeyList).catch(() => {});
  }, [token]);

  const handleSaveProfile = async () => {
    if (!token) return;
    try {
      await users.updateProfile({ name: profileName }, token);
      setProfileMsg('Profile updated');
      setTimeout(() => setProfileMsg(''), 3000);
    } catch (err: any) {
      setProfileMsg(`Error: ${err.message}`);
    }
  };

  const handleChangePassword = async () => {
    if (!token) return;
    if (newPassword !== confirmNewPassword) {
      setPasswordMsg('Error: Passwords do not match');
      return;
    }
    try {
      const result = await users.changePassword({ currentPassword, newPassword }, token);
      if (result.error) {
        setPasswordMsg(`Error: ${result.error}`);
      } else {
        setPasswordMsg('Password changed successfully');
        setCurrentPassword('');
        setNewPassword('');
        setConfirmNewPassword('');
        setTimeout(() => setPasswordMsg(''), 3000);
      }
    } catch (err: any) {
      setPasswordMsg(`Error: ${err.message}`);
    }
  };

  const handleSaveAi = async () => {
    if (!token || !aiProvider || !aiApiKey) return;
    try {
      await users.updateAiConfig({ provider: aiProvider, apiKey: aiApiKey, model: aiModel || undefined }, token);
      setHasExistingKey(true);
      setAiApiKey('');
      setAiMsg('AI configuration saved');
      setTimeout(() => setAiMsg(''), 3000);
    } catch (err: any) {
      setAiMsg(`Error: ${err.message}`);
    }
  };

  const handleGenerateKey = async () => {
    if (!token || !newKeyName.trim()) return;
    try {
      const result = await mcpKeys.generate(newKeyName.trim(), token);
      setGeneratedKey(result.key);
      setNewKeyName('');
      setKeyMsg('Key generated! Copy it now — it will not be shown again.');
      mcpKeys.list(token).then(setKeyList).catch(() => {});
    } catch (err: any) {
      setKeyMsg(`Error: ${err.message}`);
    }
  };

  const handleRevokeKey = async (id: string) => {
    if (!token) return;
    try {
      await mcpKeys.revoke(id, token);
      mcpKeys.list(token).then(setKeyList).catch(() => {});
      setKeyMsg('Key revoked');
    } catch (err: any) {
      setKeyMsg(`Error: ${err.message}`);
    }
  };

  const handleDeleteKey = async (id: string) => {
    if (!token || !confirm('Delete this API key permanently?')) return;
    try {
      await mcpKeys.delete(id, token);
      setKeyList((prev) => prev.filter((k) => k.id !== id));
      setKeyMsg('Key deleted');
    } catch (err: any) {
      setKeyMsg(`Error: ${err.message}`);
    }
  };

  const currentModels: ModelOption[] =
    aiProvider && modelOptions
      ? modelOptions[aiProvider as 'anthropic' | 'openai']?.models || []
      : [];

  // When provider changes, reset model to default for that provider
  const handleProviderChange = (newProvider: string) => {
    setAiProvider(newProvider);
    if (modelOptions && newProvider) {
      const providerConfig = modelOptions[newProvider as 'anthropic' | 'openai'];
      if (providerConfig) {
        setAiModel(providerConfig.default);
      }
    }
  };

  return (
    <div className="min-h-screen bg-[var(--background)] flex flex-col">
      <NavBar
        breadcrumbs={[{ label: 'Dashboard', href: '/' }]}
        title="Settings"
      />

      <main className="max-w-7xl mx-auto px-6 py-8 flex-1 w-full">
        <div className="space-y-6">
          {/* Profile */}
          <div className="border border-[var(--border)] rounded-lg p-6">
            <h3 className="text-lg font-medium mb-4">Profile</h3>
            <div className="space-y-4 max-w-md">
              <div>
                <label className="block text-sm font-medium mb-1">Email</label>
                <input type="text" value={user?.email || ''} disabled className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--muted)] opacity-70" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Name</label>
                <input type="text" value={profileName} onChange={(e) => setProfileName(e.target.value)} className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Role</label>
                <input type="text" value={user?.role || ''} disabled className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--muted)] opacity-70" />
              </div>
              {profileMsg && (
                <p className={`text-sm ${profileMsg.startsWith('Error') ? 'text-[var(--destructive)]' : 'text-[var(--success)]'}`}>
                  {profileMsg}
                </p>
              )}
              <button onClick={handleSaveProfile} className="bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:brightness-90">
                Save Profile
              </button>
            </div>
          </div>

          {/* Change Password */}
          <div className="border border-[var(--border)] rounded-lg p-6">
            <h3 className="text-lg font-medium mb-4">Change Password</h3>
            <div className="space-y-4 max-w-md">
              <div>
                <label className="block text-sm font-medium mb-1">Current Password</label>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">New Password</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Min. 8 characters"
                  minLength={8}
                  className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Confirm New Password</label>
                <input
                  type="password"
                  value={confirmNewPassword}
                  onChange={(e) => setConfirmNewPassword(e.target.value)}
                  placeholder="Repeat new password"
                  minLength={8}
                  className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                />
              </div>
              {passwordMsg && (
                <p className={`text-sm ${passwordMsg.startsWith('Error') ? 'text-[var(--destructive)]' : 'text-[var(--success)]'}`}>
                  {passwordMsg}
                </p>
              )}
              <button
                onClick={handleChangePassword}
                disabled={!currentPassword || !newPassword || newPassword.length < 8}
                className="bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:brightness-90 disabled:opacity-50"
              >
                Change Password
              </button>
            </div>
          </div>

          {/* MCP Auth */}
          <div className="border border-[var(--border)] rounded-lg p-6">
            <h3 className="text-lg font-medium mb-4">MCP Server Authentication</h3>
            <p className="text-sm text-[var(--muted-foreground)] mb-4">
              Configure how MCP clients (Claude, ChatGPT, Cursor) authenticate to your server.
            </p>
            <div className="space-y-4 max-w-lg">
              <div>
                <label className="block text-sm font-medium mb-1">Auth Method</label>
                <div className="flex items-center gap-3">
                  <div className="flex-1 border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--muted)] opacity-80">
                    {AUTH_MODE_LABELS[mcpAuthMode] || mcpAuthMode || 'Loading...'}
                  </div>
                  {(mcpAuthMode === 'oauth2' || mcpAuthMode === 'both') && (
                    <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-500/10 text-green-500 border border-green-500/20">
                      Active
                    </span>
                  )}
                </div>
              </div>

              {/* OAuth2 info */}
              {(mcpAuthMode === 'oauth2' || mcpAuthMode === 'both') && oauthEndpoints && (
                <div className="border border-[var(--border)] rounded-md p-4 bg-[var(--muted)]/30 space-y-3">
                  <h4 className="text-sm font-medium">OAuth 2.0 Endpoints</h4>
                  <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs font-mono">
                    <span className="text-[var(--muted-foreground)]">Discovery:</span>
                    <span>{serverUrl}{oauthEndpoints.wellKnown}</span>
                    <span className="text-[var(--muted-foreground)]">Authorize:</span>
                    <span>{serverUrl}{oauthEndpoints.authorize}</span>
                    <span className="text-[var(--muted-foreground)]">Token:</span>
                    <span>{serverUrl}{oauthEndpoints.token}</span>
                    <span className="text-[var(--muted-foreground)]">Register:</span>
                    <span>{serverUrl}{oauthEndpoints.register}</span>
                  </div>
                  <p className="text-xs text-[var(--muted-foreground)]">
                    Supports Authorization Code (with PKCE) and Client Credentials grant types.
                    MCP clients like Claude Desktop will auto-discover these endpoints.
                  </p>
                </div>
              )}

              {/* Legacy info */}
              {(mcpAuthMode === 'legacy' || mcpAuthMode === 'both') && (
                <div className="border border-[var(--border)] rounded-md p-4 bg-[var(--muted)]/30 space-y-2">
                  <h4 className="text-sm font-medium">Legacy Authentication</h4>
                  <p className="text-xs text-[var(--muted-foreground)]">
                    Set <code className="bg-[var(--muted)] px-1 rounded">MCP_BEARER_TOKEN</code> or <code className="bg-[var(--muted)] px-1 rounded">MCP_API_KEY</code> in your environment variables.
                  </p>
                </div>
              )}

              <p className="text-xs text-[var(--muted-foreground)]">
                Auth mode is configured via the <code className="bg-[var(--muted)] px-1 rounded">MCP_AUTH_MODE</code> environment variable.
                Set it to <code className="bg-[var(--muted)] px-1 rounded">oauth2</code>, <code className="bg-[var(--muted)] px-1 rounded">legacy</code>, <code className="bg-[var(--muted)] px-1 rounded">both</code>, or <code className="bg-[var(--muted)] px-1 rounded">none</code>.
              </p>
            </div>
          </div>

          {/* AI Provider */}
          <div className="border border-[var(--border)] rounded-lg p-6">
            <h3 className="text-lg font-medium mb-4">Default AI Provider</h3>
            <p className="text-sm text-[var(--muted-foreground)] mb-4">
              Save your preferred AI provider, model, and API key. Used by the AI Assistant chat and AI Enhance on tools.
            </p>
            {hasEnvApiKey && (
              <div className="border border-[var(--border)] rounded-md p-3 bg-[var(--muted)]/30 mb-4">
                <p className="text-xs text-[var(--muted-foreground)]">
                  Server-level API key detected from <code className="bg-[var(--muted)] px-1 rounded">.env</code> file (ANTHROPIC_API_KEY / OPENAI_API_KEY).
                  This works as a global fallback. Per-user settings below take priority.
                </p>
              </div>
            )}
            <div className="space-y-4 max-w-md">
              <div>
                <label className="block text-sm font-medium mb-1">Provider</label>
                <select value={aiProvider} onChange={(e) => handleProviderChange(e.target.value)} className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]">
                  <option value="">Select...</option>
                  <option value="anthropic">Anthropic (Claude)</option>
                  <option value="openai">OpenAI (GPT)</option>
                </select>
              </div>
              {aiProvider && currentModels.length > 0 && (
                <div>
                  <label className="block text-sm font-medium mb-1">Model</label>
                  <select value={aiModel} onChange={(e) => setAiModel(e.target.value)} className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]">
                    {currentModels.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className="block text-sm font-medium mb-1">API Key</label>
                <input
                  type="password"
                  value={aiApiKey}
                  onChange={(e) => setAiApiKey(e.target.value)}
                  placeholder={hasExistingKey ? '••••••••  (saved — enter new key to update)' : 'sk-...'}
                  className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                />
                {hasExistingKey && !aiApiKey && (
                  <p className="text-xs text-[var(--success)] mt-1">
                    API key is saved. Enter a new key only if you want to update it.
                  </p>
                )}
              </div>
              {aiMsg && (
                <p className={`text-sm ${aiMsg.startsWith('Error') ? 'text-[var(--destructive)]' : 'text-[var(--success)]'}`}>
                  {aiMsg}
                </p>
              )}
              <button onClick={handleSaveAi} disabled={!aiProvider || !aiApiKey} className="bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:brightness-90 disabled:opacity-50">
                Save AI Config
              </button>
            </div>
          </div>

          {/* MCP API Keys */}
          <div className="border border-[var(--border)] rounded-lg p-6">
            <h3 className="text-lg font-medium mb-4">MCP API Keys</h3>
            <p className="text-sm text-[var(--muted-foreground)] mb-4">
              Generate personal API keys to authenticate MCP clients (Claude Desktop, ChatGPT, Cursor).
              Each key is linked to your account and respects your assigned MCP role permissions.
            </p>

            {/* Generate new key */}
            <div className="space-y-3 mb-4">
              <div className="flex gap-2 items-end">
                <div className="flex-1 max-w-sm">
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
                  className="bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:brightness-90 disabled:opacity-50"
                >
                  Generate Key
                </button>
              </div>

              {/* Show generated key */}
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
                  <p className="text-xs text-[var(--muted-foreground)] mt-2">
                    Use this key as <code className="bg-[var(--muted)] px-1 rounded">X-API-Key</code> header in your MCP client configuration.
                  </p>
                </div>
              )}

              {keyMsg && (
                <p className={`text-sm ${keyMsg.startsWith('Error') ? 'text-[var(--destructive)]' : 'text-[var(--success)]'}`}>
                  {keyMsg}
                </p>
              )}
            </div>

            {/* Key list */}
            {keyList.length > 0 && (
              <div className="border border-[var(--border)] rounded-lg overflow-hidden">
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
                    {keyList.map((k) => (
                      <tr key={k.id} className="border-t border-[var(--border)]">
                        <td className="px-4 py-2 text-sm">{k.name}</td>
                        <td className="px-4 py-2 font-mono text-xs text-[var(--muted-foreground)]">{k.key}</td>
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
            )}
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
