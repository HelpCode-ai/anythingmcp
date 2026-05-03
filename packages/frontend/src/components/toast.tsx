'use client';

/**
 * Unified toast system built on @radix-ui/react-toast.
 *
 * Replaces the ad-hoc `setMsg(string)` pattern that pages were using to
 * surface success/error feedback. Pages call `useToast().show({...})`;
 * the queue is rendered by the global Toaster mounted in providers.tsx.
 *
 * - Auto-dismiss after 5s; the user can dismiss earlier by clicking the
 *   close button or by hovering and pressing Escape (Radix handles the
 *   keyboard interactions).
 * - Tones: 'success' | 'error' | 'info' (default 'info').
 * - Up to 4 toasts are visible at once; new toasts evict the oldest.
 */

import * as ToastPrimitive from '@radix-ui/react-toast';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastInput {
  title?: string;
  description?: string;
  tone?: ToastTone;
  durationMs?: number;
}

interface ToastEntry extends ToastInput {
  id: string;
}

interface ToastContextValue {
  show: (input: ToastInput) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const MAX_VISIBLE = 4;

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Don't crash a page that's still wired to the old setMsg pattern;
    // give a no-op so migration can be incremental.
    return { show: () => {} };
  }
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  const show = useCallback((input: ToastInput) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((prev) => {
      const next = [...prev, { id, ...input }];
      return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
    });
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      <ToastPrimitive.Provider swipeDirection="right" duration={5000}>
        {children}
        {toasts.map((t) => (
          <ToastPrimitive.Root
            key={t.id}
            duration={t.durationMs ?? 5000}
            onOpenChange={(open) => {
              if (!open) dismiss(t.id);
            }}
            className={[
              'mb-2 grid grid-cols-[1fr_auto] gap-3 items-start',
              'rounded-lg px-4 py-3 shadow-lg border',
              'bg-[var(--card)] text-[var(--foreground)]',
              t.tone === 'success'
                ? 'border-[var(--success-border,_#22c55e)]'
                : t.tone === 'error'
                  ? 'border-[var(--destructive-border,_#ef4444)]'
                  : 'border-[var(--border)]',
              'data-[state=open]:animate-in data-[state=open]:fade-in',
              'data-[state=closed]:animate-out data-[state=closed]:fade-out',
            ].join(' ')}
          >
            <div className="min-w-0">
              {t.title ? (
                <ToastPrimitive.Title className="text-sm font-semibold mb-0.5">
                  {t.title}
                </ToastPrimitive.Title>
              ) : null}
              {t.description ? (
                <ToastPrimitive.Description className="text-sm text-[var(--muted-foreground)] break-words">
                  {t.description}
                </ToastPrimitive.Description>
              ) : null}
            </div>
            <ToastPrimitive.Close
              aria-label="Dismiss"
              className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] text-lg leading-none"
            >
              ×
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport className="fixed bottom-4 right-4 z-50 flex w-[360px] max-w-[calc(100vw-2rem)] flex-col" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}
