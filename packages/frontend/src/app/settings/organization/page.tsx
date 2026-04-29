'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';
import { organizations } from '@/lib/api';
import * as Dialog from '@radix-ui/react-dialog';

export default function OrganizationSettingsPage() {
  const { token, user, orgName, orgs, setOrgName, switchOrg, replaceSession } = useAuth();
  const [name, setName] = useState('');
  const [orgId, setOrgId] = useState('');
  const [createdAt, setCreatedAt] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  // Create new org
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newOrgName, setNewOrgName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createMessage, setCreateMessage] = useState('');

  // Delete organization
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const isAdmin = user?.role === 'ADMIN';

  useEffect(() => {
    if (!token) return;
    organizations.getCurrent(token).then((org) => {
      setName(org.name);
      setOrgId(org.id);
      setCreatedAt(org.createdAt);
    }).catch(() => {});
  }, [token]);

  const handleSave = async () => {
    if (!token || !name.trim()) return;
    setSaving(true);
    setMessage('');
    try {
      const updated = await organizations.updateCurrent({ name: name.trim() }, token);
      setName(updated.name);
      setOrgName(updated.name);
      setMessage('Organization updated successfully');
    } catch (err: any) {
      setMessage(err.message || 'Failed to update organization');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteOrg = async () => {
    if (!token) return;
    if (deleteConfirmName.trim() !== name.trim()) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = await organizations.deleteCurrent({ confirmName: deleteConfirmName.trim() }, token);
      replaceSession(result.accessToken, result.user, result.organization?.name ?? null);
      window.location.href = '/';
    } catch (err: any) {
      setDeleteError(err?.message || 'Failed to delete organization');
      setDeleting(false);
    }
  };

  const resetDeleteOrgDialog = () => {
    setDeleteOpen(false);
    setDeleteConfirmName('');
    setDeleteError(null);
    setDeleting(false);
  };

  const handleCreateOrg = async () => {
    if (!token || !newOrgName.trim()) return;
    setCreating(true);
    setCreateMessage('');
    try {
      const newOrg = await organizations.create(newOrgName.trim(), token);
      setCreateMessage('Organization created! Switching...');
      setNewOrgName('');
      setShowCreateForm(false);
      await switchOrg(newOrg.id);
    } catch (err: any) {
      setCreateMessage(err.message || 'Failed to create organization');
      setCreating(false);
    }
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-lg font-semibold">Organization</h2>
        <p className="text-sm text-[var(--muted-foreground)]">
          {isAdmin
            ? 'Manage your workspace settings. All members of this organization share connectors, MCP servers, and tools.'
            : 'View your current organization and create new workspaces.'}
        </p>
      </div>

      {/* Current organization — editable only for ADMIN */}
      <div className="bg-[var(--card)] border border-[var(--border)] rounded-lg p-5 space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Organization Name</label>
          {isAdmin ? (
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-[var(--background)] border border-[var(--border)] rounded-lg text-sm focus:ring-2 focus:ring-[var(--brand)] focus:border-transparent outline-none"
              placeholder="My Workspace"
            />
          ) : (
            <p className="px-3 py-2 bg-[var(--accent)] border border-[var(--border)] rounded-lg text-sm text-[var(--muted-foreground)]">
              {name}
            </p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Organization ID</label>
          <input
            type="text"
            value={orgId}
            readOnly
            className="w-full px-3 py-2 bg-[var(--accent)] border border-[var(--border)] rounded-lg text-sm text-[var(--muted-foreground)] cursor-not-allowed"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Your Role</label>
          <p className="text-sm text-[var(--muted-foreground)]">{user?.role}</p>
        </div>

        {createdAt && (
          <div>
            <label className="block text-sm font-medium mb-1">Created</label>
            <p className="text-sm text-[var(--muted-foreground)]">
              {new Date(createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}
            </p>
          </div>
        )}

        {message && (
          <p className={`text-sm ${message.includes('success') ? 'text-green-600' : 'text-[var(--destructive)]'}`}>
            {message}
          </p>
        )}

        {isAdmin && (
          <div className="pt-2">
            <button
              onClick={handleSave}
              disabled={saving || !name.trim()}
              className="px-4 py-2 bg-[var(--brand)] text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        )}
      </div>

      {/* Create new organization — available to ALL users */}
      <div className="bg-[var(--card)] border border-[var(--border)] rounded-lg p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">Create New Organization</h3>
            <p className="text-xs text-[var(--muted-foreground)] mt-0.5">
              Create a separate workspace with its own connectors, MCP servers, and team. You will be the admin.
            </p>
          </div>
          {!showCreateForm && (
            <button
              onClick={() => { setShowCreateForm(true); setCreateMessage(''); }}
              className="px-3 py-1.5 border border-[var(--border)] rounded-lg text-sm hover:bg-[var(--accent)] transition-colors"
            >
              + New Organization
            </button>
          )}
        </div>

        {showCreateForm && (
          <div className="space-y-3 pt-2 border-t border-[var(--border)]">
            <div>
              <label className="block text-sm font-medium mb-1">Name</label>
              <input
                type="text"
                value={newOrgName}
                onChange={(e) => setNewOrgName(e.target.value)}
                className="w-full px-3 py-2 bg-[var(--background)] border border-[var(--border)] rounded-lg text-sm focus:ring-2 focus:ring-[var(--brand)] focus:border-transparent outline-none"
                placeholder="My New Workspace"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreateOrg(); }}
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleCreateOrg}
                disabled={creating || !newOrgName.trim()}
                className="px-4 py-2 bg-[var(--brand)] text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                {creating ? 'Creating...' : 'Create & Switch'}
              </button>
              <button
                onClick={() => { setShowCreateForm(false); setNewOrgName(''); setCreateMessage(''); }}
                className="px-4 py-2 border border-[var(--border)] rounded-lg text-sm hover:bg-[var(--accent)] transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {createMessage && (
          <p className={`text-sm ${createMessage.includes('created') ? 'text-green-600' : 'text-[var(--destructive)]'}`}>
            {createMessage}
          </p>
        )}
      </div>

      {/* Danger Zone — ADMIN only */}
      {isAdmin && (
        <div className="border border-[var(--destructive-border)] rounded-lg p-5 bg-[var(--destructive-bg)]/30 space-y-3">
          <h3 className="text-sm font-semibold text-[var(--destructive-text)]">Danger Zone</h3>
          <p className="text-xs text-[var(--muted-foreground)]">
            Permanently delete this organization, including all members, connectors, MCP servers,
            API keys, custom roles, pending invitations, and settings. Other members will be
            migrated to their next-oldest workspace if they have one. This action cannot be undone.
          </p>
          <button
            onClick={() => setDeleteOpen(true)}
            className="border border-[var(--destructive)] text-[var(--destructive)] px-4 py-2 rounded-md text-sm font-medium hover:bg-[var(--destructive-bg)]"
          >
            Delete this organization
          </button>
        </div>
      )}

      <Dialog.Root open={deleteOpen} onOpenChange={(open) => { if (!open) resetDeleteOrgDialog(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[var(--border)] bg-[var(--card)] p-6 shadow-lg">
            <Dialog.Title className="text-lg font-medium mb-2">Delete organization</Dialog.Title>
            <Dialog.Description className="text-sm text-[var(--muted-foreground)] mb-4">
              This deletes <strong>{name}</strong> and everything it contains. To confirm, type the
              organization name below.
            </Dialog.Description>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium mb-1">Type <code>{name}</code> to confirm</label>
                <input
                  type="text"
                  value={deleteConfirmName}
                  onChange={(e) => setDeleteConfirmName(e.target.value)}
                  className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                  autoComplete="off"
                  placeholder={name}
                />
              </div>
              {deleteError && (
                <p className="text-sm text-[var(--destructive)]">{deleteError}</p>
              )}
            </div>

            <div className="flex gap-2 justify-end mt-6">
              <Dialog.Close className="border border-[var(--border)] px-4 py-2 rounded-md text-sm hover:bg-[var(--accent)]">
                Cancel
              </Dialog.Close>
              <button
                onClick={handleDeleteOrg}
                disabled={deleting || deleteConfirmName.trim() !== name.trim()}
                className="bg-[var(--destructive)] text-white px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50"
              >
                {deleting ? 'Deleting…' : 'Delete organization'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* My organizations list — available to ALL users */}
      {orgs && orgs.length > 1 && (
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-lg p-5 space-y-3">
          <h3 className="text-sm font-semibold">My Organizations</h3>
          <div className="divide-y divide-[var(--border)]">
            {orgs.map((org) => {
              const isActive = org.id === user?.organizationId;
              return (
                <div key={org.id} className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <p className={`text-sm truncate ${isActive ? 'font-medium text-[var(--brand)]' : ''}`}>
                      {org.name}
                    </p>
                    <p className="text-xs text-[var(--muted-foreground)]">
                      {org.role} &middot; Joined {new Date(org.joinedAt).toLocaleDateString()}
                    </p>
                  </div>
                  {isActive ? (
                    <span className="text-xs bg-[var(--brand-light)] text-[var(--brand)] px-2 py-0.5 rounded-full font-medium flex-shrink-0">
                      Active
                    </span>
                  ) : (
                    <button
                      onClick={() => switchOrg(org.id)}
                      className="text-xs px-3 py-1 border border-[var(--border)] rounded-lg hover:bg-[var(--accent)] transition-colors flex-shrink-0"
                    >
                      Switch
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
