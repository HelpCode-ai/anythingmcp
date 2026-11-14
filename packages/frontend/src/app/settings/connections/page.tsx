'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import { mcpConnections } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

type Connection = Awaited<ReturnType<typeof mcpConnections.list>>[number];
type Target = Awaited<ReturnType<typeof mcpConnections.targets>>[number];

/**
 * What each connected AI client can reach, and how to change it.
 *
 * This page exists because the client cannot be relied on to ask again. Claude
 * holds an access token for a day and a refresh token for thirty, and reuses
 * cached credentials — so disconnecting and reconnecting usually replays the
 * stored token and lands on the previous choice without prompting. Changing it
 * here takes effect on that connection's very next request instead.
 */
export default function ConnectionsPage() {
  const { token } = useAuth();
  const t = useTranslations('settingsConnections');
  const [connections, setConnections] = useState<Connection[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftServers, setDraftServers] = useState<string[]>([]);
  const [draftWorkspace, setDraftWorkspace] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [list, tg] = await Promise.all([
        mcpConnections.list(token),
        mcpConnections.targets(token),
      ]);
      setConnections(list);
      setTargets(tg);
    } catch (err: any) {
      setMsg(err.message || t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [token, t]);

  useEffect(() => {
    load();
  }, [load]);

  const startEditing = (c: Connection) => {
    setEditing(c.clientId);
    setDraftServers(c.servers.map((s) => s.id));
    setDraftWorkspace(c.wholeWorkspace?.id ?? null);
    setMsg('');
  };

  const save = async (clientId: string) => {
    if (!token) return;
    const body = draftWorkspace
      ? { organizationId: draftWorkspace }
      : { serverIds: draftServers };
    const res = await mcpConnections.update(clientId, body, token);
    if (!res.ok) {
      setMsg(
        res.reason === 'empty-selection'
          ? t('emptySelection')
          : t('notAvailable'),
      );
      return;
    }
    setEditing(null);
    setMsg(t('updated'));
    load();
  };

  const revoke = async (c: Connection) => {
    if (!token) return;
    await mcpConnections.revoke(c.clientId, token);
    setMsg(t('revokedMsg', { client: c.clientName }));
    load();
  };

  if (loading) {
    return <p className="text-[13px] text-[var(--text-3)]">{t('loading')}</p>;
  }

  return (
    <div>
      <h2 className="mb-[3px] text-[15px] font-semibold text-[var(--text)]">
        {t('title')}
      </h2>
      <p className="mb-4 text-[13px] text-[var(--text-3)]">
        {t('intro')}
      </p>

      {msg && (
        <div className="mb-4 rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] p-3 text-[13px] text-[var(--text-2)]">
          {msg}
        </div>
      )}

      {connections.length === 0 ? (
        <Card className="p-[22px]">
          <p className="text-[13px] text-[var(--text-3)]">
            {t('empty')}
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {connections.map((c) => (
            <Card key={c.clientId} className="p-[18px]">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] font-semibold text-[var(--text)]">
                      {c.clientName}
                    </span>
                    {c.revoked && <Badge tone="danger">{t('revoked')}</Badge>}
                  </div>
                  <p className="mt-[3px] text-[12px] text-[var(--text-3)]">
                    {c.revoked
                      ? t('reachesNothing')
                      : c.wholeWorkspace
                        ? t('everythingIn', { workspace: c.wholeWorkspace.name })
                        : c.servers.length > 0
                          ? c.servers.map((s) => s.name).join(', ')
                          : t('nothingSelected')}
                  </p>
                </div>
                {editing !== c.clientId && (
                  <div className="flex shrink-0 gap-2">
                    <Button variant="secondary" onClick={() => startEditing(c)}>
                      {t('change')}
                    </Button>
                    {!c.revoked && (
                      <Button variant="danger" onClick={() => revoke(c)}>
                        {t('revoke')}
                      </Button>
                    )}
                  </div>
                )}
              </div>

              {editing === c.clientId && (
                <div className="mt-4 border-t border-[var(--border)] pt-4">
                  {targets.map((target) => (
                    <fieldset key={target.organizationId} className="mb-3">
                      <legend className="mb-1 text-[11px] uppercase tracking-wide text-[var(--text-3)]">
                        {target.organizationName}
                      </legend>
                      {target.servers.map((srv) => (
                        <label
                          key={srv.id}
                          className="flex cursor-pointer items-center gap-[10px] rounded-[7px] px-1 py-[6px] hover:bg-[var(--surface-2)]"
                        >
                          <input
                            type="checkbox"
                            checked={
                              !draftWorkspace && draftServers.includes(srv.id)
                            }
                            disabled={!!draftWorkspace}
                            onChange={(e) =>
                              setDraftServers((prev) =>
                                e.target.checked
                                  ? [...prev, srv.id]
                                  : prev.filter((id) => id !== srv.id),
                              )
                            }
                          />
                          <span className="flex-1 text-[13px] text-[var(--text)]">
                            {srv.name}
                          </span>
                          <span className="text-[12px] text-[var(--text-3)]">
                            {t('connectorCount', { count: srv.connectorCount })}
                          </span>
                        </label>
                      ))}
                      <label className="mt-[6px] flex cursor-pointer items-center gap-[10px] rounded-[7px] border-t border-[var(--border)] px-1 pt-[10px] hover:bg-[var(--surface-2)]">
                        <input
                          type="checkbox"
                          checked={draftWorkspace === target.organizationId}
                          onChange={(e) =>
                            setDraftWorkspace(
                              e.target.checked ? target.organizationId : null,
                            )
                          }
                        />
                        <span className="flex-1 text-[13px] text-[var(--text)]">
                          {t('wholeWorkspace')}
                        </span>
                        <span className="text-[12px] text-[var(--text-3)]">
                          {t('wholeWorkspaceHint')}
                        </span>
                      </label>
                    </fieldset>
                  ))}
                  <div className="mt-2 flex gap-2">
                    <Button onClick={() => save(c.clientId)}>{t('save')}</Button>
                    <Button
                      variant="secondary"
                      onClick={() => setEditing(null)}
                    >
                      {t('cancel')}
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
