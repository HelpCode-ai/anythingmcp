'use client';

import { useEffect, useState } from 'react';
import { tools, type ToolAnnotations } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

/** The three boolean hints an operator may want to correct, in spec order. */
const BOOLEAN_HINTS: {
  key: 'readOnlyHint' | 'destructiveHint' | 'idempotentHint' | 'openWorldHint';
  label: string;
  help: string;
}[] = [
  {
    key: 'readOnlyHint',
    label: 'Read-only',
    help: 'The tool cannot change anything. Agents probe read-only tools much more freely — set this for searches exposed over POST.',
  },
  {
    key: 'destructiveHint',
    label: 'Destructive',
    help: 'The write removes or overwrites data, rather than only adding to it. Only meaningful when the tool is not read-only.',
  },
  {
    key: 'idempotentHint',
    label: 'Idempotent',
    help: 'Calling it again with the same arguments changes nothing further. Only meaningful when the tool is not read-only.',
  },
  {
    key: 'openWorldHint',
    label: 'Open world',
    help: 'Talks to an external system whose contents we cannot bound. False for a database or a static payload.',
  },
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
  const { token } = useAuth();
  const [derived, setDerived] = useState<ToolAnnotations>({});
  const [effective, setEffective] = useState<ToolAnnotations>({});
  const [hasOverride, setHasOverride] = useState(false);
  const [title, setTitle] = useState('');
  const [tri, setTri] = useState<Record<string, TriState>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

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
      .catch((err) => !cancelled && setMsg(`Error: ${err.message}`))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [connectorId, toolId, token]);

  const save = async (reset = false) => {
    if (!token) return;
    setSaving(true);
    setMsg('');
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
      setMsg(reset ? 'Reset to derived values' : 'Saved');
      onSaved?.(r.effective || {});
      setTimeout(() => setMsg(''), 3000);
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="text-xs text-[var(--text-3)]">Loading hints…</div>;
  }

  const readOnly = effective.readOnlyHint === true;

  return (
    <div className="space-y-3">
      <p className="text-xs text-[var(--text-3)]">
        Hints MCP clients read before calling this tool — most importantly whether it
        is read-only. They are inferred from the connector; override them only when
        the inference is wrong (typically a read-only search exposed over POST).
      </p>

      <div>
        <label className="block text-[12.5px] font-medium text-[var(--text-2)] mb-1">
          Title
        </label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={derived.title || 'Derived from the tool name'}
          className="w-full h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] outline-none focus:border-[var(--brand)]"
        />
      </div>

      <div className="space-y-2">
        {BOOLEAN_HINTS.map(({ key, label, help }) => {
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
                  {label}
                  {dimmed && (
                    <span className="ml-1 font-normal text-[var(--text-3)]">
                      (ignored for read-only tools)
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-[var(--text-3)]">{help}</div>
              </div>
              <select
                value={tri[key] ?? 'auto'}
                onChange={(e) =>
                  setTri((prev) => ({ ...prev, [key]: e.target.value as TriState }))
                }
                className="h-8 flex-shrink-0 rounded-[7px] border border-[var(--border)] bg-[var(--surface)] px-2 text-xs text-[var(--text)] outline-none focus:border-[var(--brand)]"
              >
                <option value="auto">
                  Auto{derived[key] !== undefined ? ` (${derived[key] ? 'yes' : 'no'})` : ''}
                </option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            </div>
          );
        })}
      </div>

      <div className="rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2">
        <div className="text-[11px] uppercase tracking-wide text-[var(--text-3)] mb-1">
          Advertised to clients
        </div>
        <code className="text-[11px] font-mono text-[var(--text-2)] break-all">
          {Object.keys(effective).length > 0
            ? JSON.stringify(effective)
            : '— none —'}
        </code>
      </div>

      {msg && (
        <p
          className={`text-xs ${msg.startsWith('Error') ? 'text-[var(--danger)]' : 'text-[var(--ok)]'}`}
        >
          {msg}
        </p>
      )}

      <div className="flex gap-2">
        <button
          onClick={() => save(false)}
          disabled={saving}
          className="inline-flex items-center justify-center rounded-[7px] border border-[var(--brand)] bg-[var(--brand)] text-white px-2.5 py-1 text-xs font-semibold disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save hints'}
        </button>
        {hasOverride && (
          <button
            onClick={() => save(true)}
            disabled={saving}
            className="inline-flex items-center justify-center rounded-[7px] border border-[var(--border)] bg-[var(--surface)] text-[var(--text-2)] px-2.5 py-1 text-xs font-medium transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)] disabled:opacity-50"
          >
            Reset to derived
          </button>
        )}
      </div>
    </div>
  );
}
