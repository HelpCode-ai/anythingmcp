'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import {
  memory as memoryApi,
  type MemoryAccessLevel,
  type MemoryItem,
  type MemoryStatus,
  type KnowledgeFolder,
  knowledgeFolders,
} from '@/lib/api';
import { buildEnterpriseContactUrl } from '@/lib/marketing';
import { AppShell } from '@/components/app-shell';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  KnowledgeFolderTree,
  folderOptions,
  useKnowledgeFolders,
  type FolderSelection,
} from '@/components/knowledge-folders';

const PAGE_SIZE = 25;
const CONTENT_MAX = 2000;
/** Auth methods older items stored as their client. */
const AUTH_METHODS = new Set(['jwt', 'oauth', 'none', 'mcp_api_key', 'static_api_key', 'static_bearer']);

type Tab = 'personal' | 'organization' | 'pending';

const inputCls =
  'w-full h-[38px] px-3 rounded-[9px] text-[13px] bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] placeholder:text-[var(--text-3)] outline-none focus:border-[var(--border-strong)]';
const textareaCls =
  'w-full px-3 py-2.5 rounded-[9px] text-[13px] bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] placeholder:text-[var(--text-3)] outline-none focus:border-[var(--border-strong)] leading-relaxed';

export default function MemoryPage() {
  const t = useTranslations('memory');
  const { token, user } = useAuth();
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [tab, setTab] = useState<Tab>('personal');
  const [data, setData] = useState<{ key: string; items: MemoryItem[]; total: number; pending: number }>({
    key: '',
    items: [],
    total: 0,
    pending: 0,
  });
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [reload, setReload] = useState(0);
  const [msg, setMsg] = useState('');
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isAdmin = user?.role === 'ADMIN';

  useEffect(() => {
    if (!token) return;
    memoryApi
      .status(token)
      .then(setStatus)
      .catch((e) => setStatusError(e.message || t('loadFailed')));
  }, [token, t]);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setDebounced(query), 250);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query]);

  // What the list shows; it is loading until the data for this key arrives.
  const [folderSel, setFolderSel] = useState<FolderSelection>('');
  const { folders, restrictionsAvailable, reload: reloadFolders } = useKnowledgeFolders(token);
  const companyTab = tab !== 'personal';
  const listKey = `${tab}|${debounced}|${page}|${reload}|${companyTab ? folderSel : ''}`;
  const licensed = !!status?.licensed;
  useEffect(() => {
    if (!token || !licensed) return;
    let cancelled = false;
    memoryApi
      .list(token, {
        scope: tab === 'personal' ? 'personal' : 'organization',
        status: tab === 'pending' ? 'pending' : undefined,
        q: debounced || undefined,
        take: PAGE_SIZE,
        skip: page * PAGE_SIZE,
        folderId: companyTab && folderSel ? folderSel : undefined,
      })
      .then((r) => {
        if (!cancelled) setData({ key: listKey, items: r.items, total: r.total, pending: r.pending });
      })
      .catch((e) => {
        if (!cancelled) {
          setMsg(e.message || t('loadFailed'));
          setData((d) => ({ ...d, key: listKey }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token, licensed, tab, debounced, page, listKey, companyTab, folderSel, t]);
  const load = () => setReload((n) => n + 1);
  const { items, total, pending } = data;
  const loading = data.key !== listKey;

  if (statusError) {
    return (
      <AppShell title={t('title')} maxWidth={1120}>
        <p className="text-[13px] text-[var(--danger)]">{statusError}</p>
      </AppShell>
    );
  }
  if (!status) {
    return (
      <AppShell title={t('title')} maxWidth={1120}>
        <p className="text-[13px] text-[var(--text-3)]">{t('loading')}</p>
      </AppShell>
    );
  }

  const curator = status.isCurator;
  const canReadOrg = curator || status.access === 'read' || status.access === 'personal' || status.access === 'contribute';
  const canWritePersonal = status.access === 'personal' || status.access === 'contribute';
  const canWriteHere = tab === 'personal' ? canWritePersonal : tab === 'organization' && curator;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const tabs: Array<{ key: Tab; label: string; show: boolean; count?: number }> = [
    { key: 'personal', label: t('tabs.personal'), show: true },
    { key: 'organization', label: t('tabs.organization'), show: canReadOrg },
    { key: 'pending', label: t('tabs.pending'), show: curator, count: pending },
  ];
  const hl = (chunks: React.ReactNode) => <span className="text-[var(--text)]">{chunks}</span>;

  return (
    <AppShell title={t('title')} maxWidth={1120}>
      <p className="text-[13px] leading-relaxed text-[var(--text-2)] mb-4">
        {t.rich('intro', { hl })}
      </p>

      {!status.licensed ? (
        <EnterpriseMemoryNotice />
      ) : (
        <>
          <p className="text-[12.5px] text-[var(--text-3)] mb-3">
            {isAdmin
              ? t.rich('accessAdmin', {
                  level: t(`access.${status.access}`),
                  hl,
                  link: (chunks) => (
                    <Link href="/settings/users" className="text-[var(--brand)] hover:underline">
                      {chunks}
                    </Link>
                  ),
                })
              : t.rich('accessMember', { level: t(`access.${status.access}`), hl })}
          </p>
          {msg && <p className="text-[12px] text-[var(--text-3)] mb-3">{msg}</p>}

          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div className="inline-flex p-[3px] rounded-[10px] border border-[var(--border)] gap-0.5">
              {tabs
                .filter((x) => x.show)
                .map((x) => (
                  <button
                    key={x.key}
                    onClick={() => {
                      setTab(x.key);
                      setPage(0);
                    }}
                    className={cn(
                      'px-3 py-1.5 rounded-[7px] text-[12.5px] font-medium transition-colors',
                      tab === x.key
                        ? 'bg-[var(--brand)] text-[var(--primary-foreground)]'
                        : 'text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]',
                    )}
                  >
                    {x.label}
                    {x.count ? <span className="ml-1.5 text-[11px] opacity-80">{x.count}</span> : null}
                  </button>
                ))}
            </div>
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
              placeholder={t('searchPlaceholder')}
              className={cn(inputCls, 'w-full sm:w-56')}
            />
          </div>

          <div className={cn(companyTab && 'grid gap-4 md:grid-cols-[230px_minmax(0,1fr)]')}>
          {companyTab && (
            <aside className="md:sticky md:top-4 md:self-start">
              <KnowledgeFolderTree
                token={token!}
                kind="memory"
                folders={folders}
                restrictionsAvailable={restrictionsAvailable}
                selected={folderSel}
                onSelect={(f) => {
                  setFolderSel(f);
                  setPage(0);
                }}
                canEdit={curator}
                isAdmin={isAdmin}
                onChanged={() => {
                  reloadFolders();
                  load();
                }}
              />
            </aside>
          )}
          <div className="min-w-0">
          {canWriteHere && (
            <NewMemoryForm
              token={token!}
              scope={tab === 'organization' ? 'organization' : 'personal'}
              folders={tab === 'organization' ? folders : []}
              defaultFolderId={folderSel && folderSel !== 'none' ? folderSel : ''}
              onSaved={() => {
                setMsg(t('saved'));
                setPage(0);
                load();
                reloadFolders();
              }}
              onError={(m) => setMsg(m)}
            />
          )}

          {loading ? (
            <p className="text-[13px] text-[var(--text-3)]">{t('loading')}</p>
          ) : items.length === 0 ? (
            <Card className="p-6 text-center text-[13px] text-[var(--text-3)]">
              {tab === 'personal'
                ? t('empty.personal')
                : tab === 'pending'
                  ? t('empty.pending')
                  : t('empty.organization')}
            </Card>
          ) : (
            <div className="flex flex-col gap-2.5">
              {items.map((m) => (
                <MemoryCard
                  key={m.id}
                  item={m}
                  token={token!}
                  canEdit={m.scope === 'personal' || curator}
                  canReview={curator && m.status === 'pending'}
                  folders={m.scope === 'organization' ? folders : []}
                  canMove={curator && m.scope === 'organization'}
                  onChanged={() => {
                    load();
                    reloadFolders();
                  }}
                  onError={(e) => setMsg(e)}
                />
              ))}
            </div>
          )}

          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between mt-4 text-[13px]">
              <span className="text-[var(--text-3)]">
                {t('pager.range', {
                  from: page * PAGE_SIZE + 1,
                  to: Math.min(total, (page + 1) * PAGE_SIZE),
                  total,
                })}
              </span>
              <div className="flex items-center gap-2.5">
                <Button variant="secondary" size="md" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                  {t('pager.prev')}
                </Button>
                <span className="text-[var(--text-3)]">
                  {t('pager.page', { page: page + 1, total: totalPages })}
                </span>
                <Button
                  variant="secondary"
                  size="md"
                  disabled={page + 1 >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  {t('pager.next')}
                </Button>
              </div>
            </div>
          )}

          </div>
          </div>

          {isAdmin && (
            <MemorySettings
              token={token!}
              settings={status.settings}
              onSaved={(settings) => setStatus((s) => (s ? { ...s, settings } : s))}
            />
          )}
        </>
      )}
    </AppShell>
  );
}

function EnterpriseMemoryNotice() {
  return (
    <div className="rounded-[12px] border border-[var(--brand)] bg-[var(--brand-tint)] p-4">
      <h3 className="text-sm font-semibold text-[var(--text)]">Memory is part of AnythingMCP Enterprise</h3>
      <p className="text-[13px] text-[var(--text-2)] mt-1 max-w-2xl">
        With an Enterprise licence your AI clients remember facts, preferences and notes across
        conversations and clients, per person and for the whole company, with per-user access and
        review of what is shared.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <a
          href={buildEnterpriseContactUrl({ feature: 'memory' })}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(buttonVariants({ size: 'sm', variant: 'primary' }))}
        >
          Contact us about Enterprise
        </a>
        <Link href="/settings/license" className="text-[13px] text-[var(--brand)] hover:underline">
          Enter a license key
        </Link>
      </div>
    </div>
  );
}

function NewMemoryForm({
  token,
  scope,
  folders,
  defaultFolderId,
  onSaved,
  onError,
}: {
  token: string;
  scope: 'personal' | 'organization';
  folders: KnowledgeFolder[];
  defaultFolderId: string;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const t = useTranslations('memory');
  const [content, setContent] = useState('');
  const [folderId, setFolderId] = useState(defaultFolderId);
  const [kind, setKind] = useState('fact');
  const [tags, setTags] = useState('');
  const [about, setAbout] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!content.trim()) return;
    setSaving(true);
    try {
      await memoryApi.create(token, {
        content,
        kind,
        scope,
        ...(scope === 'organization' && folderId ? { folderId } : {}),
        ...(about.trim() ? { about } : {}),
        tags: tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
      });
      setContent('');
      setTags('');
      setAbout('');
      onSaved();
    } catch (e: any) {
      onError(e.message || t('form.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-4 mb-3.5 bg-[var(--surface-2)]">
      <div className="flex flex-col gap-2.5">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={2}
          maxLength={CONTENT_MAX}
          placeholder={
            scope === 'organization' ? t('form.placeholderOrganization') : t('form.placeholderPersonal')
          }
          className={textareaCls}
        />
        <div className="flex flex-wrap items-center gap-2.5">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className={cn(inputCls, 'w-auto')}
            aria-label={t('form.kind')}
          >
            <option value="fact">{t('kinds.fact')}</option>
            <option value="preference">{t('kinds.preference')}</option>
            <option value="note">{t('kinds.note')}</option>
          </select>
          {folders.length > 0 && (
            <select
              value={folderId}
              onChange={(e) => setFolderId(e.target.value)}
              className={cn(inputCls, 'w-auto max-w-[220px]')}
              aria-label={t('form.folder')}
            >
              {folderOptions(folders, t('form.noFolder')).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder={t('form.tagsPlaceholder')}
            className={cn(inputCls, 'flex-1 min-w-[180px]')}
          />
          <input
            value={about}
            onChange={(e) => setAbout(e.target.value)}
            placeholder={t('form.aboutPlaceholder')}
            title={t('form.aboutTitle')}
            className={cn(inputCls, 'w-[190px]')}
            maxLength={80}
          />
          <Button variant="primary" size="md" onClick={submit} disabled={saving || !content.trim()}>
            {saving ? t('form.saving') : scope === 'organization' ? t('form.addCompany') : t('form.remember')}
          </Button>
        </div>
        <p className="text-[11.5px] text-[var(--text-3)]">
          {t('form.noSecrets')}
        </p>
      </div>
    </Card>
  );
}

function MemoryCard({
  item,
  token,
  canEdit,
  canReview,
  folders,
  canMove,
  onChanged,
  onError,
}: {
  item: MemoryItem;
  token: string;
  canEdit: boolean;
  canReview: boolean;
  folders: KnowledgeFolder[];
  canMove: boolean;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const t = useTranslations('memory');
  const locale = useLocale();
  const [editing, setEditing] = useState(false);
  const [folderId, setFolderId] = useState(item.folderId ?? '');
  const folderPath = folders.find((f) => f.id === item.folderId)?.path;
  const [content, setContent] = useState(item.content);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (e: any) {
      onError(e.message || t('card.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  // Older items stored the auth method ("jwt", "oauth") as the client: not a name.
  const client = item.source?.client && !AUTH_METHODS.has(item.source.client) ? item.source.client : null;
  const via =
    item.source?.via === 'mcp'
      ? client
        ? t('card.viaAiClient', { client })
        : t('card.viaAi')
      : t('card.viaDashboard');

  return (
    <Card className={cn('px-[18px] py-3.5', item.status === 'rejected' && 'opacity-60')}>
      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={3}
            maxLength={CONTENT_MAX}
            className={textareaCls}
          />
          {canMove && folders.length > 0 && (
            <select
              value={folderId}
              onChange={(e) => setFolderId(e.target.value)}
              className={cn(inputCls, 'w-auto max-w-[260px]')}
              aria-label={t('form.folder')}
            >
              {folderOptions(folders, t('form.noFolder')).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await memoryApi.update(token, item.id, { content });
                  if (canMove && (folderId || null) !== (item.folderId ?? null)) {
                    await knowledgeFolders.move(token, 'memory', [item.id], folderId || null);
                  }
                  setEditing(false);
                })
              }
            >
              {t('save')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setEditing(false)}>
              {t('cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[13.5px] leading-[1.55] text-[var(--text)] whitespace-pre-wrap">{item.content}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-[var(--text-3)]">
              <Badge tone="neutral" className="rounded-full px-2 py-[1px]">
                {t.has(`kindBadges.${item.kind}`) ? t(`kindBadges.${item.kind}`) : item.kind}
              </Badge>
              {item.status === 'pending' && (
                <Badge tone="warn" className="rounded-full px-2 py-[1px]">
                  {t('card.pending')}
                </Badge>
              )}
              {item.status === 'rejected' && (
                <Badge tone="danger" className="rounded-full px-2 py-[1px]">
                  {t('card.rejected')}
                </Badge>
              )}
              {item.tags?.map((tag) => (
                <span key={tag} className="rounded-full border border-[var(--border)] px-2 py-[1px]">
                  {tag}
                </span>
              ))}
              <span>
                {folderPath ? `${folderPath} · ` : ''}
                {item.about ? `${t('card.about', { about: item.about })} · ` : ''}
                {via} · {new Date(item.updatedAt).toLocaleDateString(locale)}
              </span>
            </div>
          </div>
          <div className="flex gap-1.5 flex-shrink-0">
            {canReview && (
              <>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => run(() => memoryApi.approve(token, item.id))}
                  className="h-[30px] px-[11px] bg-[var(--ok)] text-[var(--ok-foreground)] hover:opacity-90"
                >
                  {t('card.approve')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => run(() => memoryApi.reject(token, item.id))}
                  className="h-[30px] px-[11px]"
                >
                  {t('card.reject')}
                </Button>
              </>
            )}
            {canEdit && (
              <>
                <Button variant="secondary" size="sm" onClick={() => setEditing(true)} className="h-[30px] px-[11px]">
                  {t('edit')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  aria-label={t('card.deleteAria')}
                  title={t('delete')}
                  onClick={() => run(() => memoryApi.remove(token, item.id))}
                  className="h-[30px] w-[30px] p-0 text-[var(--danger)]"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                  </svg>
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function MemorySettings({
  token,
  settings,
  onSaved,
}: {
  token: string;
  settings: MemoryStatus['settings'];
  onSaved: (s: MemoryStatus['settings']) => void;
}) {
  const t = useTranslations('memory');
  const [defaultAccess, setDefaultAccess] = useState(settings.defaultAccess);
  const [writeMode, setWriteMode] = useState(settings.writeMode);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const save = async () => {
    setSaving(true);
    setMsg('');
    try {
      const s = await memoryApi.updateSettings(token, { defaultAccess, writeMode });
      onSaved(s);
      setMsg(t('saved'));
    } catch (e: any) {
      setMsg(e.message || t('form.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-[22px] mt-6">
      <h3 className="text-sm font-semibold text-[var(--text)] mb-3">{t('settings.title')}</h3>
      <div className="flex max-w-[560px] flex-col gap-4">
        <div>
          <label htmlFor="memory-write-mode" className="mb-1.5 block text-[12.5px] font-medium text-[var(--text)]">
            {t('settings.writeMode')}
          </label>
          <select
            id="memory-write-mode"
            value={writeMode}
            onChange={(e) => setWriteMode(e.target.value as 'approval' | 'auto')}
            className={inputCls}
          >
            <option value="approval">{t('settings.approval')}</option>
            <option value="auto">{t('settings.auto')}</option>
          </select>
          <p className="mt-1.5 text-[11.5px] text-[var(--text-3)]">
            {t('settings.writeModeHint')}
          </p>
        </div>
        <div>
          <label htmlFor="memory-default-access" className="mb-1.5 block text-[12.5px] font-medium text-[var(--text)]">
            {t('settings.defaultAccess')}
          </label>
          <select
            id="memory-default-access"
            value={defaultAccess}
            onChange={(e) => setDefaultAccess(e.target.value as MemoryAccessLevel)}
            className={inputCls}
          >
            <option value="none">{t('access.none')}</option>
            <option value="read">{t('access.read')}</option>
            <option value="personal">{t('access.personal')}</option>
            <option value="contribute">{t('access.contribute')}</option>
          </select>
          <p className="mt-1.5 text-[11.5px] text-[var(--text-3)]">
            {t('settings.defaultAccessHint')}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="primary" size="md" onClick={save} disabled={saving}>
            {saving ? t('settings.saving') : t('settings.save')}
          </Button>
          {msg && <span className="text-[12.5px] text-[var(--text-3)]">{msg}</span>}
        </div>
      </div>
    </Card>
  );
}
