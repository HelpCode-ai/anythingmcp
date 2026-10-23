import type { SetupEffort, SetupEffortKind } from './api';
import type { Tone } from '@/components/ui/badge';

/** The marketplace filter, from least to most work. */
export const EFFORT_FILTERS: Array<{ effort: SetupEffortKind; label: string }> = [
  { effort: 'none', label: 'No setup' },
  { effort: 'one_click', label: 'Sign-in only' },
  { effort: 'api_key', label: 'API key' },
  { effort: 'own_app', label: 'Own app' },
  { effort: 'admin_needed', label: 'Admin needed' },
];

const NAMES: Record<SetupEffortKind, string> = {
  none: 'No setup',
  one_click: '1-click sign-in',
  api_key: 'API key',
  own_app: 'Own app',
  admin_needed: 'Admin needed',
};

/** "API key · 2 min": what a setup asks of the user, before they open it. */
export function effortLabel(e: SetupEffort): string {
  if (e.effort === 'none' || e.effort === 'one_click') return NAMES[e.effort];
  return `${NAMES[e.effort]} · ${e.minutes} min`;
}

export function effortTone(e: SetupEffort): Tone {
  if (e.effort === 'none' || e.effort === 'one_click') return 'emerald';
  if (e.effort === 'api_key') return 'neutral';
  return 'warn';
}
