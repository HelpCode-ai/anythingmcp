'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { connectors, type RecentWebhookEvent } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { copyText } from '@/lib/clipboard';
import { useToast } from '@/components/toast';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

/**
 * Inbound webhook ingestion (issue #1393 point 2): a switch to opt the
 * connector in, the delivery URL to paste into the provider, the signing
 * secret (write-only, like authConfig — never read back), and the last few
 * verified deliveries. Stripe only for now (webhook-ingest.controller.ts);
 * gated the same way as every other connector setting on this page.
 */
export function WebhookCard({
  connectorId,
  webhookEnabled,
  canManage,
  onChanged,
}: {
  connectorId: string;
  webhookEnabled: boolean;
  canManage: boolean;
  onChanged: () => void;
}) {
  const { token } = useAuth();
  const t = useTranslations('webhook');
  const locale = useLocale();
  const toast = useToast();

  const [toggling, setToggling] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [secret, setSecret] = useState('');
  const [savingSecret, setSavingSecret] = useState(false);
  const [events, setEvents] = useState<RecentWebhookEvent[] | null>(null);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [error, setError] = useState('');

  const loadUrl = useCallback(() => {
    if (!token || !webhookEnabled) return;
    connectors.webhookUrl(connectorId, token).then((r) => setUrl(r.url)).catch(() => setUrl(null));
  }, [token, connectorId, webhookEnabled]);

  const loadEvents = useCallback(() => {
    if (!token || !webhookEnabled) return;
    setLoadingEvents(true);
    connectors
      .webhookEvents(connectorId, token, { limit: 10 })
      .then((r) => setEvents(r.events))
      .catch(() => setEvents(null))
      .finally(() => setLoadingEvents(false));
  }, [token, connectorId, webhookEnabled]);

  useEffect(() => {
    loadUrl();
    loadEvents();
  }, [loadUrl, loadEvents]);

  // Nothing to show a non-manager who also can't see it enabled, and nothing
  // for anyone to act on while it's off and they can't turn it on.
  if (!canManage && !webhookEnabled) return null;

  const toggle = async (next: boolean) => {
    if (!token) return;
    setToggling(true);
    setError('');
    try {
      await connectors.update(
        connectorId,
        next ? { webhookEnabled: true, webhookProvider: 'stripe' } : { webhookEnabled: false },
        token,
      );
      onChanged();
    } catch (err: any) {
      setError(err?.message || t('toggleError'));
    } finally {
      setToggling(false);
    }
  };

  const saveSecret = async () => {
    if (!token || !secret.trim()) return;
    setSavingSecret(true);
    setError('');
    try {
      await connectors.update(connectorId, { webhookSecret: secret.trim() }, token);
      setSecret('');
      toast.show({ tone: 'success', title: t('secretSaved') });
    } catch (err: any) {
      setError(err?.message || t('secretError'));
    } finally {
      setSavingSecret(false);
    }
  };

  const copyUrl = async () => {
    if (!url) return;
    const ok = await copyText(url);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast.show({ tone: 'error', title: t('copyFailed') });
    }
  };

  return (
    <Card className="p-[22px]">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold mb-1">{t('title')}</h3>
          <p className="text-sm text-[var(--text-3)] max-w-prose">{t('body')}</p>
        </div>
        {canManage && (
          <div className="flex items-center gap-2 shrink-0">
            <input
              type="checkbox"
              id="webhookEnabled"
              checked={webhookEnabled}
              disabled={toggling}
              onChange={(e) => toggle(e.target.checked)}
            />
            <label htmlFor="webhookEnabled" className="text-sm">{t('enable')}</label>
          </div>
        )}
      </div>

      {webhookEnabled && (
        <div className="mt-4 space-y-4">
          <div>
            <p className="text-xs text-[var(--text-3)] mb-1">{t('urlLabel')}</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 truncate text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded-[9px] px-3 py-2">
                {url ?? '…'}
              </code>
              <Button variant="secondary" size="md" onClick={copyUrl} disabled={!url}>
                {copied ? t('copied') : t('copy')}
              </Button>
            </div>
          </div>

          {canManage && (
            <div>
              <p className="text-xs text-[var(--text-3)] mb-1">{t('secretLabel')}</p>
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  autoComplete="off"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={t('secretPlaceholder')}
                  className="flex-1 min-w-0 border border-[var(--border)] rounded-[9px] px-3 py-2 text-sm bg-[var(--surface)] font-mono focus:outline-none focus:border-[var(--border-strong)]"
                />
                <Button variant="secondary" size="md" onClick={saveSecret} disabled={savingSecret || !secret.trim()}>
                  {savingSecret ? t('saving') : t('save')}
                </Button>
              </div>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs text-[var(--text-3)]">{t('eventsLabel')}</p>
              <Button variant="ghost" size="sm" onClick={loadEvents} disabled={loadingEvents}>
                {t('refresh')}
              </Button>
            </div>
            {events === null || events.length === 0 ? (
              <p className="text-sm text-[var(--text-3)]">{loadingEvents ? t('loading') : t('noEvents')}</p>
            ) : (
              <ul className="divide-y divide-[var(--border)] border border-[var(--border)] rounded-[9px] overflow-hidden">
                {events.map((ev) => (
                  <li key={ev.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <div className="min-w-0">
                      <p className="font-medium truncate">{ev.eventType ?? t('unknownType')}</p>
                      {ev.externalId && (
                        <p className="text-xs text-[var(--text-3)] truncate font-mono">{ev.externalId}</p>
                      )}
                    </div>
                    <span className="text-xs text-[var(--text-3)] whitespace-nowrap">
                      {new Date(ev.receivedAt).toLocaleString(locale)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-[var(--danger)]">{error}</p>}
    </Card>
  );
}
