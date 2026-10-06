'use client';

import { useState, useEffect } from 'react';
import { useEdition } from '@/lib/use-edition';

const STORAGE_KEY = 'amcp:hide-github-star';

export function GithubStarButton() {
  const { edition } = useEdition();
  const [dismissed, setDismissed] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    try {
      if (localStorage.getItem(STORAGE_KEY) === 'true') {
        setDismissed(true);
      }
    } catch {}
  }, []);

  if (!mounted || !edition || dismissed) return null;

  const handleDismiss = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDismissed(true);
    try {
      localStorage.setItem(STORAGE_KEY, 'true');
    } catch {}
  };

  return (
    <div className="mx-3 mb-2 flex items-center justify-between gap-2 rounded-[10px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs shadow-sm transition-colors hover:border-[var(--text-3)] group">
      <a
        href="https://github.com/HelpCode-ai/anythingmcp"
        target="_blank"
        rel="noopener noreferrer"
        className="flex min-w-0 flex-1 items-center gap-2 text-[var(--text)] hover:text-[var(--text)] no-underline"
      >
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-amber-500 flex-shrink-0"
        >
          <path d="m12 3 2.2 4.6 5 .7-3.6 3.5.9 5L12 14.9 7.5 16.8l.9-5L4.8 8.3l5-.7z" />
        </svg>
        <span className="truncate font-medium">Star on GitHub</span>
      </a>
      <button
        type="button"
        onClick={handleDismiss}
        title="Hide button"
        aria-label="Hide Star on GitHub button"
        className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-[var(--text-3)] hover:bg-[var(--surface-2)] hover:text-[var(--text)] transition-colors"
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
