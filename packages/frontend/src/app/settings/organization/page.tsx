'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';
import { organizations, knowledgeGraph, type KgSettings } from '@/lib/api';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { StatusPill } from '@/components/ui/badge';

export default function OrganizationSettingsPage() {
  const { token, user, orgName, orgs, setOrgName, switchOrg, replaceSession } = useAuth();
  const [name, setName] = useState('');
  const [orgId, setOrgId] = useState('');
  const [createdAt, setCreatedAt] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  // Create new org
  const [newOrgName, setNewOrgName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createMessage, setCreateMessage] = useState('');

  // Delete organization
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Knowledge graph feature toggles
  const [kg, setKg] = useState<KgSettings | null>(null);
  const [kgSaving, setKgSaving] = useState(false);

  const isAdmin = user?.role === 'ADMIN';

  useEffect(() => {
    if (!token) return;
    organizations.getCurrent(token).then((org) => {
      setName(org.name);
      setOrgId(org.id);
      setCreatedAt(org.createdAt);
    }).catch(() => {});
    knowledgeGraph.getSettings(token).then(setKg).catch(() => {});
  }, [token]);

  const updateFlag = async (patch: { enabled?: boolean; llmEnabled?: boolean; captureIntent?: boolean; autoExtend?: boolean; skillAutoApply?: boolean; edgeAutoApply?: boolean }) => {
    if (!token || !kg) return;
    setKgSaving(true);
    try {
      setKg(await knowledgeGraph.updateSettings(token, patch));
    } catch {
      /* keep previous state */
    } finally {
      setKgSaving(false);
    }
  };

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
      await switchOrg(newOrg.id);
    } catch (err: any) {
      setCreateMessage(err.message || 'Failed to create organization');
      setCreating(false);
    }
  };

  const inputClass =
    'w-full h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] outline-none focus:border-[var(--brand)]';
  const inputReadonlyClass =
    'w-full h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] px-3 text-sm text-[var(--text-3)] cursor-not-allowed';
  const labelClass = 'block text-[12.5px] font-medium text-[var(--text-2)] mb-1';

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-[var(--text)]">Organization</h2>
        <p className="text-sm text-[var(--text-2)]">
          {isAdmin
            ? 'Manage your workspace settings. All members of this organization share connectors, MCP servers, and tools.'
            : 'View your current organization and create new workspaces.'}
        </p>
      </div>

      {/* Current organization — editable only for ADMIN */}
      <Card className="p-5 space-y-4">
        <div>
          <label className={labelClass}>Organization Name</label>
          {isAdmin ? (
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
              placeholder="My Workspace"
            />
          ) : (
            <p className="flex h-9 items-center rounded-[9px] bg-[var(--surface-2)] border border-[var(--border)] px-3 text-sm text-[var(--text-2)]">
              {name}
            </p>
          )}
        </div>

        <div>
          <label className={labelClass}>Organization ID</label>
          <input
            type="text"
            value={orgId}
            readOnly
            className={inputReadonlyClass}
          />
        </div>

        <div>
          <label className={labelClass}>Your Role</label>
          <p className="text-sm text-[var(--text-2)]">{user?.role}</p>
        </div>

        {createdAt && (
          <div>
            <label className={labelClass}>Created</label>
            <p className="text-sm text-[var(--text-2)]">
              {new Date(createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}
            </p>
          </div>
        )}

        {message && (
          <p className={`text-sm ${message.includes('success') ? 'text-[var(--ok)]' : 'text-[var(--danger)]'}`}>
            {message}
          </p>
        )}

        {isAdmin && (
          <div className="pt-2">
            <Button onClick={handleSave} disabled={saving || !name.trim()}>
              {saving ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        )}
      </Card>

      {/* Features */}
      <Card className="p-5 space-y-4">
        <h3 className="text-sm font-semibold text-[var(--text)]">Features</h3>

        <FeatureToggle
          label="Knowledge Graph"
          description="Auto-discovers relationships between your connectors' entities (from tool definitions and real usage) and exposes them to agents. Disabling it stops graph building, hides the page, and removes the MCP helper tool."
          checked={!!kg?.enabled}
          disabled={!isAdmin || kgSaving || !kg}
          isAdmin={isAdmin}
          onToggle={() => updateFlag({ enabled: !kg?.enabled })}
        />

        {kg?.llmAvailable && (
          <FeatureToggle
            label="AI enrichment"
            description="Let an LLM suggest extra relationships the heuristics miss (e.g. that a CRM person, a billing customer and a support user are the same person). Only entity and field names are sent — never your data. Suggestions await your confirmation. May incur model costs."
            checked={!!kg?.llmEnabled}
            disabled={!isAdmin || kgSaving || !kg?.enabled}
            isAdmin={isAdmin}
            onToggle={() => updateFlag({ llmEnabled: !kg?.llmEnabled })}
          />
        )}

        {kg?.llmAvailable && (
          <FeatureToggle
            label="Auto-apply high-confidence connections"
            description="When AI enrichment suggests a connection it is confident about (≥ 0.90), add it to the graph automatically instead of leaving it for manual review. Lower-confidence links still wait for your confirmation. No extra model cost — it only changes how existing suggestions are handled."
            checked={!!kg?.edgeAutoApply}
            disabled={!isAdmin || kgSaving || !kg?.enabled || !kg?.llmEnabled}
            isAdmin={isAdmin}
            onToggle={() => updateFlag({ edgeAutoApply: !kg?.edgeAutoApply })}
          />
        )}

        <FeatureToggle
          label="Capture user intent"
          description="Adds an optional parameter to every MCP tool asking the agent for the user's original request. Captures the context behind each call so the graph can be optimized and skills suggested over time."
          checked={!!kg?.captureIntent}
          disabled={!isAdmin || kgSaving || !kg?.enabled}
          isAdmin={isAdmin}
          onToggle={() => updateFlag({ captureIntent: !kg?.captureIntent })}
        />

        {kg?.llmAvailable && (
          <FeatureToggle
            label="Scheduled AI extension"
            description="On a schedule (roughly daily), let the AI extend the graph and generate skills from the captured user intents — so your network and skills keep improving on their own. Cost-careful: it only runs every so often, skips when nothing changed, and stays off until you enable it. Requires AI enrichment + Capture user intent."
            checked={!!kg?.autoExtend}
            disabled={!isAdmin || kgSaving || !kg?.enabled || !kg?.llmEnabled}
            isAdmin={isAdmin}
            onToggle={() => updateFlag({ autoExtend: !kg?.autoExtend })}
          />
        )}

        {kg?.llmAvailable && (
          <FeatureToggle
            label="Auto-apply high-confidence skills"
            description="When AI generates a skill it is confident about (≥ 0.90), apply it automatically instead of leaving it as a suggestion to review. Lower-confidence skills still wait for manual approval."
            checked={!!kg?.skillAutoApply}
            disabled={!isAdmin || kgSaving || !kg?.enabled || !kg?.llmEnabled}
            isAdmin={isAdmin}
            onToggle={() => updateFlag({ skillAutoApply: !kg?.skillAutoApply })}
          />
        )}
      </Card>

      {/* Danger Zone — ADMIN only */}
      {isAdmin && (
        <Card className="p-5 space-y-3 border-[var(--danger)]/30 bg-[var(--t-danger-bg)]">
          <h3 className="text-sm font-semibold text-[var(--danger)]">Danger Zone</h3>
          <p className="text-xs text-[var(--text-2)]">
            Permanently delete this organization, including all members, connectors, MCP servers,
            API keys, custom roles, pending invitations, and settings. Other members will be
            migrated to their next-oldest workspace if they have one. This action cannot be undone.
          </p>
          <Button variant="danger" onClick={() => setDeleteOpen(true)}>
            Delete this organization
          </Button>
        </Card>
      )}

      <Dialog.Root open={deleteOpen} onOpenChange={(open) => { if (!open) resetDeleteOrgDialog(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]">
            <Dialog.Title className="text-base font-semibold text-[var(--text)] mb-2">Delete organization</Dialog.Title>
            <Dialog.Description className="text-sm text-[var(--text-2)] mb-4">
              This deletes <strong>{name}</strong> and everything it contains. To confirm, type the
              organization name below.
            </Dialog.Description>

            <div className="space-y-3">
              <div>
                <label className={labelClass}>Type <code className="font-mono">{name}</code> to confirm</label>
                <input
                  type="text"
                  value={deleteConfirmName}
                  onChange={(e) => setDeleteConfirmName(e.target.value)}
                  className={inputClass}
                  autoComplete="off"
                  placeholder={name}
                />
              </div>
              {deleteError && (
                <p className="text-sm text-[var(--danger)]">{deleteError}</p>
              )}
            </div>

            <div className="flex gap-2 justify-end mt-6">
              <Dialog.Close asChild>
                <Button variant="secondary">Cancel</Button>
              </Dialog.Close>
              <Button
                variant="danger"
                onClick={handleDeleteOrg}
                disabled={deleting || deleteConfirmName.trim() !== name.trim()}
              >
                {deleting ? 'Deleting…' : 'Delete organization'}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* My organizations list + create new — available to ALL users */}
      <Card className="p-5">
        <h3 className="text-sm font-semibold text-[var(--text)]">My Organizations</h3>
        {orgs && orgs.length > 0 && (
          <div className="mt-3">
            {orgs.map((org, index) => {
              const isActive = org.id === user?.organizationId;
              return (
                <div key={org.id}>
                  {index > 0 && (
                    <div className="border-t border-[var(--border)]" />
                  )}
                  <div className={`flex items-center justify-between px-2 rounded-[9px] ${isActive ? 'bg-[var(--surface-2)] py-[7px] my-[7px]' : 'py-2.5'}`}>
                    <div className="min-w-0">
                      <p className={`text-sm truncate text-[var(--text)] ${isActive ? 'font-medium' : ''}`}>
                        {org.name}
                      </p>
                      <p className="text-xs text-[var(--text-3)]">
                        {org.role} &middot; Joined {new Date(org.joinedAt).toLocaleDateString()}
                      </p>
                    </div>
                    {isActive ? (
                      <StatusPill tone="brand" className="flex-shrink-0">Active</StatusPill>
                    ) : (
                      <Button variant="secondary" size="sm" onClick={() => switchOrg(org.id)} className="flex-shrink-0">
                        Switch
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div className="space-y-2 mt-8">
          <p className="text-xs font-medium text-[var(--text-3)]">Create New Organization</p>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={newOrgName}
              onChange={(e) => setNewOrgName(e.target.value)}
              className="flex-1 h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] outline-none focus:border-[var(--brand)]"
              placeholder="New organization name"
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateOrg(); }}
            />
            <Button onClick={handleCreateOrg} disabled={creating || !newOrgName.trim()} className="sm:flex-shrink-0">
              {creating ? 'Creating...' : 'Create Organization'}
            </Button>
          </div>
          {createMessage && (
            <p className={`text-sm ${createMessage.includes('created') ? 'text-[var(--ok)]' : 'text-[var(--danger)]'}`}>
              {createMessage}
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}

function FeatureToggle({
  label,
  description,
  checked,
  disabled,
  isAdmin,
  onToggle,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  isAdmin: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-[var(--text)]">{label}</p>
        <p className="text-xs text-[var(--text-2)] mt-0.5">{description}</p>
      </div>
      <button
        onClick={onToggle}
        disabled={disabled}
        role="switch"
        aria-checked={checked}
        title={isAdmin ? '' : 'Only admins can change this'}
        className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
          checked ? 'bg-[var(--brand)]' : 'bg-[var(--border-strong)]'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            checked ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
    </div>
  );
}
