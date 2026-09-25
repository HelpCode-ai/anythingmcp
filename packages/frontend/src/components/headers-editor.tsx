'use client';

import { cn } from '@/lib/utils';

export interface HeaderRow {
  key: string;
  value: string;
}

const inputClass =
  'h-9 w-full rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13.5px] text-[var(--text)] placeholder:text-[var(--text-3)] outline-none focus:border-[var(--border-strong)]';
const labelClass = 'mb-1.5 block text-[12.5px] font-medium text-[var(--text)]';

/**
 * Key/value editor for connector-level custom HTTP headers. The parent owns the
 * `rows` array; empty rows are kept for editing and filtered out at submit time
 * via {@link headerRowsToObject}. Values render as text (not password) so users
 * can verify what they typed — connector headers are not necessarily secrets.
 * A header the server reports as a stored secret (`maskedKeys`) is the
 * exception: it arrives empty and renders as a password field.
 */
export function HeadersEditor({
  rows,
  onChange,
  label = 'Custom headers',
  hint = 'Sent on every request to this API. Useful for APIs that require extra headers (e.g. Autotask: Username, Secret, ApiIntegrationCode).',
  maskedKeys,
}: {
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
  label?: string;
  hint?: string;
  /** Headers holding a stored secret: the server sends them empty, and an
   *  empty value sent back keeps the stored one. */
  maskedKeys?: string[];
}) {
  const masked = new Set(maskedKeys ?? []);
  const update = (i: number, patch: Partial<HeaderRow>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const add = () => onChange([...rows, { key: '', value: '' }]);
  const remove = (i: number) => onChange(rows.filter((_, idx) => idx !== i));

  return (
    <div>
      <label className={labelClass}>{label}</label>
      {rows.length > 0 && (
        <div className="mb-2 flex flex-col gap-2">
          {rows.map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="text"
                value={row.key}
                readOnly={masked.has(row.key)}
                aria-label="Header name"
                onChange={(e) => update(i, { key: e.target.value })}
                placeholder="Header-Name"
                className={cn(inputClass, 'font-mono text-[13px]')}
              />
              <input
                type={masked.has(row.key) ? 'password' : 'text'}
                autoComplete={masked.has(row.key) ? 'new-password' : 'off'}
                value={row.value}
                aria-label={`Value of header ${row.key.trim() || 'new header'}`}
                onChange={(e) => update(i, { value: e.target.value })}
                placeholder={masked.has(row.key) ? 'Set — leave empty to keep current' : 'value'}
                className={cn(inputClass, 'font-mono text-[13px]')}
              />
              <button
                type="button"
                onClick={() => remove(i)}
                aria-label="Remove header"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] border border-[var(--border)] text-[var(--text-3)] hover:border-[var(--danger)] hover:text-[var(--danger)]"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={add}
        className="rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--text-2)] hover:border-[var(--border-strong)]"
      >
        + Add header
      </button>
      {hint && <p className="mt-1.5 text-[11.5px] text-[var(--text-3)]">{hint}</p>}
    </div>
  );
}

/** Convert editor rows to a headers object, dropping rows with an empty key. */
export function headerRowsToObject(rows: HeaderRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of rows) {
    const k = key.trim();
    if (k) out[k] = value;
  }
  return out;
}

/** Convert a stored headers object back into editor rows. */
export function objectToHeaderRows(
  headers: Record<string, string> | null | undefined,
): HeaderRow[] {
  if (!headers || typeof headers !== 'object') return [];
  return Object.entries(headers).map(([key, value]) => ({
    key,
    value: String(value ?? ''),
  }));
}
