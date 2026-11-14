'use client';

import { useTranslations } from 'next-intl';
import type { SetupEffort } from './api';

/** "API key · 2 min" in the UI language: what a setup asks of the user, before they open it. */
export function useEffortLabel(): (e: SetupEffort) => string {
  const t = useTranslations('setupEffort');
  return (e) =>
    e.effort === 'none' || e.effort === 'one_click'
      ? t(`names.${e.effort}`)
      : t('withMinutes', { name: t(`names.${e.effort}`), minutes: e.minutes });
}
