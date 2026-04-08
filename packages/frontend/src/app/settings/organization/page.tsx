'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';
import { organizations } from '@/lib/api';

export default function OrganizationSettingsPage() {
  const { token, user, orgName, orgs, setOrgName, switchOrg } = useAuth();
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
