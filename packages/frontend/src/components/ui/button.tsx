'use client';

import { forwardRef } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Button — redesign primitive.
 * Variants and sizes mirror the AnythingMCP Redesign prototype:
 * primary (brand), secondary (surface + border), ghost, danger.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[9px] font-semibold ' +
    'font-[inherit] transition-colors disabled:opacity-50 disabled:pointer-events-none',
  {
    variants: {
      variant: {
        primary:
          'bg-[var(--brand)] text-white shadow-[0_2px_8px_var(--brand-ring)] hover:bg-[var(--brand-strong)]',
        secondary:
          'border border-[var(--border)] bg-[var(--surface)] text-[var(--text-2)] hover:border-[var(--border-strong)] hover:text-[var(--text)]',
        ghost:
          'bg-transparent text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]',
        danger:
          'bg-[var(--danger)] text-white hover:opacity-90',
        outlineBrand:
          'border border-[var(--brand)] bg-[var(--brand-tint)] text-[var(--brand)] hover:bg-[var(--brand)] hover:text-white',
      },
      size: {
        sm: 'h-8 px-3 text-[12.5px]',
        md: 'h-9 px-3.5 text-[13px]',
        lg: 'h-10 px-4 text-[13.5px]',
        icon: 'h-9 w-9 p-0',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  )
);
Button.displayName = 'Button';

export { buttonVariants };
