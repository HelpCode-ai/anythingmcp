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

  if (process.env.NEXT_PUBLIC_HIDE_GITHUB_STAR === 'true') {
    return null;
  }

  const handleDismiss = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDismissed(true);
    try {
      localStorage.setItem(STORAGE_KEY, 'true');
    } catch {}
  };

  return (
    <div className="mx-3 mb-2 px-3 py-2.5 rounded-[10px] border border-[var(--border)] bg-[var(--surface)] text-xs flex items-center justify-between gap-2 shadow-sm transition-colors hover:border-[var(--text-3)] group">
      <a
        href="https://github.com/HelpCode-ai/anythingmcp"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 flex-1 min-w-0 text-[var(--text)] hover:text-[var(--text)] no-underline"
      >
        <span className="text-amber-500 font-medium flex-shrink-0">⭐</span>
        <span className="truncate font-medium">Star on GitHub</span>
      </a>
      <button
        type="button"
        onClick={handleDismiss}
        title="Hide button"
        aria-label="Hide Star on GitHub button"
        className="text-[var(--text-3)] hover:text-[var(--text)] p-0.5 rounded transition-colors opacity-60 group-hover:opacity-100 flex-shrink-0"
      >
        ×
      </button>
    </div>
  );
}
