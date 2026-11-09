'use client';

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import { productEvents, type FitAxis } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { fitFor, formatStorage, planById } from '@/lib/card-trial';
import { fitPlanOf, pausedByPlanSets, usePlanFit, usePlanUsage } from '@/lib/use-plan-fit';
import { deviceKind } from '@/lib/paywall-tracking';
import { PlanFitNotice } from '@/components/plan-fit-notice';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * Settings → License on Cloud: the workspace's usage against its plan, one
 * meter per limit (connectors, MCP servers, users, File Search folders, files
 * and storage, saved code tools, code runs this month) and whether inline code
 * is included. Built from the plan fit of the plan in use (a trial runs on
 * Team's limits). During a trial, "See what changes with Starter" opens the
 * same block as the checkout. Renders nothing when the server has no plan fit
 * (self-hosted, Enterprise, an older backend).
 */
export function PlanUsageMeters({ plan }: { plan: string | null | undefined }) {
  const t = useTranslations('planUsage');
  const { token } = useAuth();
  const fitPlan = fitPlanOf(plan);
  const fits = usePlanFit(!!fitPlan);
  const { usage } = usePlanUsage();
  const [showStarter, setShowStarter] = useState(false);
  const fit = fitPlan ? fitFor(fits, fitPlan) : null;
  if (!fit) return null;

  const trial = plan === 'trial';
  const paused = pausedByPlanSets(usage);
  const starter = trial ? fitFor(fits, 'starter') : null;
  const track = (action: 'plan_fit_shown' | 'plan_fit_details_opened', p: 'starter' | 'team') => {
    if (token) productEvents.track('paywall_action', token, { source: 'license_page', action, plan: p, device: deviceKind() });
  };

  const inline = fit.code.inlineIncluded
    ? t('included')
    : fit.code.inlineInUse
      ? t('inUseNotIncluded')
      : t('notIncluded');

  return (
    <Card className="p-5" data-testid="plan-usage">
      <h2 className="mb-4 text-sm font-semibold text-[var(--text)]">
        {trial ? t('titleTrial') : t('title', { plan: planById(fit.plan).name })}
      </h2>
      <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
        <Meter label={t('connectors')} axis={fit.connectors} note={paused.connectors.size ? t('paused', { count: paused.connectors.size }) : null} />
        <Meter label={t('mcpServers')} axis={fit.mcpServers} note={paused.mcpServers.size ? t('paused', { count: paused.mcpServers.size }) : null} />
        <Meter label={t('users')} axis={fit.users} />
        <Meter label={t('fileSearchFolders')} axis={fit.fileSearch.connectors} />
        <Meter label={t('fileSearchFiles')} axis={fit.fileSearch.files} />
        <Meter label={t('fileSearchStorage')} axis={fit.fileSearch.bytes} format={formatStorage} />
        <Meter label={t('codeTools')} axis={fit.code.tools} />
        {/* A trial without a card has a lower run cap than Team: no max shown. */}
        <Meter
          label={t('codeRuns')}
          axis={trial ? { ...fit.code.runsThisMonth, max: null, over: false } : fit.code.runsThisMonth}
          hideUnlimited={trial}
        />
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <span className="text-[var(--text-2)]">{t('inlineCode')}</span>
          <span
            className={cn(
              'font-medium',
              fit.code.inlineInUse && !fit.code.inlineIncluded ? 'text-[var(--warning-text)]' : 'text-[var(--text)]',
            )}
          >
            {inline}
          </span>
        </div>
      </div>

      {starter && !starter.fits && (
        <div className="mt-5 border-t border-[var(--border)] pt-4">
          <button
            type="button"
            onClick={() => setShowStarter((v) => !v)}
            aria-expanded={showStarter}
            className="inline-flex items-center gap-1 text-[13px] font-medium text-[var(--brand)] hover:underline"
          >
            {showStarter ? t('hideStarter') : t('seeStarter')}
            <ChevronDown aria-hidden size={14} className={cn('transition-transform', showStarter && 'rotate-180')} />
          </button>
          {showStarter && <PlanFitNotice fit={starter} className="mt-3" onTrack={track} />}
        </div>
      )}
    </Card>
  );
}

function Meter({
  label,
  axis,
  note,
  format: formatProp,
  hideUnlimited = false,
}: {
  label: string;
  axis: FitAxis;
  note?: string | null;
  format?: (n: number) => string;
  hideUnlimited?: boolean;
}) {
  const t = useTranslations('planUsage');
  const intl = useFormatter();
  const format = formatProp ?? ((n: number) => intl.number(n));
  const limited = axis.max != null;
  const share = limited ? (axis.max === 0 ? (axis.current > 0 ? 1 : 0) : Math.min(1, axis.current / axis.max!)) : 0;
  const value = limited
    ? `${format(axis.current)} / ${format(axis.max!)}`
    : hideUnlimited
      ? format(axis.current)
      : t('unlimited', { current: format(axis.current) });
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-[var(--text-2)]">{label}</span>
        <span
          className={cn('font-medium tabular-nums', axis.over ? 'text-[var(--warning-text)]' : 'text-[var(--text)]')}
        >
          {value}
        </span>
      </div>
      {limited && (
        <div
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={axis.max!}
          aria-valuenow={axis.current}
          className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--surface-3)]"
        >
          <div
            className="h-full rounded-full"
            style={{
              width: `${Math.max(share * 100, axis.current > 0 ? 3 : 0)}%`,
              background: axis.over ? 'var(--t-warn-fg)' : 'var(--brand)',
            }}
          />
        </div>
      )}
      {note && <div className="mt-1 text-xs text-[var(--text-3)]">{note}</div>}
    </div>
  );
}
