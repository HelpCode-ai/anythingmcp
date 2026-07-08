'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';
import { users, server, ApiError } from '@/lib/api';
import * as Dialog from '@radix-ui/react-dialog';
import { useToast } from '@/components/toast';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { StatusPill } from '@/components/ui/badge';

const AUTH_MODE_LABELS: Record<string, string> = {
  none: 'None (not recommended)',
  legacy: 'Legacy (Bearer Token / API Key)',
  oauth2: 'OAuth 2.0 (Authorization Code + Client Credentials)',
  both: 'Both (OAuth 2.0 + Legacy)',
};

export default function SettingsPage() {
  const toast = useToast();

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
      setProfileMsg('');
      toast.show({ tone: 'success', title: 'Profile updated' });
    } catch (err: any) {
      const message = err?.message || 'Could not update profile';
      setProfileMsg(`Error: ${message}`);
      toast.show({ tone: 'error', title: 'Profile update failed', description: message });
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
      toast.show({ tone: 'error', title: 'Passwords do not match' });
      return;
    }
    try {
      const result = await users.changePassword({ currentPassword, newPassword }, token);
      if (result.error) {
        setPasswordMsg(`Error: ${result.error}`);
        toast.show({ tone: 'error', title: 'Password change failed', description: result.error });
      } else {
        setPasswordMsg('');
        setCurrentPassword('');
        setNewPassword('');
        setConfirmNewPassword('');
        toast.show({ tone: 'success', title: 'Password changed' });
      }
    } catch (err: any) {
      const message = err?.message || 'Could not change password';
      setPasswordMsg(`Error: ${message}`);
      toast.show({ tone: 'error', title: 'Password change failed', description: message });
    }
  };

  const inputClass =
    'w-full h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] outline-none focus:border-[var(--brand)]';
  const inputDisabledClass =
    'w-full h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] px-3 text-sm text-[var(--text-3)]';
  const labelClass = 'block text-[12.5px] font-medium text-[var(--text-2)] mb-1';

  return (
    <div className="space-y-6">
      {/* Profile */}
      <Card className="p-[22px]">
        <h3 className="text-sm font-semibold text-[var(--text)] mb-4">Profile</h3>
        <div className="space-y-4 max-w-md">
          <div>
            <label htmlFor="settings-profile-email" className={labelClass}>Email</label>
            <input id="settings-profile-email" name="email" autoComplete="email" type="text" value={user?.email || ''} disabled className={inputDisabledClass} />
          </div>
          <div>
            <label htmlFor="settings-profile-name" className={labelClass}>Name</label>
            <input id="settings-profile-name" name="name" autoComplete="name" type="text" value={profileName} onChange={(e) => setProfileName(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label htmlFor="settings-profile-role" className={labelClass}>Role</label>
            <input id="settings-profile-role" type="text" value={user?.role || ''} disabled className={inputDisabledClass} />
          </div>
          {profileMsg && (
            <p className={`text-sm ${profileMsg.startsWith('Error') ? 'text-[var(--danger)]' : 'text-[var(--ok)]'}`}>
              {profileMsg}
            </p>
          )}
          <Button onClick={handleSaveProfile}>Save Profile</Button>
        </div>
      </Card>

      {/* Change Password */}
      <Card className="p-[22px]">
        <h3 className="text-sm font-semibold text-[var(--text)] mb-4">Change Password</h3>
        <div className="space-y-4 max-w-md">
          <div>
            <label htmlFor="settings-current-password" className={labelClass}>Current Password</label>
            <input
              id="settings-current-password"
              name="current-password"
              autoComplete="current-password"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="settings-new-password" className={labelClass}>New Password</label>
            <input
              id="settings-new-password"
              name="new-password"
              autoComplete="new-password"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Min. 8 characters"
              minLength={8}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="settings-confirm-new-password" className={labelClass}>Confirm New Password</label>
            <input
              id="settings-confirm-new-password"
              name="confirm-new-password"
              autoComplete="new-password"
              type="password"
              value={confirmNewPassword}
              onChange={(e) => setConfirmNewPassword(e.target.value)}
              placeholder="Repeat new password"
              minLength={8}
              className={inputClass}
            />
          </div>
          {passwordMsg && (
            <p className={`text-sm ${passwordMsg.startsWith('Error') ? 'text-[var(--danger)]' : 'text-[var(--ok)]'}`}>
              {passwordMsg}
            </p>
          )}
          <Button
            onClick={handleChangePassword}
            disabled={!currentPassword || !newPassword || newPassword.length < 8}
          >
            Change Password
          </Button>
        </div>
      </Card>

      {/* MCP Auth */}
      <Card className="p-[22px]">
        <h3 className="text-sm font-semibold text-[var(--text)] mb-2">MCP Server Authentication</h3>
        <p className="text-sm text-[var(--text-2)] mb-4">
          Configure how MCP clients (Claude, ChatGPT, Cursor) authenticate to your server.
        </p>
        <div className="space-y-4 max-w-lg">
          <div>
            <label className={labelClass}>Auth Method</label>
            <div className="flex items-center gap-3">
              <div className="flex-1 h-9 flex items-center rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] px-3 text-sm text-[var(--text-2)]">
                {AUTH_MODE_LABELS[mcpAuthMode] || mcpAuthMode || 'Loading...'}
              </div>
              {(mcpAuthMode === 'oauth2' || mcpAuthMode === 'both') && (
                <StatusPill tone="success" dot="var(--ok)">Active</StatusPill>
              )}
            </div>
          </div>

          {/* OAuth2 info */}
          {(mcpAuthMode === 'oauth2' || mcpAuthMode === 'both') && oauthEndpoints && (
            <div className="rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] p-4 space-y-3">
              <h4 className="text-sm font-semibold text-[var(--text)]">OAuth 2.0 Endpoints</h4>
              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs font-mono text-[var(--text)]">
                <span className="text-[var(--text-3)]">Discovery:</span>
                <span>{serverUrl}{oauthEndpoints.wellKnown}</span>
                <span className="text-[var(--text-3)]">Authorize:</span>
                <span>{serverUrl}{oauthEndpoints.authorize}</span>
                <span className="text-[var(--text-3)]">Token:</span>
                <span>{serverUrl}{oauthEndpoints.token}</span>
                <span className="text-[var(--text-3)]">Register:</span>
                <span>{serverUrl}{oauthEndpoints.register}</span>
              </div>
              <p className="text-xs text-[var(--text-3)]">
                Supports Authorization Code (with PKCE) and Client Credentials grant types.
                MCP clients like Claude Desktop will auto-discover these endpoints.
              </p>
            </div>
          )}

          {/* Legacy info */}
          {(mcpAuthMode === 'legacy' || mcpAuthMode === 'both') && (
            <div className="rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] p-4 space-y-2">
              <h4 className="text-sm font-semibold text-[var(--text)]">Legacy Authentication</h4>
              <p className="text-xs text-[var(--text-3)]">
                Set <code className="bg-[var(--surface-3)] px-1 rounded font-mono">MCP_BEARER_TOKEN</code> or <code className="bg-[var(--surface-3)] px-1 rounded font-mono">MCP_API_KEY</code> in your environment variables.
              </p>
            </div>
          )}

          <p className="text-xs text-[var(--text-3)]">
            Auth mode is configured via the <code className="bg-[var(--surface-3)] px-1 rounded font-mono">MCP_AUTH_MODE</code> environment variable.
            Set it to <code className="bg-[var(--surface-3)] px-1 rounded font-mono">oauth2</code>, <code className="bg-[var(--surface-3)] px-1 rounded font-mono">legacy</code>, <code className="bg-[var(--surface-3)] px-1 rounded font-mono">both</code>, or <code className="bg-[var(--surface-3)] px-1 rounded font-mono">none</code>.
          </p>
        </div>
      </Card>

      {/* MCP API Keys note */}
      <Card className="p-[22px]">
        <h3 className="text-sm font-semibold text-[var(--text)] mb-2">MCP API Keys</h3>
        <p className="text-sm text-[var(--text-2)]">
          API keys are now managed per MCP server. Go to{' '}
          <a href="/mcp-server" className="text-[var(--brand)] hover:underline">MCP Servers</a>{' '}
          to generate and manage keys for each server.
        </p>
      </Card>

      {/* Danger Zone */}
      <Card className="p-[22px] border-[var(--danger)]/30 bg-[var(--t-danger-bg)]">
        <h3 className="text-sm font-semibold text-[var(--danger)] mb-2">Danger Zone</h3>
        <p className="text-sm text-[var(--text-2)] mb-4">
          Permanently delete your account. This will remove your profile, password reset tokens,
          email verification tokens, MCP API keys, connectors, and MCP server configurations.
          Audit logs are retained without your identifying information.
        </p>
        <Button variant="danger" onClick={() => setDeleteOpen(true)}>
          Delete my account
        </Button>
      </Card>

      <Dialog.Root open={deleteOpen} onOpenChange={(open) => { if (!open) resetDeleteDialog(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]">
            <Dialog.Title className="text-base font-semibold text-[var(--text)] mb-2">Delete account</Dialog.Title>
            <Dialog.Description className="text-sm text-[var(--text-2)] mb-4">
              This action cannot be undone. Enter your password and type <strong>DELETE</strong> to confirm.
            </Dialog.Description>

            {blockingOrgs && blockingOrgs.length > 0 && (
              <div className="mb-4 p-3 rounded-[9px] border border-[var(--danger)]/30 bg-[var(--t-danger-bg)] text-sm text-[var(--t-danger-fg)]">
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
                <label className={labelClass}>Password</label>
                <input
                  type="password"
                  value={deletePassword}
                  onChange={(e) => setDeletePassword(e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Type <code className="font-mono">DELETE</code> to confirm</label>
                <input
                  type="text"
                  value={deleteConfirm}
                  onChange={(e) => setDeleteConfirm(e.target.value)}
                  className={inputClass}
                  autoComplete="off"
                />
              </div>
              {deleteError && !blockingOrgs && (
                <p className="text-sm text-[var(--danger)]">{deleteError}</p>
              )}
            </div>

            <div className="flex gap-2 justify-end mt-6">
              <Dialog.Close asChild>
                <Button variant="secondary">Cancel</Button>
              </Dialog.Close>
              <Button
                variant="danger"
                onClick={handleDeleteAccount}
                disabled={deleting || deleteConfirm !== 'DELETE' || !deletePassword}
              >
                {deleting ? 'Deleting…' : 'Delete my account'}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
