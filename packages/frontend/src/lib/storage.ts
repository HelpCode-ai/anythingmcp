/**
 * Web storage that never throws.
 *
 * Some Android WebViews expose `window.localStorage` as null (DOM storage
 * disabled by the host app), and Safari in some privacy modes throws on
 * access. Calling it directly crashed the whole app on mount (Sentry
 * CLOUD-FRONTEND-6, 2026-09-26). Without storage, values live in memory for
 * the tab: signing in still works, it just does not survive a reload.
 */
function safe(kind: 'localStorage' | 'sessionStorage') {
  const memory = new Map<string, string>();
  const store = (): Storage | null => {
    try {
      const s = window[kind];
      // Touch it: a disabled storage can exist and still throw on use.
      s?.getItem('');
      return s ?? null;
    } catch {
      return null;
    }
  };
  return {
    get(key: string): string | null {
      try {
        const s = store();
        if (s) return s.getItem(key);
      } catch {}
      return memory.get(key) ?? null;
    },
    set(key: string, value: string): void {
      memory.set(key, value);
      try {
        store()?.setItem(key, value);
      } catch {}
    },
    remove(key: string): void {
      memory.delete(key);
      try {
        store()?.removeItem(key);
      } catch {}
    },
  };
}

export const storage = safe('localStorage');
export const sessionStore = safe('sessionStorage');
