'use client';

import { useEffect, useState } from 'react';
import {
  identityProviders,
  roles as rolesApi,
  type IdentityProvider,
  type RoleMapping,
} from '@/lib/api';
import { AppSelect } from '@/components/ui/select';
import { MultiSelect } from '@/components/ui/multi-select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/toast';

const ORG_ROLE_OPTIONS = [
  { value: '', label: 'Leave unchanged' },
  { value: 'VIEWER', label: 'Viewer' },
  { value: 'EDITOR', label: 'Editor' },
  { value: 'ADMIN', label: 'Admin' },
];

const blankRow = (): RoleMapping => ({
  externalId: '',
  label: '',
  userRole: null,
  mcpRoleIds: [],
});

/**
 * Editor for one provider's group → role mappings.
 *
 * Saves the whole set at once, because that is the only shape the API offers:
 * a half-applied edit to the table that decides who can call which tools is a
 * state nobody can reason about.
 */
export function RoleMappingsPanel({
  provider,
  token,
}: {
  provider: IdentityProvider;
  token: string;
}) {
  const toast = useToast();
  const [rows, setRows] = useState<RoleMapping[]>([]);
  const [available, setAvailable] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [mappings, allRoles] = await Promise.all([
          identityProviders.roleMappings(provider.id, token),
          rolesApi.list(token),
        ]);
        if (cancelled) return;
        setRows(mappings.length > 0 ? mappings : [blankRow()]);
        setAvailable(allRoles.map((r: any) => ({ id: r.id, name: r.name })));
      } catch (err: any) {
        if (!cancelled) {
          toast.show({
            tone: 'error',
            title: 'Could not load mappings',
            description: err.message,
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.id, token]);

  const patch = (i: number, next: Partial<RoleMapping>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...next } : r)));

  const handleSave = async () => {
    // Blank rows are the natural end state of "add row then change your mind";
    // dropping them here is friendlier than a validation error on a row the
    // admin never filled in.
    //
    // Projected field by field rather than sent as-is: the API validates with
    // `forbidNonWhitelisted`, so echoing back the `id` that GET returned — the
    // obvious thing for a client to do — is a 400. Only the first save worked,
    // because those rows had never been round-tripped.
    const payload = rows
      .filter((r) => r.externalId.trim() !== '')
      .map((r) => ({
        externalId: r.externalId.trim(),
        label: r.label ?? '',
        userRole: r.userRole,
        mcpRoleIds: r.mcpRoleIds,
      }));
    setSaving(true);
    try {
      const saved = await identityProviders.saveRoleMappings(
        provider.id,
        payload,
        token,
      );
      setRows(saved.length > 0 ? saved : [blankRow()]);
      toast.show({ tone: 'success', title: 'Mappings saved' });
    } catch (err: any) {
      toast.show({ tone: 'error', title: 'Could not save', description: err.message });
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    'w-full h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] outline-none focus:border-[var(--brand)]';
  const labelClass = 'block text-[11.5px] font-medium text-[var(--text-3)] mb-1';

  if (loading) {
    return <p className="text-[13px] text-[var(--text-3)] py-4">Loading mappings...</p>;
  }

  const isGroups = provider.roleSyncSource === 'GROUPS';

  return (
    <div className="mt-3 pt-3 border-t border-[var(--border)] space-y-3">
      <div>
        <h4 className="text-[13px] font-semibold text-[var(--text)]">
          {isGroups ? 'Group mappings' : 'App role mappings'}
        </h4>
        <p className="text-[11.5px] text-[var(--text-3)] mt-1 max-w-2xl">
          {isGroups && provider.scimEnabled ? (
            <>
              Groups assigned to the application in Entra appear here automatically once
              provisioning has run. Assign MCP roles to each; a group with no roles grants
              nothing. You can still add a group by object ID if it has not been pushed yet.
            </>
          ) : isGroups ? (
            <>
              Enter the group&apos;s <strong>object ID</strong>, not its name — Microsoft does
              not make group names unique, so matching on one would let anyone able to create
              a group grant themselves a role. Find it in Entra under Groups → the group →
              Overview → Object Id. Only groups <em>assigned to the application</em> appear in
              the token.
            </>
          ) : (
            <>
              Enter the app role&apos;s <strong>value</strong> from the application manifest
              (for example <code>amcp.einkauf</code>), not its display name.
            </>
          )}
        </p>
      </div>

      {provider.scimEnabled && !isGroups && (
        <p className="text-[12px] text-[var(--warn,#b45309)] bg-[var(--surface-2)] rounded-[9px] px-3 py-2">
          Roles are read from application roles at sign-in. Group changes pushed over SCIM will
          not change anyone&apos;s roles between sign-ins — switch &ldquo;Read roles from&rdquo;
          to groups to get that.
        </p>
      )}

      {!provider.roleSyncEnabled && (
        <p className="text-[12px] text-[var(--warn,#b45309)] bg-[var(--surface-2)] rounded-[9px] px-3 py-2">
          Role sync is turned off for this provider, so these mappings are stored but never
          applied. Turn it on under Edit.
        </p>
      )}

      <div className="space-y-2">
        {rows.map((row, i) => (
          <div
            key={i}
            className="rounded-[9px] border border-[var(--border)] p-3 space-y-2"
          >
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              <div className="md:col-span-2">
                <label className={labelClass}>
                  {isGroups ? 'Group object ID' : 'App role value'}
                  {row.scimManaged && (
                    <Badge tone="neutral" className="ml-2">from SCIM</Badge>
                  )}
                  {row.scimManaged && row.scimMemberCount != null && (
                    <span className="ml-2 font-normal">{row.scimMemberCount} member{row.scimMemberCount === 1 ? '' : 's'}</span>
                  )}
                </label>
                <input
                  className={inputClass}
                  value={row.externalId}
                  readOnly={Boolean(row.scimManaged)}
                  onChange={(e) => patch(i, { externalId: e.target.value })}
                  placeholder={
                    isGroups ? '4be78614-f22d-472f-a2cb-5eb81b6e3f6f' : 'amcp.einkauf'
                  }
                  data-testid={`mapping-external-id-${i}`}
                />
              </div>
              <div>
                <label className={labelClass}>Name (for humans)</label>
                <input
                  className={inputClass}
                  value={row.label ?? ''}
                  onChange={(e) => patch(i, { label: e.target.value })}
                  placeholder="GB_Grosshandel_Innendienst"
                  data-testid={`mapping-label-${i}`}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              <div>
                <label className={labelClass}>Workspace role</label>
                <AppSelect
                  value={row.userRole ?? ''}
                  onValueChange={(v) =>
                    patch(i, { userRole: (v || null) as RoleMapping['userRole'] })
                  }
                  options={ORG_ROLE_OPTIONS}
                />
              </div>
              <div className="md:col-span-2">
                <label className={labelClass}>MCP roles</label>
                <MultiSelect
                  value={row.mcpRoleIds}
                  onValueChange={(ids) => patch(i, { mcpRoleIds: ids })}
                  options={available.map((r) => ({ value: r.id, label: r.name }))}
                  placeholder="No roles — grants nothing"
                  emptyMessage="No MCP roles exist yet — create one under Roles"
                />
              </div>
            </div>

            <div className="flex justify-end">
              {row.scimManaged ? (
                <span className="text-[11.5px] text-[var(--text-3)]">
                  Unassign the group from the application in Entra to remove it.
                </span>
              ) : (
                <button
                  type="button"
                  className="text-[11.5px] text-[var(--danger,#dc2626)] hover:underline"
                  onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                >
                  Remove
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" variant="secondary" onClick={() => setRows((rs) => [...rs, blankRow()])}>
          Add mapping
        </Button>
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save mappings'}
        </Button>
      </div>

      <p className="text-[11.5px] text-[var(--text-3)] max-w-2xl">
        A user in several mapped groups receives the <strong>union</strong> of their MCP roles
        and the <strong>most privileged</strong> workspace role. Roles an admin assigned by
        hand are never removed by a sync.
        {provider.roleSyncFallback === 'DENY_ALL' && (
          <> Someone who matches nothing is given a &ldquo;No access (SSO)&rdquo; role, which
          grants no tools.</>
        )}
      </p>
    </div>
  );
}
