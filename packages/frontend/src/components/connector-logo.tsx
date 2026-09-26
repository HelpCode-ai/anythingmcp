'use client';

import { useState } from 'react';

/**
 * A catalog connector's logo from /logos/connectors/<icon>.svg, falling back
 * to its initials when there is no file for that icon.
 */
export function ConnectorLogo({ icon, name, small }: { icon: string; name: string; small?: boolean }) {
  const [failed, setFailed] = useState(false);
  const size = small ? 'h-8 w-8' : 'h-10 w-10';
  if (failed) {
    return (
      <span
        aria-hidden
        className={`${size} flex flex-shrink-0 items-center justify-center rounded-[10px] bg-[var(--surface-2)] text-xs font-semibold text-[var(--text-2)]`}
      >
        {name
          .split(/\s+/)
          .slice(0, 2)
          .map((w) => w[0])
          .join('')
          .toUpperCase()}
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={`${size} flex flex-shrink-0 items-center justify-center rounded-[10px] border border-[var(--border)] bg-white p-1.5`}
    >
      <img
        src={`/logos/connectors/${icon}.svg`}
        alt=""
        className="h-full w-full object-contain"
        onError={() => setFailed(true)}
      />
    </span>
  );
}
