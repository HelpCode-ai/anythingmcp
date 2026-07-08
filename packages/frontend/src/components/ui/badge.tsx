import { cn } from '@/lib/utils';

/** Tag tone → CSS var pair from the redesign palette. */
export type Tone =
  | 'info'
  | 'success'
  | 'warn'
  | 'danger'
  | 'neutral'
  | 'pink'
  | 'purple'
  | 'emerald'
  | 'brand';

const toneStyle: Record<Tone, React.CSSProperties> = {
  info: { background: 'var(--t-info-bg)', color: 'var(--t-info-fg)' },
  success: { background: 'var(--t-success-bg)', color: 'var(--t-success-fg)' },
  warn: { background: 'var(--t-warn-bg)', color: 'var(--t-warn-fg)' },
  danger: { background: 'var(--t-danger-bg)', color: 'var(--t-danger-fg)' },
  neutral: { background: 'var(--t-neutral-bg)', color: 'var(--t-neutral-fg)' },
  pink: { background: 'var(--t-pink-bg)', color: 'var(--t-pink-fg)' },
  purple: { background: 'var(--t-purple-bg)', color: 'var(--t-purple-fg)' },
  emerald: { background: 'var(--t-emerald-bg)', color: 'var(--t-emerald-fg)' },
  brand: { background: 'var(--brand-tint)', color: 'var(--brand)' },
};

/** A connector-type-style badge: small, square-ish, uppercase tone label. */
export function Badge({
  tone = 'neutral',
  className,
  style,
  ...props
}: { tone?: Tone } & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2 py-[3px] text-[10.5px] font-semibold tracking-[0.02em]',
        className
      )}
      style={{ ...toneStyle[tone], ...style }}
      {...props}
    />
  );
}

/** A pill status badge with an optional leading dot (healthy / down / etc.). */
export function StatusPill({
  tone = 'neutral',
  dot,
  className,
  children,
  style,
  ...props
}: { tone?: Tone; dot?: string } & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-[5px] rounded-full px-[9px] py-1 text-[11.5px] font-semibold',
        className
      )}
      style={{ ...toneStyle[tone], ...style }}
      {...props}
    >
      {dot && (
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: dot }}
        />
      )}
      {children}
    </span>
  );
}
