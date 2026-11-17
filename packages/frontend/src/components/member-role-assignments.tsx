'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { roles, type MemberRoles, type MemberRoleAssignment } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MultiSelect } from '@/components/ui/multi-select';

interface RoleOption {
  id: string;
  name: string;
}

/** Only these can be changed here: manual grants of this workspace. */
const isEditable = (a: MemberRoleAssignment) => a.source === 'manual' && !a.global;

const manualRoleIds = (m: MemberRoles) => [...new Set(m.roles.filter(isEditable).map((a) => a.roleId))];

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Chips for every MCP role of a member. Roles from a single sign-on group and
 * roles that apply in every workspace say so: they cannot be changed where an
 * admin edits manual roles.
 */
export function RoleChips({ roles: list }: { roles: MemberRoleAssignment[] }) {
  const t = useTranslations('settingsRoles');
  return (
    <div className="flex flex-wrap gap-1.5">
      {list.map((a) => (
        <span
          // One row per (role, source): a role held by hand AND through a group shows twice.
          key={`${a.roleId}-${a.source}-${a.global ? 'g' : 'o'}`}
          className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--text)]"
          style={{ background: isEditable(a) ? 'var(--brand-tint)' : 'var(--surface-2)' }}
          data-testid="mcp-role-chip"
        >
          {a.roleName}
          {a.source !== 'manual' && (
            <span className="text-[10.5px] text-[var(--text-3)]">· {t('assign.fromSso')}</span>
          )}
          {a.global && (
            <span className="text-[10.5px] text-[var(--text-3)]" title={t('assign.allWorkspacesHint')}>
              · {t('assign.allWorkspaces')}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

/**
 * The "User MCP Role Assignment" table of the roles pages.
 *
 * Shows EVERY MCP role a member holds in the workspace, because the member
 * may call the union of the tools of all of them. Showing one role (the
 * deprecated single `mcpRoleId`) hid roles granted by a single sign-on group
 * sync, so a member looked limited to one role while reaching far more.
 * Manual roles are edited with a multi-select; synced and all-workspace roles
 * are shown read-only, with where to change them.
 */
export function MemberRoleAssignments({
  token,
  roleList,
  reloadKey,
  onMessage,
}: {
  token: string | null;
  roleList: RoleOption[];
  /** Change it to reload, e.g. after a role was created, renamed or deleted. */
  reloadKey?: unknown;
  onMessage: (msg: string) => void;
}) {
  const t = useTranslations('settingsRoles');
  const [members, setMembers] = useState<MemberRoles[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const data = await roles.members(token);
      setMembers(Array.isArray(data) ? data : []);
      setDrafts({});
    } catch (err: any) {
      onMessage(t('error', { message: err.message }));
    }
    // onMessage is a setter from the parent; t is stable per locale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  const save = async (m: MemberRoles) => {
    if (!token) return;
    const roleIds = drafts[m.id] ?? manualRoleIds(m);
    setSavingId(m.id);
    try {
      await roles.setUserRoles(m.id, roleIds, token);
      onMessage(t('assigned'));
      await load();
    } catch (err: any) {
      onMessage(t('error', { message: err.message }));
    } finally {
      setSavingId(null);
    }
  };

  const reach = (m: MemberRoles) => {
    if (m.connectors === null) {
      return <span className="text-xs text-[var(--text-3)]">{t('assign.allConnectors')}</span>;
    }
    if (m.connectors.length === 0) {
      return <span className="text-xs text-[var(--text-3)]">{t('assign.noConnectors')}</span>;
    }
    const names = m.connectors.map((c) => c.name).join(', ');
    return (
      <span className="text-xs text-[var(--text)]" title={names} data-testid={`reach-${m.email}`}>
        {t('assign.connectorCount', { count: m.connectors.length })}
        <span className="block text-[11px] text-[var(--text-3)] truncate max-w-[200px]">{names}</span>
      </span>
    );
  };

  return (
    <div className="border border-[var(--border)] rounded-[9px] overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="bg-[var(--surface-2)]">
          <tr className="text-[var(--text-2)]">
            <th className="text-left px-4 py-3 font-semibold">{t('assign.user')}</th>
            <th className="text-left px-4 py-3 font-semibold">{t('assign.appRole')}</th>
            <th className="text-left px-4 py-3 font-semibold">{t('assign.mcpRole')}</th>
            <th className="text-left px-4 py-3 font-semibold">{t('assign.reach')}</th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => {
            const saved = manualRoleIds(m);
            const draft = drafts[m.id] ?? saved;
            const dirty = !sameSet(draft, saved);
            const fromSso = m.roles.some((a) => a.source !== 'manual');
            return (
              <tr key={m.id} className="border-t border-[var(--border)] align-top" data-testid={`member-${m.email}`}>
                <td className="px-4 py-3">
                  <span className="font-mono text-xs text-[var(--text)]">{m.email}</span>
                  {m.name && <span className="text-xs text-[var(--text-3)] ml-2">{m.name}</span>}
                  {!m.active && (
                    <div className="mt-1">
                      <Badge tone="warn">{t('assign.deactivated')}</Badge>
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <Badge tone="neutral">{m.role}</Badge>
                </td>
                <td className="px-4 py-3 space-y-2">
                  {m.role === 'ADMIN' ? (
                    <span className="text-xs text-[var(--text-3)]">{t('assign.fullAccess')}</span>
                  ) : (
                    <>
                      {m.roles.length > 0 ? (
                        <RoleChips roles={m.roles} />
                      ) : (
                        <p className="text-xs text-[var(--text-3)]">
                          {m.connectors === null ? t('assign.noRoleOpen') : t('assign.noRoleClosed')}
                        </p>
                      )}
                      <div className="flex items-center gap-2 max-w-sm">
                        <MultiSelect
                          value={draft}
                          onValueChange={(v) => setDrafts((prev) => ({ ...prev, [m.id]: v }))}
                          options={roleList.map((r) => ({ value: r.id, label: r.name }))}
                          placeholder={t('assign.manualPlaceholder')}
                          emptyMessage={t('empty')}
                          className="h-8 text-xs"
                        />
                        {dirty && (
                          <Button size="sm" onClick={() => save(m)} disabled={savingId === m.id}>
                            {savingId === m.id ? t('access.saving') : t('save')}
                          </Button>
                        )}
                      </div>
                      {fromSso && (
                        <p className="text-[11px] text-[var(--text-3)]">
                          {t('assign.ssoHint')}{' '}
                          <Link href="/settings/identity-providers" className="text-[var(--brand)] hover:underline">
                            {t('assign.ssoLink')}
                          </Link>
                          .
                        </p>
                      )}
                    </>
                  )}
                </td>
                <td className="px-4 py-3">{reach(m)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
