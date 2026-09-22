'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import Link from 'next/link';
import { cn } from '@/lib/utils';

export interface ActionMenuItem {
  label: string;
  /** Leading icon. Same family and stroke as the toolbar buttons. */
  icon?: React.ReactNode;
  onSelect?: () => void;
  /** Renders the item as a link instead of a button. */
  href?: string;
  disabled?: boolean;
  /** Tints the item with the danger colour; keep it for real destruction. */
  destructive?: boolean;
}

/**
 * Overflow menu for a page toolbar.
 *
 * A phone gives a toolbar about one row. Pages that carry five actions —
 * Connectors has Health Check, Export, Import, Adapters and Add Connector —
 * either wrap to three header rows or hide their labels behind icons, and an
 * icon has no tooltip on touch. This keeps the primary action in the header
 * and moves the rest in here, where every entry still says what it does.
 *
 * Styling follows `MultiSelect`, which is the other dropdown in the app.
 */
export function ActionMenu({
  items,
  label = 'More actions',
  className,
}: {
  items: ActionMenuItem[];
  /** Accessible name for the trigger. */
  label?: string;
  className?: string;
}) {
  const visible = items.filter(Boolean);
  if (visible.length === 0) return null;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        aria-label={label}
        title={label}
        className={cn(
          'flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[9px] border border-[var(--border)] bg-[var(--surface)] text-[var(--text-2)] outline-none transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)] data-[state=open]:border-[var(--border-strong)] data-[state=open]:text-[var(--text)]',
          className
        )}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="12" cy="19" r="1.6" />
        </svg>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 min-w-[200px] overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-1 shadow-[var(--shadow)]"
        >
          {visible.map((item) => {
            const cls = cn(
              'flex cursor-pointer select-none items-center gap-2.5 rounded-[7px] px-2.5 py-2 text-[13px] outline-none',
              'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
              item.destructive
                ? 'text-[var(--danger)] hover:bg-[var(--t-danger-bg)] focus:bg-[var(--t-danger-bg)]'
                : 'text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)] focus:bg-[var(--surface-2)] focus:text-[var(--text)]'
            );
            return (
              <DropdownMenu.Item
                key={item.label}
                disabled={item.disabled}
                onSelect={item.onSelect}
                asChild={!!item.href}
                className={item.href ? undefined : cls}
              >
                {item.href ? (
                  <Link href={item.href} className={cls}>
                    {item.icon}
                    <span className="truncate">{item.label}</span>
                  </Link>
                ) : (
                  <>
                    {item.icon}
                    <span className="truncate">{item.label}</span>
                  </>
                )}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
