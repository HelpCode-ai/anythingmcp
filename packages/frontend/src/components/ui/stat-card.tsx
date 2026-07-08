import { cn } from '@/lib/utils';
import { Card } from './card';
import type { Tone } from './badge';

const iconToneStyle: Record<string, React.CSSProperties> = {
  info: { background: 'var(--t-info-bg)', color: 'var(--t-info-fg)' },
  success: { background: 'var(--t-success-bg)', color: 'var(--t-success-fg)' },
  warn: { background: 'var(--t-warn-bg)', color: 'var(--t-warn-fg)' },
  danger: { background: 'var(--t-danger-bg)', color: 'var(--t-danger-fg)' },
  emerald: { background: 'var(--t-emerald-bg)', color: 'var(--t-emerald-fg)' },
  purple: { background: 'var(--t-purple-bg)', color: 'var(--t-purple-fg)' },
  neutral: { background: 'var(--surface-2)', color: 'var(--text-2)' },
};

/**
 * StatCard — dashboard/analytics metric tile (matches prototype).
 * `hint` renders below the value; `hintTone` colors it (ok / muted).
 */
export function StatCard({
  label,
  value,
  hint,
  hintTone = 'muted',
  icon,
  iconTone = 'info',
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  hintTone?: 'ok' | 'muted' | 'warn' | 'danger';
  icon?: React.ReactNode;
  iconTone?: Tone | 'neutral';
  className?: string;
}) {
  const hintColor =
    hintTone === 'ok'
      ? 'var(--ok)'
      : hintTone === 'warn'
        ? 'var(--warn)'
        : hintTone === 'danger'
          ? 'var(--danger)'
          : 'var(--text-3)';
  return (
    <Card className={cn('p-4', className)}>
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[12.5px] font-medium text-[var(--text-2)]">{label}</span>
        {icon && (
          <span
            className="flex h-[30px] w-[30px] items-center justify-center rounded-lg"
            style={iconToneStyle[iconTone] ?? iconToneStyle.info}
          >
            {icon}
          </span>
        )}
      </div>
      <div className="text-[28px] font-semibold tracking-[-0.03em]">{value}</div>
      {hint != null && (
        <div className="mt-0.5 text-xs" style={{ color: hintColor }}>
          {hint}
        </div>
      )}
    </Card>
  );
}
