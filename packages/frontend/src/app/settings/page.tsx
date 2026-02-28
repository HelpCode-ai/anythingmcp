'use client';

import { useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { users } from '@/lib/api';
import { NavBar } from '@/components/nav-bar';

export default function SettingsPage() {
  const { token, user } = useAuth();
  const [profileName, setProfileName] = useState(user?.name || '');
  const [profileMsg, setProfileMsg] = useState('');
  const [aiProvider, setAiProvider] = useState('');
  const [aiApiKey, setAiApiKey] = useState('');
  const [aiMsg, setAiMsg] = useState('');

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

  const handleSaveAi = async () => {
    if (!token || !aiProvider || !aiApiKey) return;
    try {
      await users.updateAiConfig({ provider: aiProvider, apiKey: aiApiKey }, token);
      setAiMsg('AI configuration saved');
      setTimeout(() => setAiMsg(''), 3000);
    } catch (err: any) {
      setAiMsg(`Error: ${err.message}`);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--background)]">
      <NavBar
        breadcrumbs={[{ label: 'Dashboard', href: '/' }]}
        title="Settings"
      />

      <main className="max-w-7xl mx-auto px-6 py-8">
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
              <button onClick={handleSaveProfile} className="bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:opacity-90">
                Save Profile
              </button>
            </div>
          </div>

          {/* MCP Auth */}
          <div className="border border-[var(--border)] rounded-lg p-6">
            <h3 className="text-lg font-medium mb-4">MCP Server Authentication</h3>
            <p className="text-sm text-[var(--muted-foreground)] mb-4">
              Configure how MCP clients (Claude, ChatGPT, Cursor) authenticate to your server.
              Set MCP_BEARER_TOKEN or MCP_API_KEY in environment variables.
            </p>
            <div className="space-y-4 max-w-md">
              <div>
                <label className="block text-sm font-medium mb-1">Auth Method</label>
                <select className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]">
                  <option value="none">None (not recommended)</option>
                  <option value="bearer">Bearer Token (MCP_BEARER_TOKEN)</option>
                  <option value="apikey">API Key (MCP_API_KEY)</option>
                </select>
              </div>
              <p className="text-xs text-[var(--muted-foreground)]">
                MCP server auth is configured via environment variables for security. See .env.example.
              </p>
            </div>
          </div>

          {/* AI Provider */}
          <div className="border border-[var(--border)] rounded-lg p-6">
            <h3 className="text-lg font-medium mb-4">Default AI Provider</h3>
            <p className="text-sm text-[var(--muted-foreground)] mb-4">
              Save your preferred AI provider and API key for the AI assistant.
            </p>
            <div className="space-y-4 max-w-md">
              <div>
                <label className="block text-sm font-medium mb-1">Provider</label>
                <select value={aiProvider} onChange={(e) => setAiProvider(e.target.value)} className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]">
                  <option value="">Select...</option>
                  <option value="anthropic">Claude (Anthropic)</option>
                  <option value="openai">GPT-4o (OpenAI)</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">API Key</label>
                <input type="password" value={aiApiKey} onChange={(e) => setAiApiKey(e.target.value)} placeholder="sk-..." className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]" />
              </div>
              {aiMsg && (
                <p className={`text-sm ${aiMsg.startsWith('Error') ? 'text-[var(--destructive)]' : 'text-[var(--success)]'}`}>
                  {aiMsg}
                </p>
              )}
              <button onClick={handleSaveAi} disabled={!aiProvider || !aiApiKey} className="bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50">
                Save AI Config
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
