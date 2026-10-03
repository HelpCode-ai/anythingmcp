import type { Metadata } from 'next';

// The URL carries an authorization code until the page strips it: never send
// it on as a Referer.
export const metadata: Metadata = { referrer: 'no-referrer' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
