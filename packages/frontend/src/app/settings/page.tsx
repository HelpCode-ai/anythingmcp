'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';
import { users, server, ApiError } from '@/lib/api';
import * as Dialog from '@radix-ui/react-dialog';

const AUTH_MODE_LABELS: Record<string, string> = {
  none: 'None (not recommended)',
  legacy: 'Legacy (Bearer Token / API Key)',
  oauth2: 'OAuth 2.0 (Authorization Code + Client Credentials)',
  both: 'Both (OAuth 2.0 + Legacy)',
};

export default function SettingsPage() {
  const { token, user, updateUser, logout } = useAuth();
  const [profileName, setProfileName] = useState(user?.name || '');
  const [profileMsg, setProfileMsg] = useState('');
  // Change password
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [passwordMsg, setPasswordMsg] = useState('');
  const [mcpAuthMode, setMcpAuthMode] = useState('');
  const [oauthEndpoints, setOauthEndpoints] = useState<Record<string, string> | null>(null);
  const [serverUrl, setServerUrl] = useState('');

  // Delete account
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [blockingOrgs, setBlockingOrgs] = useState<{ id: string; name: string }[] | null>(null);

  // Load server info
  useEffect(() => {
    server.info().then((info) => {
      setMcpAuthMode(info.mcpAuthMode);
      setOauthEndpoints(info.oauthEndpoints);
      setServerUrl(info.serverUrl);
    }).catch(() => {});
  }, []);

  const handleSaveProfile = async () => {
    if (!token) return;
    try {
      await users.updateProfile({ name: profileName }, token);
      updateUser({ name: profileName });
      setProfileMsg('Profile updated');
      setTimeout(() => setProfileMsg(''), 3000);
    } catch (err: any) {
      setProfileMsg(`Error: ${err.message}`);
    }
  };

  const handleDeleteAccount = async () => {
    if (!token) return;
    if (deleteConfirm !== 'DELETE') return;
    setDeleting(true);
    setDeleteError(null);
    setBlockingOrgs(null);
    try {
      await users.deleteSelf({ password: deletePassword, confirm: 'DELETE' }, token);
      logout();
    } catch (err: any) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          setDeleteError('Incorrect password.');
        } else if (err.status === 409 && Array.isArray(err.body?.blockingOrganizations)) {
          setBlockingOrgs(err.body.blockingOrganizations);
          setDeleteError(err.body?.error || 'You are the only admin of these organizations.');
        } else {
          setDeleteError(err.message || 'Failed to delete account.');
        }
      } else {
        setDeleteError(err?.message || 'Failed to delete account.');
      }
      setDeleting(false);
    }
  };

  const resetDeleteDialog = () => {
    setDeleteOpen(false);
    setDeletePassword('');
    setDeleteConfirm('');
    setDeleteError(null);
    setBlockingOrgs(null);
    setDeleting(false);
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

  return (
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
            className="bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50"
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

      {/* MCP API Keys note */}
      <div className="border border-[var(--border)] rounded-lg p-6">
        <h3 className="text-lg font-medium mb-2">MCP API Keys</h3>
        <p className="text-sm text-[var(--muted-foreground)]">
          API keys are now managed per MCP server. Go to{' '}
          <a href="/mcp-server" className="text-[var(--brand)] hover:underline">MCP Servers</a>{' '}
          to generate and manage keys for each server.
        </p>
      </div>

      {/* Danger Zone */}
      <div className="border border-[var(--destructive-border)] rounded-lg p-6 bg-[var(--destructive-bg)]/30">
        <h3 className="text-lg font-medium text-[var(--destructive-text)] mb-2">Danger Zone</h3>
        <p className="text-sm text-[var(--muted-foreground)] mb-4">
          Permanently delete your account. This will remove your profile, password reset tokens,
          email verification tokens, MCP API keys, connectors, and MCP server configurations.
          Audit logs are retained without your identifying information.
        </p>
        <button
          onClick={() => setDeleteOpen(true)}
          className="border border-[var(--destructive)] text-[var(--destructive)] px-4 py-2 rounded-md text-sm font-medium hover:bg-[var(--destructive-bg)]"
        >
          Delete my account
        </button>
      </div>

      <Dialog.Root open={deleteOpen} onOpenChange={(open) => { if (!open) resetDeleteDialog(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[var(--border)] bg-[var(--card)] p-6 shadow-lg">
            <Dialog.Title className="text-lg font-medium mb-2">Delete account</Dialog.Title>
            <Dialog.Description className="text-sm text-[var(--muted-foreground)] mb-4">
              This action cannot be undone. Enter your password and type <strong>DELETE</strong> to confirm.
            </Dialog.Description>

            {blockingOrgs && blockingOrgs.length > 0 && (
              <div className="mb-4 p-3 rounded-md border border-[var(--destructive-border)] bg-[var(--destructive-bg)] text-sm text-[var(--destructive-text)]">
                <p className="font-medium mb-1">Cannot delete — you are the only admin of:</p>
                <ul className="list-disc pl-5 space-y-0.5">
                  {blockingOrgs.map((o) => (
                    <li key={o.id}>{o.name}</li>
                  ))}
                </ul>
                <p className="mt-2">
                  Promote another admin or delete those organizations first.
                </p>
              </div>
            )}

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium mb-1">Password</label>
                <input
                  type="password"
                  value={deletePassword}
                  onChange={(e) => setDeletePassword(e.target.value)}
                  className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Type <code>DELETE</code> to confirm</label>
                <input
                  type="text"
                  value={deleteConfirm}
                  onChange={(e) => setDeleteConfirm(e.target.value)}
                  className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                  autoComplete="off"
                />
              </div>
              {deleteError && !blockingOrgs && (
                <p className="text-sm text-[var(--destructive)]">{deleteError}</p>
              )}
            </div>

            <div className="flex gap-2 justify-end mt-6">
              <Dialog.Close className="border border-[var(--border)] px-4 py-2 rounded-md text-sm hover:bg-[var(--accent)]">
                Cancel
              </Dialog.Close>
              <button
                onClick={handleDeleteAccount}
                disabled={deleting || deleteConfirm !== 'DELETE' || !deletePassword}
                className="bg-[var(--destructive)] text-white px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50"
              >
                {deleting ? 'Deleting…' : 'Delete my account'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
