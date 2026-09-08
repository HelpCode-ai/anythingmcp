'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';

interface MultiSelectProps {
  value: string[];
  onValueChange: (value: string[]) => void;
  options: { value: string; label: string }[];
  /** Shown when nothing is selected. */
  placeholder?: string;
  /** Shown in place of the list when there is nothing to choose from. */
  emptyMessage?: string;
  className?: string;
  disabled?: boolean;
}

/**
 * Checkbox dropdown for picking several options.
 *
 * Deliberately not built on `AppSelect`: Radix's Select is single-value by
 * design, and a listbox that reports one value while the caller needs a set is
 * the kind of mismatch that shows up later as a silently dropped selection.
 * DropdownMenu.CheckboxItem is the primitive meant for this, and it keeps the
 * menu open across clicks so several can be ticked in one go.
 */
export function MultiSelect({
  value,
  onValueChange,
  options,
  placeholder = 'None selected',
  emptyMessage,
  className,
  disabled,
}: MultiSelectProps) {
  const toggle = (v: string) =>
    onValueChange(
      value.includes(v) ? value.filter((x) => x !== v) : [...value, v],
    );

  // Names, not a bare count: "Leitung / Controlling" tells an admin what a
  // mapping grants without opening it, which "2 selected" does not.
  const selected = options.filter((o) => value.includes(o.value));
  const summary =
    selected.length === 0
      ? placeholder
      : selected.map((o) => o.label).join(', ');

  const isEmpty = options.length === 0;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        disabled={disabled || isEmpty}
        className={`flex items-center justify-between gap-2 w-full h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-left outline-none focus:border-[var(--brand)] disabled:opacity-60 disabled:cursor-not-allowed ${
          selected.length === 0 ? 'text-[var(--text-3)]' : 'text-[var(--text)]'
        } ${className ?? ''}`}
      >
        <span className="truncate">{isEmpty ? (emptyMessage ?? placeholder) : summary}</span>
        <svg
          className="w-4 h-4 text-[var(--text-3)] shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m19 9-7 7-7-7" />
        </svg>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="bg-[var(--background)] border border-[var(--border)] rounded-md shadow-md min-w-[var(--radix-dropdown-menu-trigger-width)] max-h-60 overflow-auto z-50 p-1"
        >
          {options.map((opt) => (
            <DropdownMenu.CheckboxItem
              key={opt.value}
              checked={value.includes(opt.value)}
              // Without this the menu closes on the first tick, so picking
              // three roles would mean reopening it three times.
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={() => toggle(opt.value)}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded-[6px] cursor-pointer outline-none select-none text-[var(--text)] hover:bg-[var(--surface-2)] focus:bg-[var(--surface-2)]"
            >
              <span className="w-4 h-4 shrink-0 rounded-[4px] border border-[var(--border)] flex items-center justify-center">
                <DropdownMenu.ItemIndicator>
                  <svg
                    className="w-3 h-3 text-[var(--brand)]"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={3}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="m5 13 4 4L19 7" />
                  </svg>
                </DropdownMenu.ItemIndicator>
              </span>
              <span className="truncate">{opt.label}</span>
            </DropdownMenu.CheckboxItem>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
