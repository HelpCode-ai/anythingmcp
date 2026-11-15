'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import {
  learning as learningApi,
  mcpServers as mcpServersApi,
  users as usersApi,
  type LearningAllowance,
  type LearningProject,
  type McpServer,
} from '@/lib/api';
import { buildEnterpriseContactUrl } from '@/lib/marketing';
import { useManagePlan } from '@/lib/use-manage-plan';
import { LEARNING_STATUS_TONE } from '@/lib/learning-ui';
import { AppShell } from '@/components/app-shell';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AppSelect } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { folderOptions, useKnowledgeFolders } from '@/components/knowledge-folders';

const inputCls =
  'w-full h-[38px] px-3 rounded-[9px] text-[13px] bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] placeholder:text-[var(--text-3)] outline-none focus:border-[var(--border-strong)]';
const labelCls = 'block text-[12.5px] font-medium text-[var(--text)] mb-1.5';

export default function LearningProjectsPage() {
  const t = useTranslations('learning');
  const locale = useLocale();
  const { token, user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [data, setData] = useState<{ allowance: LearningAllowance; projects: LearningProject[] } | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    if (!token) return;
    learningApi
      .list(token)
      .then(setData)
      .catch((e) => setError(e.message || t('loadFailed')));
  }, [token, t]);
  useEffect(load, [load]);

  if (error) {
    return (
      <AppShell title={t('title')} maxWidth={960}>
        <p className="text-[13px] text-[var(--danger)]">{error}</p>
      </AppShell>
    );
  }
  if (!data) {
    return (
      <AppShell title={t('title')} maxWidth={960}>
        <p className="text-[13px] text-[var(--text-3)]">{t('loading')}</p>
      </AppShell>
    );
  }

  const { allowance, projects } = data;
  const included = allowance.max !== 0;
  const room = allowance.max === null || allowance.used < allowance.max;

  return (
    <AppShell title={t('title')} maxWidth={960}>
      <p className="text-[13px] leading-relaxed text-[var(--text-2)] mb-4 max-w-3xl">{t('intro')}</p>

      {!included && <LearningUpsell />}

      {included && (
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <p className="text-[12.5px] text-[var(--text-3)]" data-testid="learning-allowance">
            {allowance.max === null
              ? t('allowance.unlimited')
              : t('allowance.some', { used: allowance.used, max: allowance.max })}
          </p>
          {isAdmin && !creating && (
            <Button size="sm" disabled={!room} onClick={() => setCreating(true)} title={room ? undefined : t('new.limitReached')}>
              {t('new.button')}
            </Button>
          )}
        </div>
      )}
      {included && isAdmin && !room && !creating && (
        <p className="text-[12px] text-[var(--text-3)] mb-3">{t('new.limitReached')}</p>
      )}
      {msg && <p className="text-[12.5px] text-[var(--text-2)] mb-3">{msg}</p>}

      {creating && token && (
        <NewProjectForm
          token={token}
          onCancel={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            setMsg(t('new.created'));
            load();
          }}
        />
      )}

      {projects.length === 0 ? (
        included && <Card className="p-6 text-center text-[13px] text-[var(--text-3)]">{t('empty')}</Card>
      ) : (
        <div className="flex flex-col gap-2.5">
          {projects.map((p) => {
            const state = p.overPlan ? 'overPlan' : p.status;
            return (
              <Card key={p.id} className="px-[18px] py-4" data-testid="learning-project">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-0.5">
                      <Link
                        href={`/knowledge-graph/learning/${p.id}`}
                        className="text-[14px] font-semibold text-[var(--text)] hover:underline"
                      >
                        {p.name}
                      </Link>
                      <Badge tone={LEARNING_STATUS_TONE[state]} className="rounded-full px-2 py-[2px]">
                        {t(`status.${state}`)}
                      </Badge>
                    </div>
                    <p className="text-[11.5px] text-[var(--text-3)]">
                      {p.expert ? t('card.expert', { name: p.expert.name || p.expert.email || p.expert.id }) : t('card.expertHidden')}
                      {' · '}
                      {p.mcpServer ? t('card.server', { name: p.mcpServer.name }) : t('card.noServer')}
                      {p.folder ? ` · ${p.folder.name}` : ''}
                      {p.endsAt && p.status !== 'ended'
                        ? ` · ${t('card.ends', { date: new Date(p.endsAt).toLocaleDateString(locale) })}`
                        : ''}
                    </p>
                    <p className="text-[12.5px] text-[var(--text-2)] mt-1.5">
                      {t('card.topics', { count: p.topics })} ·{' '}
                      {t('card.lessons', { confirmed: p.lessons.confirmed, draft: p.lessons.draft })}
                    </p>
                  </div>
                  <Link
                    href={`/knowledge-graph/learning/${p.id}`}
                    className={cn(buttonVariants({ size: 'sm', variant: 'secondary' }))}
                  >
                    {t('card.open')}
                  </Link>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </AppShell>
  );
}

/** Shown where the plan has no learning projects: what they are and how to get them. */
function LearningUpsell() {
  const t = useTranslations('learning.upsell');
  const { deploymentMode } = useAuth();
  const cloud = deploymentMode === 'cloud';
  const plan = useManagePlan({ utm_source: 'learning-projects', utm_medium: 'page' });
  return (
    <div className="rounded-[12px] border border-[var(--brand)] bg-[var(--brand-tint)] p-4 mb-4" data-testid="learning-upsell">
      <h3 className="text-sm font-semibold text-[var(--text)]">{cloud ? t('cloudTitle') : t('selfTitle')}</h3>
      <p className="text-[13px] text-[var(--text-2)] mt-1 max-w-2xl">{cloud ? t('cloudBody') : t('selfBody')}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {cloud ? (
          <a href={plan.href} onClick={plan.onClick} className={cn(buttonVariants({ size: 'sm', variant: 'primary' }))}>
            {t('cloudCta')}
          </a>
        ) : (
          <>
            <a
              href={buildEnterpriseContactUrl({ feature: 'learning-projects' })}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(buttonVariants({ size: 'sm', variant: 'primary' }))}
            >
              {t('contact')}
            </a>
            <Link href="/settings/license" className="text-[13px] text-[var(--brand)] hover:underline">
              {t('key')}
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

function NewProjectForm({
  token,
  onCancel,
  onCreated,
}: {
  token: string;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const t = useTranslations('learning.new');
  const { folders } = useKnowledgeFolders(token);
  const [members, setMembers] = useState<Array<{ id: string; name?: string | null; email: string }>>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [name, setName] = useState('');
  const [userId, setUserId] = useState('');
  const [mcpServerId, setMcpServerId] = useState('');
  const [folderId, setFolderId] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [tags, setTags] = useState('');
  const [publishMode, setPublishMode] = useState<'manual' | 'confirmed'>('manual');
  const [showExpertName, setShowExpertName] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    usersApi.list(token).then(setMembers).catch(() => setMembers([]));
    mcpServersApi.list(token).then(setServers).catch(() => setServers([]));
  }, [token]);

  const submit = async () => {
    setSaving(true);
    setError('');
    try {
      await learningApi.create(token, {
        name: name.trim(),
        userId,
        mcpServerId,
        folderId: folderId || null,
        // The end of the chosen day, in the admin's time zone.
        endsAt: endsAt ? new Date(`${endsAt}T23:59:59`).toISOString() : null,
        tags: tags
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
        publishMode,
        showExpertName,
      });
      onCreated();
    } catch (e: any) {
      setError(e.message || '');
      setSaving(false);
    }
  };

  const ready = name.trim() && userId && mcpServerId && !saving;
  return (
    <Card className="p-[18px] mb-4" data-testid="learning-new-form">
      <h3 className="text-sm font-semibold text-[var(--text)] mb-3">{t('title')}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className={labelCls} htmlFor="lp-name">
            {t('name')}
          </label>
          <input
            id="lp-name"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('namePlaceholder')}
            className={inputCls}
          />
        </div>
        <div>
          <span className={labelCls} id="lp-member">
            {t('member')}
          </span>
          <AppSelect
            aria-labelledby="lp-member"
            value={userId}
            onValueChange={setUserId}
            className={inputCls}
            options={[
              { value: '', label: t('memberPlaceholder') },
              ...members.map((m) => ({ value: m.id, label: m.name ? `${m.name} (${m.email})` : m.email })),
            ]}
          />
        </div>
        <div>
          <span className={labelCls} id="lp-server">
            {t('server')}
          </span>
          <AppSelect
            aria-labelledby="lp-server"
            value={mcpServerId}
            onValueChange={setMcpServerId}
            className={inputCls}
            options={[{ value: '', label: t('serverPlaceholder') }, ...servers.map((s) => ({ value: s.id, label: s.name }))]}
          />
        </div>
        <div>
          <span className={labelCls} id="lp-folder">
            {t('folder')}
          </span>
          <AppSelect
            aria-labelledby="lp-folder"
            value={folderId}
            onValueChange={setFolderId}
            className={inputCls}
            options={folderOptions(folders, t('noFolder'))}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="lp-ends">
            {t('endsAt')}
          </label>
          <input id="lp-ends" type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls} htmlFor="lp-tags">
            {t('tags')}
          </label>
          <input id="lp-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t('tagsHint')} className={inputCls} />
        </div>
        <div>
          <span className={labelCls} id="lp-publish">
            {t('publishMode')}
          </span>
          <AppSelect
            aria-labelledby="lp-publish"
            value={publishMode}
            onValueChange={(v) => setPublishMode(v === 'confirmed' ? 'confirmed' : 'manual')}
            className={inputCls}
            options={[
              { value: 'manual', label: t('publishManual') },
              { value: 'confirmed', label: t('publishConfirmed') },
            ]}
          />
        </div>
        <label className="sm:col-span-2 flex items-start gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={showExpertName}
            onChange={(e) => setShowExpertName(e.target.checked)}
            className="mt-0.5 accent-[var(--brand)]"
          />
          <span className="text-[13px] text-[var(--text-2)]">{t('showName')}</span>
        </label>
      </div>
      {error && <p className="text-[13px] text-[var(--danger)] mt-3">{error}</p>}
      <div className="mt-4 flex items-center gap-2">
        <Button size="sm" disabled={!ready} onClick={submit}>
          {saving ? t('creating') : t('create')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          {t('cancel')}
        </Button>
      </div>
    </Card>
  );
}
