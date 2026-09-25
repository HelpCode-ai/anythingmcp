'use client';

import { useEffect, useState } from 'react';

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Throws during render once the fragment matches, so error.tsx reports it. */
export function ClientTrigger({ tokenSha256 }: { tokenSha256: string }) {
  const [boom, setBoom] = useState(false);
  useEffect(() => {
    const fragment = window.location.hash.slice(1);
    if (!fragment) return;
    void sha256Hex(fragment).then((h) => {
      if (h === tokenSha256) setBoom(true);
    });
  }, [tokenSha256]);
  if (boom) throw new Error('Sentry verification (frontend browser)');
  return null;
}
