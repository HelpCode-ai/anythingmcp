'use client';

import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { Pause } from 'lucide-react';
import {
  connectors as connectorsApi,
  license,
  mcpServers as mcpServersApi,
  type PlanLimitAxis,
  type PlanLimitError,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { useManagePlan } from '@/lib/use-manage-plan';
import { buildEnterpriseContactUrl } from '@/lib/marketing';
import { fitPlanOf, usePlanUsage } from '@/lib/use-plan-fit';
import { Button, buttonVariants } from '@/components/ui/button';
import { StatusPill } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export type SwapAxis = Exclude<PlanLimitAxis, 'users'>;

interface Candidate {
  id: string;
  name: string;
  /** Tool calls in the last 30 days, when known. */
  calls: number | null;
}

const UPGRADE_UTM = { utm_source: 'plan-swap', utm_medium: 'dialog', utm_campaign: 'plan-limit' };

/** "Paused: plan limit": the item was paused by the last automatic downgrade. */
export function PausedByPlanBadge({ className }: { className?: string }) {
  const t = useTranslations('planSwap');
  return (
    <StatusPill tone="warn" dot="var(--t-warn-fg)" className={className} data-testid="paused-by-plan">
      {t('badge')}
    </StatusPill>
  );
}

/**
 * Upgrade from the plan in use: Starter goes to Team through the billing
 * portal; past Team (or on a trial, which already has Team's limits)
 * Enterprise is a quote.
 */
function UpgradeLink({ plan, className }: { plan: string | null | undefined; className?: string }) {
  const t = useTranslations('planSwap');
  const managePlan = useManagePlan(UPGRADE_UTM);
  if (plan === 'starter') {
    return (
      <a
        href={managePlan.href}
        onClick={managePlan.onClick}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
      >
        {t('upgradeTeam')}
      </a>
    );
  }
  return (
    <a href={buildEnterpriseContactUrl(UPGRADE_UTM)} target="_blank" rel="noopener noreferrer" className={className}>
      {t('askEnterprise')}
    </a>
  );
}

/**
 * The swap at the plan's cap: "Your plan includes 5 active connectors. Pause
 * one to activate this one", with the active ones (most used first when the
 * plan fit gives their calls), "Pause and activate", and the upgrade.
 *
 * Without `target` it is the create case: pause one so a new one can be added.
 * `activate` replaces the default activation (the connector page saves its
 * whole form instead). Cloud only; nothing here runs on self-hosted.
 */
export function PlanSwapDialog({
  open,
  onOpenChange,
  axis,
  target,
  max: maxProp,
  activate,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  axis: SwapAxis;
  target?: { id: string; name: string } | null;
  max?: number | null;
  activate?: () => Promise<void>;
  onDone?: () => void;
}) {
  const t = useTranslations('planSwap');
  const { token } = useAuth();
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [ranked, setRanked] = useState(false);
  const [plan, setPlan] = useState<string | null>(null);
  const [max, setMax] = useState<number | null>(maxProp ?? null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  useEffect(() => {
    if (!open || !token) return;
    let live = true;
    (async () => {
      const usage = await license.getUsage(token).catch(() => null);
      const fitPlan = fitPlanOf(usage?.plan);
      const fit = fitPlan
        ? await license
            .getPlanFit(token, fitPlan)
            .then((r) => r?.plans?.[fitPlan] ?? null)
            .catch(() => null)
        : null;
      let list: Candidate[] = [];
      let haveCalls = false;
      if (axis === 'mcpServers') {
        const servers = await mcpServersApi.list(token).catch(() => []);
        list = servers
          .filter((s) => s.isActive && s.id !== target?.id)
          .map((s) => ({ id: s.id, name: s.name, calls: typeof s.usage?.calls30d === 'number' ? s.usage.calls30d : null }));
        haveCalls = list.some((c) => c.calls != null);
      } else {
        const all = await connectorsApi.list(token).catch(() => []);
        const ranking = axis === 'fileSearchConnectors' ? fit?.fileSearch.connectors : fit?.connectors;
        const calls = new Map<string, number>();
        for (const item of [...(ranking?.keep ?? []), ...(ranking?.pause ?? [])]) calls.set(item.id, item.calls30d);
        haveCalls = calls.size > 0;
        list = all
          .filter(
            (c) =>
              c.isActive &&
              c.id !== target?.id &&
              (axis === 'fileSearchConnectors' ? c.type === 'FILE_SEARCH' : c.type !== 'FILE_SEARCH'),
          )
          .map((c) => ({ id: c.id, name: c.name, calls: calls.get(c.id) ?? (haveCalls ? 0 : null) }));
      }
      list.sort((a, b) => (b.calls ?? 0) - (a.calls ?? 0) || a.name.localeCompare(b.name));
      if (!live) return;
      setError('');
      setDone('');
      setPlan(usage?.plan ?? null);
      if (maxProp == null) {
        const fromUsage =
          axis === 'mcpServers'
            ? usage?.mcpServers.max
            : axis === 'connectors'
              ? usage?.connectors.max
              : fit?.fileSearch.connectors.max;
        setMax(fromUsage ?? null);
      } else {
        setMax(maxProp);
      }
      setRanked(haveCalls);
      setCandidates(list);
      // The least used is the natural one to pause: preselect it.
      setChosen(list.length ? list[list.length - 1].id : null);
    })();
    return () => {
      live = false;
    };
  }, [open, token, axis, target?.id, maxProp]);

  const setActive = (id: string, isActive: boolean) =>
    axis === 'mcpServers'
      ? mcpServersApi.update(id, { isActive }, token!)
      : connectorsApi.update(id, { isActive }, token!);

  const run = async () => {
    if (!token || !chosen) return;
    setWorking(true);
    setError('');
    try {
      await setActive(chosen, false);
    } catch (e: any) {
      setError(t('error', { message: e?.message ?? '' }));
      setWorking(false);
      return;
    }
    if (!target) {
      const name = candidates?.find((c) => c.id === chosen)?.name ?? '';
      setDone(t('pausedDone', { name }));
      setCandidates((prev) => prev?.filter((c) => c.id !== chosen) ?? null);
      setChosen(null);
      setWorking(false);
      onDone?.();
      return;
    }
    try {
      if (activate) await activate();
      else await setActive(target.id, true);
      setWorking(false);
      onOpenChange(false);
      onDone?.();
    } catch (e: any) {
      // Put the paused one back, so a failed swap changes nothing.
      await setActive(chosen, true).catch(() => {});
      setError(t('error', { message: e?.message ?? '' }));
      setWorking(false);
    }
  };

  const titleMax = max ?? candidates?.length ?? 0;

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !working && onOpenChange(o)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          data-testid="plan-swap-dialog"
          className="fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]"
        >
          <Dialog.Title className="text-[16px] font-semibold leading-snug text-[var(--text)]">
            {t(`title.${axis}`, { max: titleMax })}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-[var(--text-2)]">
            {target ? t('body', { name: target.name }) : t('bodyCreate')}
          </Dialog.Description>

          <div className="mt-4">
            {candidates === null ? (
              <p className="text-sm text-[var(--text-3)]">{t('loading')}</p>
            ) : candidates.length === 0 ? (
              <p className="text-sm text-[var(--text-3)]">{done || t('empty')}</p>
            ) : (
              <>
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-[var(--text-3)]">
                  {ranked ? t('listLabel') : t('listLabelPlain')}
                </div>
                <div role="radiogroup" aria-label={ranked ? t('listLabel') : t('listLabelPlain')} className="max-h-64 space-y-1 overflow-y-auto">
                  {candidates.map((c) => {
                    const selected = chosen === c.id;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        disabled={working}
                        onClick={() => setChosen(c.id)}
                        className={cn(
                          'flex w-full items-center gap-2.5 rounded-[9px] border px-3 py-2 text-left transition-colors',
                          selected
                            ? 'border-[var(--brand)] bg-[var(--brand-tint)]'
                            : 'border-[var(--border)] hover:border-[var(--border-strong)]',
                        )}
                      >
                        <span
                          aria-hidden
                          className={cn(
                            'flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border',
                            selected ? 'border-[var(--brand)]' : 'border-[var(--border-strong)]',
                          )}
                        >
                          {selected && <span className="h-2 w-2 rounded-full bg-[var(--brand)]" />}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--text)]">{c.name}</span>
                        {c.calls != null && (
                          <span className="flex-shrink-0 text-[11.5px] tabular-nums text-[var(--text-3)]">
                            {t('calls', { count: c.calls })}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                {done && <p role="status" className="mt-2 text-xs text-[var(--ok)]">{done}</p>}
              </>
            )}
            {error && (
              <p role="alert" className="mt-2 text-xs text-[var(--danger)]">
                {error}
              </p>
            )}
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <UpgradeLink plan={plan} className="text-[13px] font-medium text-[var(--brand)] hover:underline" />
            <div className="flex gap-2">
              <Dialog.Close className={cn(buttonVariants({ variant: 'secondary', size: 'md' }))} disabled={working}>
                {t('cancel')}
              </Dialog.Close>
              <Button onClick={run} disabled={working || !chosen}>
                <Pause aria-hidden size={14} />
                {working ? t('working') : target ? t('pauseAndActivate') : t('pauseOnly')}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * A creation (or an invitation) refused at the plan's limit: the server's
 * reason in plain words, "Pause one" (opens the swap dialog to free a slot)
 * and the upgrade. Shown instead of a bare red error.
 */
export function PlanLimitNotice({ limit, onFreed }: { limit: PlanLimitError; onFreed?: () => void }) {
  const t = useTranslations('planSwap');
  const { usage } = usePlanUsage();
  const [swapOpen, setSwapOpen] = useState(false);
  const canSwap = limit.axis !== 'users';
  return (
    <div
      role="alert"
      data-testid="plan-limit-notice"
      className="rounded-[11px] border px-4 py-3 text-sm"
      style={{
        background: 'var(--t-warn-bg)',
        color: 'var(--t-warn-fg)',
        borderColor: 'color-mix(in srgb, var(--t-warn-fg) 25%, transparent)',
      }}
    >
      <p className="font-medium">{t(`notice.${limit.axis}`, { max: limit.max })}</p>
      <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
        {canSwap && (
          <button type="button" onClick={() => setSwapOpen(true)} className="font-semibold underline hover:no-underline">
            {t('pauseOne')}
          </button>
        )}
        <UpgradeLink plan={usage?.plan} className="font-semibold underline hover:no-underline" />
      </p>
      {canSwap && (
        <PlanSwapDialog
          open={swapOpen}
          onOpenChange={setSwapOpen}
          axis={limit.axis as SwapAxis}
          max={limit.max || null}
          onDone={onFreed}
        />
      )}
    </div>
  );
}
