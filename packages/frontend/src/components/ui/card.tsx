import { forwardRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * Card — redesign surface primitive.
 * Default: surface bg, 1px border, 14px radius, soft shadow (matches prototype).
 */
export const Card = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'rounded-[14px] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-sm)]',
        className
      )}
      {...props}
    />
  )
);
Card.displayName = 'Card';

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-center justify-between', className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <div className={cn('text-sm font-semibold text-[var(--text)]', className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('', className)} {...props} />;
}
