'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { learning as learningApi, type MyLearningProject } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

/**
 * The member's side of a learning project, on their profile: read what would
 * be kept and accept or decline, and later stop at any time, with or without
 * erasing what was not published. Renders nothing for a member without one.
 */
export function LearningProjectsCard({ token }: { token: string }) {
  const t = useTranslations('learning.profile');
  const locale = useLocale();
  const [projects, setProjects] = useState<MyLearningProject[]>([]);
  const [erase, setErase] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    learningApi
      .mine(token)
      .then(setProjects)
      .catch(() => setProjects([]));
  }, [token]);
  useEffect(load, [load]);

  if (!projects.length && !msg) return null;

  const run = async (id: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(id);
    setMsg('');
    try {
      await fn();
      setMsg(done);
      load();
    } catch (e: any) {
      setMsg(e.message || t('failed'));
    } finally {
      setBusy('');
    }
  };

  return (
    <Card className="p-[22px]" data-testid="learning-projects-card">
      <h3 className="text-sm font-semibold text-[var(--text)] mb-2">{t('title')}</h3>
      {msg && <p className="text-sm text-[var(--text-2)] mb-3 max-w-xl">{msg}</p>}
      <div className="flex flex-col gap-4">
        {projects.map((p) => {
          const server = p.mcpServer?.name ?? '';
          const notice = `${t('notice', { name: p.name, server })} ${p.showExpertName ? t('nameShown') : t('nameHidden')}`;
          if (p.status === 'draft') {
            return (
              <div key={p.id} data-testid="learning-consent">
                <p className="text-sm font-medium text-[var(--text)] mb-1.5 max-w-xl">{t('ask', { name: p.name, server })}</p>
                <p className="text-sm text-[var(--text-2)] mb-3 max-w-xl">{notice}</p>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    disabled={busy === p.id}
                    // The notice is sent as it was shown: it is what the member accepted.
                    onClick={() => run(p.id, () => learningApi.consent(token, p.id, notice), t('accepted'))}
                  >
                    {t('accept')}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy === p.id}
                    onClick={() => run(p.id, () => learningApi.withdraw(token, p.id, false), t('stopped'))}
                  >
                    {t('decline')}
                  </Button>
                </div>
              </div>
            );
          }
          return (
            <div key={p.id}>
              <p className="text-sm text-[var(--text-2)] mb-2 max-w-xl">
                {p.status === 'paused'
                  ? t('paused', { name: p.name })
                  : t('active', {
                      name: p.name,
                      server,
                      date: p.consentAt ? new Date(p.consentAt).toLocaleDateString(locale) : '',
                    })}{' '}
                {p.showExpertName ? t('nameShown') : t('nameHidden')}
              </p>
              <label className="flex items-start gap-2.5 cursor-pointer max-w-md mb-2.5">
                <input
                  type="checkbox"
                  checked={!!erase[p.id]}
                  onChange={(e) => setErase((s) => ({ ...s, [p.id]: e.target.checked }))}
                  className="mt-0.5 accent-[var(--brand)]"
                />
                <span className="text-sm text-[var(--text-2)]">{t('erase')}</span>
              </label>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy === p.id}
                onClick={() => run(p.id, () => learningApi.withdraw(token, p.id, !!erase[p.id]), t('stopped'))}
              >
                {t('stop')}
              </Button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
