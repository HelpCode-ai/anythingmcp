'use client';

import { useEffect, useState } from 'react';
import { license } from './api';

/**
 * Whether this Cloud admin can start a card trial
 * (GET /api/license/card-trial-eligibility):
 * - 'trial': yes, ending when the free trial does;
 * - 'pay': no, the address had a subscription before, so a plan starts and
 *   is billed today;
 * - 'none': no card trial applies (no running trial, under 48 hours left);
 * - 'loading' until the answer is in, and 'trial' if it cannot be had (the
 *   licence site checks again at checkout, and the app follows its answer).
 */
export type CardTrialKind = 'trial' | 'pay' | 'none';

/** One request per session token, shared by every component that asks. */
const answers = new Map<string, Promise<CardTrialKind>>();

export function fetchCardTrialKind(token: string): Promise<CardTrialKind> {
  let answer = answers.get(token);
  if (!answer) {
    answer = license
      .cardTrialEligibility(token)
      .then((r) => (r?.kind === 'pay' || r?.kind === 'none' ? r.kind : 'trial'))
      .catch(() => 'trial' as const);
    answers.set(token, answer);
  }
  return answer;
}

export function useCardTrialKind(token: string | null | undefined, enabled: boolean): CardTrialKind | 'loading' {
  const [kind, setKind] = useState<CardTrialKind | 'loading'>('loading');
  useEffect(() => {
    if (!enabled || !token) return;
    let live = true;
    void fetchCardTrialKind(token).then((k) => {
      if (live) setKind(k);
    });
    return () => {
      live = false;
    };
  }, [token, enabled]);
  return kind;
}
