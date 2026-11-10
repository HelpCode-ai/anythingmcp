'use client';

import { useEffect, useRef } from 'react';

/**
 * Clicks on the two pay screens of an ended trial, recorded as the backend's
 * `paywall_action` product event (product-event.service.ts): the licence wall
 * in the dashboard and the no-login reactivation page. Both report the same
 * actions so their funnels read side by side.
 */
export type PaywallAction =
  | 'shown'
  | 'plan_selected'
  | 'period_selected'
  | 'subscribe_clicked'
  | 'compare_plans_clicked'
  | 'sign_in_clicked'
  | 'open_workspace_clicked'
  | 'switch_workspace_clicked'
  | 'license_key_clicked'
  | 'enterprise_clicked'
  | 'support_clicked'
  | 'delete_account_clicked'
  | 'left_without_subscribe'
  // The "What changes with <plan>" block was shown (metadata.plan) because the
  // workspace is above that plan, and its list of items was opened.
  | 'plan_fit_shown'
  | 'plan_fit_details_opened';

export interface PaywallActionDetail {
  plan?: 'starter' | 'team';
  period?: 'monthly' | 'yearly';
}

/** 'mobile' for a touch screen, else 'desktop'; nothing finer is kept. */
export function deviceKind(): 'mobile' | 'desktop' {
  try {
    return window.matchMedia('(pointer: coarse)').matches ? 'mobile' : 'desktop';
  } catch {
    return 'desktop';
  }
}

/**
 * Reports `shown` once, when `ready` first turns true, and
 * `left_without_subscribe` when the page is closed or navigated away without
 * a subscribe click. Returns `subscribed()`, to call on a subscribe click.
 */
export function usePaywallLifecycle(ready: boolean, report: (action: PaywallAction) => void): () => void {
  const reportRef = useRef(report);
  const shown = useRef(false);
  const subscribedRef = useRef(false);
  const left = useRef(false);
  useEffect(() => {
    reportRef.current = report;
  });

  useEffect(() => {
    if (!ready || shown.current) return;
    shown.current = true;
    reportRef.current('shown');
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    const onLeave = () => {
      if (subscribedRef.current || left.current) return;
      left.current = true;
      reportRef.current('left_without_subscribe');
    };
    window.addEventListener('pagehide', onLeave);
    return () => window.removeEventListener('pagehide', onLeave);
  }, [ready]);

  return () => {
    subscribedRef.current = true;
  };
}
