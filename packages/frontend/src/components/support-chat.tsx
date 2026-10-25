'use client';

import { useEffect, useRef } from 'react';
import { useAuth } from '@/lib/auth-context';
import { support } from '@/lib/api';

interface LibredeskInstance {
  setUser?: (jwt: string) => void;
  logout?: () => void;
  destroy?: () => void;
  showChat?: () => void;
}

declare global {
  interface Window {
    LibredeskSettings?: Record<string, unknown>;
    Libredesk?: LibredeskInstance;
  }
}

const SCRIPT_ID = 'libredesk-widget';

/**
 * Opens the support chat, for a "Stuck? Ask us" link. False when there is no
 * chat on this instance (self-hosted) or it has not loaded yet.
 */
export function openSupportChat(): boolean {
  if (typeof window === 'undefined' || typeof window.Libredesk?.showChat !== 'function') return false;
  window.Libredesk.showChat();
  return true;
}

/**
 * Live support chat for signed-in users. The backend answers 404 unless this
 * instance is one we operate (Cloud or a dedicated enterprise instance), so
 * self-hosted installations never load anything.
 */
export function SupportChat() {
  const { token } = useAuth();
  const loaded = useRef(false);

  useEffect(() => {
    if (!token) {
      if (loaded.current) {
        window.Libredesk?.logout?.();
        window.Libredesk?.destroy?.();
        document.getElementById(SCRIPT_ID)?.remove();
        delete window.LibredeskSettings;
        loaded.current = false;
      }
      return;
    }

    let cancelled = false;
    support
      .widget(token)
      .then(({ baseUrl, inboxId, userJwt }) => {
        if (cancelled) return;
        if (loaded.current) {
          // Workspace switch or a new session: refresh the verified identity.
          window.Libredesk?.setUser?.(userJwt);
          return;
        }
        window.LibredeskSettings = { baseURL: baseUrl, inboxID: inboxId, userJWT: userJwt };
        const script = document.createElement('script');
        script.id = SCRIPT_ID;
        script.async = true;
        script.src = `${baseUrl}/widget.js`;
        document.body.appendChild(script);
        loaded.current = true;
      })
      .catch(() => {
        // Not configured on this instance, or the desk is unreachable.
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return null;
}
