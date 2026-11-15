import type { Tone } from '@/components/ui/badge';

/** Badge tone of a learning project's state (`overPlan` = open, but not in the plan). */
export const LEARNING_STATUS_TONE: Record<string, Tone> = {
  draft: 'warn',
  active: 'success',
  paused: 'neutral',
  ended: 'neutral',
  overPlan: 'danger',
};

export const LESSON_STATUS_TONE: Record<string, Tone> = {
  draft: 'warn',
  confirmed: 'success',
  rejected: 'neutral',
  superseded: 'neutral',
};

export const LESSON_KIND_TONE: Record<string, Tone> = {
  rule: 'info',
  correction: 'purple',
  fact: 'emerald',
  example: 'neutral',
};
