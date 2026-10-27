'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { mcpServers, productEvents } from '@/lib/api';
import { Card } from '@/components/ui/card';

/** How often the page asks whether a request has arrived. */
const POLL_MS = 5_000;
/** After this long without a request the page stops asking (a reload restarts it). */
const POLL_FOR_MS = 30 * 60_000;

/** Translator for the `timeAgo` namespace, from `useTranslations('timeAgo')`. */
export type TimeAgoTranslate = (key: string, values?: Record<string, number>) => string;

export function timeAgo(iso: string, t: TimeAgoTranslate, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return t('justNow');
  if (minutes < 60) return t('minutes', { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('hours', { count: hours });
  const days = Math.round(hours / 24);
  return t('days', { count: days });
}

type State =
  | { kind: 'loading' }
  | { kind: 'waiting' }
  | { kind: 'arrived'; at: string }
  | { kind: 'active'; at: string; calls: number };

/**
 * Shows, live, whether an AI client has reached this server yet.
 *
 * Most workspaces that attach a connector never send a single MCP request,
 * and nothing on the connect page told them whether the step they just did
 * in Claude or ChatGPT worked. While no request has arrived this polls the
 * server's activity and turns green the moment the first one lands.
 */
export function ConnectionCheck({
  serverId,
  token,
  onFirstCall,
}: {
  serverId: string;
  token: string;
  /** Called once when the first request arrives while the page is open. */
  onFirstCall?: () => void;
}) {
  const t = useTranslations('connectionCheck');
  const tAgo = useTranslations('timeAgo');
  const [state, setState] = useState<State>({ kind: 'loading' });
  const sawWaiting = useRef(false);
  // Latest callback without restarting the poll when the parent re-renders.
  const onFirstCallRef = useRef(onFirstCall);
  useEffect(() => {
    onFirstCallRef.current = onFirstCall;
  }, [onFirstCall]);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();

    const check = async () => {
      if (!live) return;
      // A hidden tab does not need an answer; ask again when it is visible.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        timer = setTimeout(check, POLL_MS);
        return;
      }
      try {
        const activity = await mcpServers.activity(serverId, token);
        if (!live) return;
        if (activity.lastCallAt) {
          if (sawWaiting.current) {
            setState({ kind: 'arrived', at: activity.lastCallAt });
            productEvents.track('first_call_seen', token, { serverId });
            onFirstCallRef.current?.();
          } else {
            setState({ kind: 'active', at: activity.lastCallAt, calls: activity.calls30d });
          }
          return;
        }
        sawWaiting.current = true;
        setState({ kind: 'waiting' });
      } catch {
        // A failed poll is not news; keep the current state and try again.
      }
      if (Date.now() - startedAt < POLL_FOR_MS) timer = setTimeout(check, POLL_MS);
    };

    void check();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [serverId, token]);

  if (state.kind === 'loading') return null;

  if (state.kind === 'active') {
    return (
      <div
        className="flex items-center gap-2 rounded-[10px] px-3 py-2 text-[12.5px]"
        style={{ background: 'var(--t-emerald-bg)', color: 'var(--t-emerald-fg)' }}
      >
        <span className="h-2 w-2 rounded-full bg-[var(--ok)]" aria-hidden />
        {t('active', { when: timeAgo(state.at, tAgo), calls: state.calls })}
      </div>
    );
  }

  if (state.kind === 'arrived') {
    return (
      <Card className="p-[18px]" role="region" aria-label={t('label')} aria-live="polite">
        <div className="flex items-start gap-3">
          <span
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm font-bold"
            style={{ background: 'var(--t-emerald-bg)', color: 'var(--t-emerald-fg)' }}
            aria-hidden
          >
            ✓
          </span>
          <div>
            <div className="text-sm font-semibold">{t('arrivedTitle')}</div>
            <div className="mt-1 text-[12.5px] text-[var(--text-2)]">
              {t('arrivedBody')}
            </div>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-[18px]" role="region" aria-label={t('label')} aria-live="polite">
      <div className="flex items-start gap-3">
        <span className="relative mt-1 flex h-2.5 w-2.5 flex-shrink-0" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--brand)] opacity-60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[var(--brand)]" />
        </span>
        <div>
          <div className="text-sm font-semibold">{t('waitingTitle')}</div>
          <ol className="mt-2 list-decimal space-y-1 pl-4 text-[12.5px] text-[var(--text-2)]">
            <li>{t('waitingStep1')}</li>
            <li>{t('waitingStep2')}</li>
            <li>{t('waitingStep3')}</li>
          </ol>
        </div>
      </div>
    </Card>
  );
}
