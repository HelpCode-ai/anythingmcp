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

export function effortTone(e: SetupEffort): Tone {
  if (e.effort === 'none' || e.effort === 'one_click') return 'emerald';
  if (e.effort === 'api_key') return 'neutral';
  return 'warn';
}
