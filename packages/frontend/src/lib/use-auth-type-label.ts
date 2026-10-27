'use client';

import { useTranslations } from 'next-intl';
import { authTypeLabel } from './utils';

/**
 * `authTypeLabel` in the UI language. An auth type the messages don't know
 * (a new one from the backend) falls back to the English label.
 */
export function useAuthTypeLabel(): (authType: string | null | undefined) => string {
  const t = useTranslations('authTypes');
  return (authType) => {
    if (!authType) return t('none');
    return t.has(authType) ? t(authType) : authTypeLabel(authType);
  };
}
