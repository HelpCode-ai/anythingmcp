'use client';

import { useSyncExternalStore } from 'react';

/**
 * Whether the first-success card-trial offer is on screen right now. While
 * it is, the top TrialBanner leaves out its own "Add a payment method" link,
 * so the page asks for one thing at a time. A count rather than a flag: two
 * pages' cards may overlap for a frame during navigation.
 */
let visible = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** Called by the offer while it is shown; returns the cleanup for an effect. */
export function markFirstSuccessOfferVisible(): () => void {
  visible += 1;
  emit();
  return () => {
    visible = Math.max(0, visible - 1);
    emit();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useFirstSuccessOfferVisible(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => visible > 0,
    () => false,
  );
}
