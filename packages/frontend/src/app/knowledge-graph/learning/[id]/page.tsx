'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import {
  learning as learningApi,
  type LearningLesson,
  type LearningLessonStatus,
  type LearningProjectDetail,
  type LearningTopic,
} from '@/lib/api';
import { LEARNING_STATUS_TONE, LESSON_KIND_TONE, LESSON_STATUS_TONE } from '@/lib/learning-ui';
import { AppShell } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AppSelect } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { folderOptions, useKnowledgeFolders } from '@/components/knowledge-folders';

type Tab = 'topics' | 'lessons' | 'settings';
const LESSONS_PAGE = 50;

const inputCls =
  'w-full h-[38px] px-3 rounded-[9px] text-[13px] bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] placeholder:text-[var(--text-3)] outline-none focus:border-[var(--border-strong)]';
const textareaCls =
  'w-full px-3 py-2.5 rounded-[9px] text-[13px] bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] outline-none focus:border-[var(--border-strong)] leading-relaxed';
const labelCls = 'block text-[12.5px] font-medium text-[var(--text)] mb-1.5';

export default function LearningProjectPage() {
  const t = useTranslations('learning');
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { token, user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [project, setProject] = useState<LearningProjectDetail | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [tab, setTab] = useState<Tab>('topics');
  const [busy, setBusy] = useState(false);
  // Bumped after a change, so the lessons list reads again.
  const [version, setVersion] = useState(0);

  const load = useCallback(() => {
    if (!token || !id) return;
    learningApi
      .get(token, id)
      .then((p) => {
        setProject(p);
        setVersion((n) => n + 1);
      })
      .catch((e) => setError(e.message || t('detail.notFound')));
  }, [token, id, t]);
  useEffect(load, [load]);

  if (error || !project) {
    return (
      <AppShell title={t('title')} maxWidth={960}>
        <BackLink />
        <p className={cn('text-[13px]', error ? 'text-[var(--danger)]' : 'text-[var(--text-3)]')}>
          {error || t('loading')}
        </p>
      </AppShell>
    );
  }

  const state = project.overPlan ? 'overPlan' : project.status;
  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    if (!token) return;
    setBusy(true);
    setMsg('');
    try {
      await fn();
      if (after) after();
      else load();
    } catch (e: any) {
      setMsg(e.message || '');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell title={project.name} maxWidth={960}>
      <BackLink />
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <Badge tone={LEARNING_STATUS_TONE[state]} className="rounded-full px-2 py-[2px]" data-testid="learning-status">
            {t(`status.${state}`)}
          </Badge>
          <p className="text-[12px] text-[var(--text-3)] mt-1.5">
            {project.expert
              ? t('card.expert', { name: project.expert.name || project.expert.email || project.expert.id })
              : t('card.expertHidden')}
            {' · '}
            {project.mcpServer ? t('card.server', { name: project.mcpServer.name }) : t('card.noServer')}
            {project.folder ? ` · ${project.folder.name}` : ''}
          </p>
        </div>
        {isAdmin && token && (
          <div className="flex flex-wrap items-center gap-2">
            {project.status === 'active' && (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(() => learningApi.setStatus(token, project.id, 'pause'))}>
                {t('detail.pause')}
              </Button>
            )}
            {project.status === 'paused' && (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(() => learningApi.setStatus(token, project.id, 'resume'))}>
                {t('detail.resume')}
              </Button>
            )}
            {project.status !== 'ended' && (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(t('detail.confirmEnd'))) void act(() => learningApi.setStatus(token, project.id, 'end'));
                }}
              >
                {t('detail.end')}
              </Button>
            )}
            <Button
              size="sm"
              variant="outlineDanger"
              disabled={busy}
              onClick={() => {
                if (window.confirm(t('detail.confirmDelete'))) {
                  void act(
                    () => learningApi.remove(token, project.id),
                    () => router.push('/knowledge-graph/learning'),
                  );
                }
              }}
            >
              {t('detail.delete')}
            </Button>
          </div>
        )}
      </div>

      {project.status === 'draft' && (
        <p className="text-[13px] text-[var(--text-2)] mb-3" data-testid="learning-waiting">
          {project.expert
            ? t('detail.waiting', { name: project.expert.name || project.expert.email || project.expert.id })
            : t('detail.waitingHidden')}
        </p>
      )}
      {project.overPlan && <p className="text-[13px] text-[var(--danger)] mb-3">{t('detail.overPlan')}</p>}
      {msg && <p className="text-[12.5px] text-[var(--text-2)] mb-3">{msg}</p>}

      <div className="inline-flex p-[3px] rounded-[10px] border border-[var(--border)] gap-0.5 mb-4">
        {(['topics', 'lessons', ...(isAdmin ? (['settings'] as const) : [])] as Tab[]).map((key) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              'px-3 py-1.5 rounded-[7px] text-[12.5px] font-medium transition-colors',
              tab === key
                ? 'bg-[var(--brand)] text-[var(--primary-foreground)]'
                : 'text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]',
            )}
          >
            {t(`detail.tabs.${key}`)}
            {key === 'lessons' && project.lessons.draft ? (
              <span className="ml-1.5 text-[11px] opacity-80">{project.lessons.draft}</span>
            ) : null}
          </button>
        ))}
      </div>

      {tab === 'topics' && token && <Topics token={token} topics={project.topics} onChanged={load} />}
      {tab === 'lessons' && token && <Lessons token={token} projectId={project.id} version={version} onChanged={load} />}
      {tab === 'settings' && token && isAdmin && (
        <ProjectSettings token={token} project={project} onSaved={load} />
      )}
    </AppShell>
  );
}

function BackLink() {
  const t = useTranslations('learning.detail');
  return (
    <Link href="/knowledge-graph/learning" className="inline-block text-[12.5px] text-[var(--brand)] hover:underline mb-3">
      ← {t('back')}
    </Link>
  );
}

function Topics({ token, topics, onChanged }: { token: string; topics: LearningTopic[]; onChanged: () => void }) {
  const t = useTranslations('learning.topics');
  const locale = useLocale();
  const [preview, setPreview] = useState<{ id: string; body: string | null; dropped: number } | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  if (!topics.length) {
    return <Card className="p-6 text-center text-[13px] text-[var(--text-3)]">{t('empty')}</Card>;
  }

  const showPreview = async (topicId: string) => {
    if (preview?.id === topicId) return setPreview(null);
    try {
      const p = await learningApi.preview(token, topicId);
      setPreview({ id: topicId, body: p.body, dropped: p.dropped });
    } catch (e: any) {
      setMsg(e.message || '');
    }
  };
  const publish = async (topicId: string) => {
    setBusy(topicId);
    setMsg('');
    try {
      const res = await learningApi.publish(token, topicId);
      setMsg(
        t('publishedMsg', { count: res.lessons }) + (res.dropped ? ` ${t('dropped', { count: res.dropped })}` : ''),
      );
      setPreview(null);
      onChanged();
    } catch (e: any) {
      setMsg(e.message || '');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="flex flex-col gap-2.5">
      {msg && <p className="text-[12.5px] text-[var(--text-2)]">{msg}</p>}
      {topics.map((topic) => (
        <Card key={topic.id} className="px-[18px] py-4" data-testid="learning-topic">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-0.5">
                <span className="text-[14px] font-semibold text-[var(--text)]">{topic.title}</span>
                {topic.unpublished && (
                  <Badge tone="warn" className="rounded-full px-2 py-[2px]">
                    {t('changes')}
                  </Badge>
                )}
              </div>
              <p className="text-[11.5px] text-[var(--text-3)]">
                {topic.publishedAt
                  ? t('published', { date: new Date(topic.publishedAt).toLocaleDateString(locale) })
                  : t('notPublished')}
                {' · '}
                {t('counts', { confirmed: topic.lessons.confirmed, draft: topic.lessons.draft })}
              </p>
              {topic.whenToUse && (
                <p className="text-[12.5px] text-[var(--text-2)] mt-1.5">
                  <span className="font-medium text-[var(--text)]">{t('when')}</span> {topic.whenToUse}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => showPreview(topic.id)}>
                {preview?.id === topic.id ? t('hidePreview') : t('preview')}
              </Button>
              <Button
                size="sm"
                disabled={busy === topic.id || topic.lessons.confirmed === 0}
                title={topic.lessons.confirmed === 0 ? t('nothing') : undefined}
                onClick={() => publish(topic.id)}
              >
                {busy === topic.id ? t('publishing') : t('publish')}
              </Button>
            </div>
          </div>
          {preview?.id === topic.id && (
            <div className="mt-3">
              {preview.body ? (
                <pre className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-[var(--text-2)] bg-[var(--surface-2)] rounded-[9px] p-3 font-[inherit]">
                  {preview.body}
                </pre>
              ) : (
                <p className="text-[12.5px] text-[var(--text-3)]">{t('nothing')}</p>
              )}
              {preview.dropped > 0 && (
                <p className="text-[12px] text-[var(--text-3)] mt-1.5">{t('dropped', { count: preview.dropped })}</p>
              )}
            </div>
          )}
          {topic.publishedSkillId && (
            <Link href="/knowledge-graph/skills" className="inline-block text-[12px] text-[var(--brand)] hover:underline mt-2">
              {t('viewSkill')}
            </Link>
          )}
        </Card>
      ))}
    </div>
  );
}

function Lessons({
  token,
  projectId,
  version,
  onChanged,
}: {
  token: string;
  projectId: string;
  version: number;
  onChanged: () => void;
}) {
  const t = useTranslations('learning.lessons');
  const [filter, setFilter] = useState<'all' | LearningLessonStatus>('draft');
  const [data, setData] = useState<{ key: string; items: LearningLesson[]; total: number }>({ key: '', items: [], total: 0 });
  const [take, setTake] = useState(LESSONS_PAGE);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [msg, setMsg] = useState('');
  const key = `${filter}|${take}|${version}`;

  useEffect(() => {
    let cancelled = false;
    learningApi
      .lessons(token, projectId, { status: filter === 'all' ? undefined : filter, take })
      .then((r) => {
        if (!cancelled) setData({ key, items: r.items, total: r.total });
      })
      .catch((e) => {
        if (!cancelled) {
          setMsg(e.message || '');
          setData((d) => ({ ...d, key }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token, projectId, filter, take, key]);

  const change = async (lessonId: string, body: { status?: 'draft' | 'confirmed' | 'rejected'; text?: string }) => {
    setMsg('');
    try {
      await learningApi.setLesson(token, lessonId, body);
      setEditing(null);
      onChanged();
    } catch (e: any) {
      setMsg(e.message || '');
    }
  };

  return (
    <div>
      <div className="inline-flex p-[3px] rounded-[10px] border border-[var(--border)] gap-0.5 mb-3">
        {(['draft', 'confirmed', 'rejected', 'all'] as const).map((f) => (
          <button
            key={f}
            onClick={() => {
              setFilter(f);
              setTake(LESSONS_PAGE);
            }}
            className={cn(
              'px-3 py-1.5 rounded-[7px] text-[12px] font-medium transition-colors',
              filter === f
                ? 'bg-[var(--surface-2)] text-[var(--text)]'
                : 'text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]',
            )}
          >
            {t(`filter.${f}`)}
          </button>
        ))}
      </div>
      {msg && <p className="text-[12.5px] text-[var(--danger)] mb-3">{msg}</p>}
      {data.key === key && data.items.length === 0 ? (
        <Card className="p-6 text-center text-[13px] text-[var(--text-3)]">{t('empty')}</Card>
      ) : (
        <div className="flex flex-col gap-2.5">
          {data.items.map((l) => {
            const d = l.detail ?? {};
            return (
              <Card key={l.id} className={cn('px-[18px] py-3.5', l.status === 'rejected' && 'opacity-60')} data-testid="learning-lesson">
                <div className="flex items-center gap-2 flex-wrap mb-1.5">
                  <Badge tone={LESSON_KIND_TONE[l.kind] ?? 'neutral'}>{t(`kind.${l.kind}`)}</Badge>
                  <Badge tone={LESSON_STATUS_TONE[l.status] ?? 'neutral'} className="rounded-full px-2 py-[2px]">
                    {t(`status.${l.status}`)}
                  </Badge>
                  <span className="text-[11.5px] text-[var(--text-3)]">
                    {l.topic?.title ? `${l.topic.title} · ` : ''}
                    {t(`source.${l.source}`)}
                    {l.seenCount > 1 ? ` · ${t('seen', { count: l.seenCount })}` : ''}
                  </span>
                </div>
                {editing?.id === l.id ? (
                  <textarea
                    value={editing.text}
                    onChange={(e) => setEditing({ id: l.id, text: e.target.value })}
                    rows={3}
                    maxLength={2000}
                    className={textareaCls}
                    aria-label={t('edit')}
                  />
                ) : (
                  <p className="text-[13px] leading-relaxed text-[var(--text)] whitespace-pre-wrap">{l.text}</p>
                )}
                {(d.before || d.after || d.reason || d.needsReason) && (
                  <div className="mt-1.5 text-[12.5px] text-[var(--text-2)] space-y-0.5">
                    {d.before && (
                      <p>
                        <span className="font-medium text-[var(--text)]">{t('before')}</span> {d.before}
                      </p>
                    )}
                    {d.after && (
                      <p>
                        <span className="font-medium text-[var(--text)]">{t('after')}</span> {d.after}
                      </p>
                    )}
                    {d.reason ? (
                      <p>
                        <span className="font-medium text-[var(--text)]">{t('reason')}</span> {d.reason}
                      </p>
                    ) : d.needsReason ? (
                      <p className="text-[var(--text-3)]">{t('askWhy')}</p>
                    ) : null}
                  </div>
                )}
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  {editing?.id === l.id ? (
                    <>
                      <Button size="sm" disabled={editing.text.trim().length < 10} onClick={() => change(l.id, { text: editing.text.trim() })}>
                        {t('save')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                        {t('cancel')}
                      </Button>
                    </>
                  ) : l.status === 'superseded' ? null : (
                    <>
                      {l.status !== 'confirmed' && (
                        <Button size="sm" variant="secondary" onClick={() => change(l.id, { status: 'confirmed' })}>
                          {t('confirm')}
                        </Button>
                      )}
                      {l.status !== 'rejected' && (
                        <Button size="sm" variant="ghost" onClick={() => change(l.id, { status: 'rejected' })}>
                          {t('reject')}
                        </Button>
                      )}
                      {l.status !== 'draft' && (
                        <Button size="sm" variant="ghost" onClick={() => change(l.id, { status: 'draft' })}>
                          {t('reopen')}
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => setEditing({ id: l.id, text: l.text })}>
                        {t('edit')}
                      </Button>
                    </>
                  )}
                </div>
              </Card>
            );
          })}
          {data.total > data.items.length && (
            <Button size="sm" variant="secondary" className="self-center" onClick={() => setTake((n) => n + LESSONS_PAGE)}>
              {t('more')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function ProjectSettings({
  token,
  project,
  onSaved,
}: {
  token: string;
  project: LearningProjectDetail;
  onSaved: () => void;
}) {
  const t = useTranslations('learning.settings');
  const tn = useTranslations('learning.new');
  const { folders } = useKnowledgeFolders(token);
  const [name, setName] = useState(project.name);
  const [folderId, setFolderId] = useState(project.folder?.id ?? '');
  const [endsAt, setEndsAt] = useState(project.endsAt ? project.endsAt.slice(0, 10) : '');
  const [tags, setTags] = useState(project.tags.join(', '));
  const [publishMode, setPublishMode] = useState(project.publishMode);
  const [showExpertName, setShowExpertName] = useState(project.showExpertName);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const ended = project.status === 'ended';

  const save = async () => {
    setSaving(true);
    setMsg('');
    try {
      await learningApi.update(token, project.id, {
        name: name.trim(),
        folderId: folderId || null,
        // An ended project keeps the date it ended on.
        ...(ended ? {} : { endsAt: endsAt ? new Date(`${endsAt}T23:59:59`).toISOString() : null }),
        tags: tags
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
        publishMode,
        showExpertName,
      });
      setMsg(t('saved'));
      onSaved();
    } catch (e: any) {
      setMsg(e.message || '');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-[18px]">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className={labelCls} htmlFor="lps-name">
            {t('name')}
          </label>
          <input id="lps-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} className={inputCls} />
        </div>
        <div>
          <span className={labelCls} id="lps-folder">
            {t('folder')}
          </span>
          <AppSelect
            aria-labelledby="lps-folder"
            value={folderId}
            onValueChange={setFolderId}
            className={inputCls}
            options={folderOptions(folders, tn('noFolder'))}
          />
          <p className="text-[11.5px] text-[var(--text-3)] mt-1">{t('folderHint')}</p>
        </div>
        <div>
          <label className={labelCls} htmlFor="lps-ends">
            {t('endsAt')}
          </label>
          <input
            id="lps-ends"
            type="date"
            value={endsAt}
            disabled={ended}
            onChange={(e) => setEndsAt(e.target.value)}
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="lps-tags">
            {t('tags')}
          </label>
          <input id="lps-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder={tn('tagsHint')} className={inputCls} />
        </div>
        <div>
          <span className={labelCls} id="lps-publish">
            {t('publishMode')}
          </span>
          <AppSelect
            aria-labelledby="lps-publish"
            value={publishMode}
            onValueChange={(v) => setPublishMode(v === 'confirmed' ? 'confirmed' : 'manual')}
            className={inputCls}
            options={[
              { value: 'manual', label: tn('publishManual') },
              { value: 'confirmed', label: tn('publishConfirmed') },
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
      <div className="mt-4 flex items-center gap-3">
        <Button size="sm" disabled={saving || !name.trim()} onClick={save}>
          {t('save')}
        </Button>
        {msg && <span className="text-[12.5px] text-[var(--text-2)]">{msg}</span>}
      </div>
    </Card>
  );
}
