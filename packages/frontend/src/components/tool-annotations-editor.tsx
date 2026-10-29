'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { tools, type ToolAnnotations } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

/**
 * The boolean hints an operator may want to correct, in spec order. Their
 * labels and help are under `toolAnnotations.hints.<key>` in the messages.
 */
const BOOLEAN_HINTS: {
  key: 'readOnlyHint' | 'destructiveHint' | 'idempotentHint' | 'openWorldHint';
}[] = [
  { key: 'readOnlyHint' },
  { key: 'destructiveHint' },
  { key: 'idempotentHint' },
  { key: 'openWorldHint' },
];

type TriState = 'auto' | 'true' | 'false';

function toTri(value: boolean | undefined): TriState {
  if (value === undefined) return 'auto';
  return value ? 'true' : 'false';
}

/**
 * Per-tool editor for MCP annotations.
 *
 * The values are normally derived from the connector; this exists for the cases
 * the derivation cannot know — above all a read-only search endpoint exposed
 * over POST, which we deliberately do not guess at.
 */
export function ToolAnnotationsEditor({
  connectorId,
  toolId,
  onSaved,
}: {
  connectorId: string;
  toolId: string;
  onSaved?: (effective: ToolAnnotations) => void;
}) {
  const t = useTranslations('toolAnnotations');
  const { token } = useAuth();
  const [derived, setDerived] = useState<ToolAnnotations>({});
  const [effective, setEffective] = useState<ToolAnnotations>({});
  const [hasOverride, setHasOverride] = useState(false);
  const [title, setTitle] = useState('');
  const [tri, setTri] = useState<Record<string, TriState>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  // The message's colour used to come from msg.startsWith('Error'), which
  // only works in English.
  const [msgIsError, setMsgIsError] = useState(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    tools
      .getAnnotations(connectorId, toolId, token)
      .then((r) => {
        if (cancelled) return;
        setDerived(r.derived || {});
        setEffective(r.effective || {});
        setHasOverride(!!r.override);
        setTitle(r.override?.title ?? '');
        setTri({
          readOnlyHint: toTri(r.override?.readOnlyHint),
          destructiveHint: toTri(r.override?.destructiveHint),
          idempotentHint: toTri(r.override?.idempotentHint),
          openWorldHint: toTri(r.override?.openWorldHint),
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setMsgIsError(true);
        setMsg(t('error', { message: err.message }));
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [connectorId, toolId, token, t]);

  const save = async (reset = false) => {
    if (!token) return;
    setSaving(true);
    setMsg('');
    setMsgIsError(false);
    try {
      let override: ToolAnnotations | null = null;
      if (!reset) {
        const next: ToolAnnotations = {};
        if (title.trim()) next.title = title.trim();
        for (const { key } of BOOLEAN_HINTS) {
          const state = tri[key];
          if (state === 'true') next[key] = true;
          else if (state === 'false') next[key] = false;
        }
        override = Object.keys(next).length > 0 ? next : null;
      }
      const r = await tools.setAnnotations(connectorId, toolId, override, token);
      setEffective(r.effective || {});
      setHasOverride(!!r.override);
      if (reset) {
        setTitle('');
        setTri({});
      }
      setMsg(reset ? t('resetDone') : t('saved'));
      onSaved?.(r.effective || {});
      setTimeout(() => setMsg(''), 3000);
    } catch (err: any) {
      setMsgIsError(true);
      setMsg(t('error', { message: err.message }));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="text-xs text-[var(--text-3)]">{t('loading')}</div>;
  }

  const readOnly = effective.readOnlyHint === true;

  return (
    <div className="space-y-3">
      <p className="text-xs text-[var(--text-3)]">
        {t('intro')}
      </p>

      <div>
        <label className="block text-[12.5px] font-medium text-[var(--text-2)] mb-1">
          {t('title')}
        </label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={derived.title || t('titlePlaceholder')}
          className="w-full h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] outline-none focus:border-[var(--brand)]"
        />
      </div>

      <div className="space-y-2">
        {BOOLEAN_HINTS.map(({ key }) => {
          // Per the spec these two only carry meaning for a write.
          const dimmed =
            readOnly && (key === 'destructiveHint' || key === 'idempotentHint');
          return (
            <div
              key={key}
              className={`flex items-center justify-between gap-3 ${dimmed ? 'opacity-50' : ''}`}
            >
              <div className="min-w-0">
                <div className="text-[12.5px] font-medium text-[var(--text-2)]">
                  {t(`hints.${key}.label`)}
                  {dimmed && (
                    <span className="ml-1 font-normal text-[var(--text-3)]">
                      {t('ignored')}
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-[var(--text-3)]">{t(`hints.${key}.help`)}</div>
              </div>
              <select
                value={tri[key] ?? 'auto'}
                onChange={(e) =>
                  setTri((prev) => ({ ...prev, [key]: e.target.value as TriState }))
                }
                className="h-8 flex-shrink-0 rounded-[7px] border border-[var(--border)] bg-[var(--surface)] px-2 text-xs text-[var(--text)] outline-none focus:border-[var(--brand)]"
              >
                <option value="auto">
                  {derived[key] === undefined ? t('auto') : derived[key] ? t('autoYes') : t('autoNo')}
                </option>
                <option value="true">{t('yes')}</option>
                <option value="false">{t('no')}</option>
              </select>
            </div>
          );
        })}
      </div>

      <div className="rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2">
        <div className="text-[11px] uppercase tracking-wide text-[var(--text-3)] mb-1">
          {t('advertised')}
        </div>
        <code className="text-[11px] font-mono text-[var(--text-2)] break-all">
          {Object.keys(effective).length > 0
            ? JSON.stringify(effective)
            : t('none')}
        </code>
      </div>

      {msg && (
        <p
          className={`text-xs ${msgIsError ? 'text-[var(--danger)]' : 'text-[var(--ok)]'}`}
        >
          {msg}
        </p>
      )}

      <div className="flex gap-2">
        <button
          onClick={() => save(false)}
          disabled={saving}
          className="inline-flex items-center justify-center rounded-[7px] border border-[var(--brand)] bg-[var(--brand)] text-[var(--primary-foreground)] px-2.5 py-1 text-xs font-semibold disabled:opacity-50"
        >
          {saving ? t('saving') : t('save')}
        </button>
        {hasOverride && (
          <button
            onClick={() => save(true)}
            disabled={saving}
            className="inline-flex items-center justify-center rounded-[7px] border border-[var(--border)] bg-[var(--surface)] text-[var(--text-2)] px-2.5 py-1 text-xs font-medium transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)] disabled:opacity-50"
          >
            {t('reset')}
          </button>
        )}
      </div>
    </div>
  );
}
