'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, ChevronDown } from 'lucide-react';
import type { FitItem, FitRanked, PlanFit } from '@/lib/api';
import { planById, planFitLines } from '@/lib/card-trial';
import { cn } from '@/lib/utils';

export type PlanFitEvent = 'plan_fit_shown' | 'plan_fit_details_opened';

/**
 * "What changes with Starter": what this workspace, as it is today, keeps
 * and loses on a plan (GET /api/license/plan-fit). Shown before checkout on
 * the licence wall, the card-trial page, the trial banner and the
 * reactivation page, so nobody learns after paying that something was paused.
 *
 * Informative, not a warning: neutral colours, short lines, and the plan
 * stays selectable. When everything fits, one quiet line says so (`quietFit`).
 * `anonymized` (the reactivation page, no sign-in) shows counts only and no
 * list of names.
 *
 * Words come from the `planFit` messages, so a page in another language can
 * wrap it in its own NextIntlClientProvider with those keys.
 */
export function PlanFitNotice({
  fit,
  anonymized = false,
  quietFit = true,
  onTrack,
  onChooseTeam,
  className,
}: {
  fit: PlanFit | null | undefined;
  anonymized?: boolean;
  /** When the workspace fits the plan: one quiet line (true) or nothing (false). */
  quietFit?: boolean;
  /** Reports plan_fit_shown (once per plan) and plan_fit_details_opened. */
  onTrack?: (event: PlanFitEvent, plan: PlanFit['plan']) => void;
  /** Offers a "Choose Team instead" link under a plan that does not fit. */
  onChooseTeam?: () => void;
  className?: string;
}) {
  const t = useTranslations('planFit');
  const [open, setOpen] = useState(false);
  const listId = useId();
  const lines = planFitLines(fit);
  const plan = fit?.plan;
  const changes = lines.length > 0;

  // plan_fit_shown once per plan and page, only when there is something to say.
  const reported = useRef(new Set<string>());
  const trackRef = useRef(onTrack);
  useEffect(() => {
    trackRef.current = onTrack;
  });
  useEffect(() => {
    if (!plan || !changes || reported.current.has(plan)) return;
    reported.current.add(plan);
    trackRef.current?.('plan_fit_shown', plan);
  }, [plan, changes]);

  if (!fit) return null;
  const planName = planById(fit.plan).name;

  if (!changes) {
    if (!quietFit) return null;
    return (
      <p
        data-testid="plan-fit-fits"
        className={cn('flex items-center gap-1.5 text-xs text-[var(--text-2)]', className)}
      >
        <Check aria-hidden size={14} className="flex-shrink-0 text-[var(--success)]" />
        {t('fits', { plan: planName })}
      </p>
    );
  }

  const groups = anonymized
    ? []
    : (
        [
          ['connectors', fit.connectors],
          ['mcpServers', fit.mcpServers],
          ['fileSearch', fit.fileSearch.connectors],
        ] as const
      ).filter(([, r]) => r.pause.length > 0);

  const toggle = () => {
    if (!open) onTrack?.('plan_fit_details_opened', fit.plan);
    setOpen(!open);
  };

  return (
    <section
      data-testid="plan-fit-notice"
      aria-label={t('title', { plan: planName })}
      className={cn(
        'rounded-[10px] border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2.5 text-left',
        className,
      )}
    >
      <h3 className="text-[12.5px] font-semibold text-[var(--text)]">{t('title', { plan: planName })}</h3>
      <ul className="mt-1 space-y-0.5 text-xs leading-snug text-[var(--text-2)]">
        {lines.map((line) => (
          <li key={line.key}>{t(`lines.${line.key}`, line.values)}</li>
        ))}
      </ul>

      {(groups.length > 0 || onChooseTeam) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          {groups.length > 0 && (
            <button
              type="button"
              onClick={toggle}
              aria-expanded={open}
              aria-controls={listId}
              className="inline-flex items-center gap-1 text-xs font-medium text-[var(--brand)] hover:underline"
            >
              {open ? t('hideDetails') : t('showDetails')}
              <ChevronDown aria-hidden size={13} className={cn('transition-transform', open && 'rotate-180')} />
            </button>
          )}
          {onChooseTeam && fit.plan !== 'team' && (
            <button
              type="button"
              onClick={onChooseTeam}
              className="text-xs font-medium text-[var(--brand)] hover:underline"
            >
              {t('chooseTeam')}
            </button>
          )}
        </div>
      )}

      {open && groups.length > 0 && (
        <div id={listId} data-testid="plan-fit-details" className="mt-2 space-y-1.5 border-t border-[var(--border)] pt-2">
          {groups.map(([key, ranked]) => (
            <FitGroup key={key} title={t(`groups.${key}`)} ranked={ranked} />
          ))}
        </div>
      )}
    </section>
  );
}

function FitGroup({ title, ranked }: { title: string; ranked: FitRanked }) {
  const t = useTranslations('planFit');
  const names = (items: FitItem[]) => items.map((i) => i.name || t('unnamed')).join(', ');
  return (
    <div className="text-xs leading-relaxed">
      <div className="font-medium text-[var(--text)]">{title}</div>
      {ranked.keep.length > 0 && (
        <p className="text-[var(--text-2)]">
          <span className="text-[var(--text-3)]">{t('keep')}:</span> {names(ranked.keep)}
        </p>
      )}
      <p className="text-[var(--text-2)]">
        <span className="text-[var(--text-3)]">{t('pause')}:</span> {names(ranked.pause)}
      </p>
    </div>
  );
}
