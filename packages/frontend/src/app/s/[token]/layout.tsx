import type { Metadata } from 'next';

// The URL is a one-time credential until it is used: keep it out of Referer
// headers and search engines.
export const metadata: Metadata = { referrer: 'no-referrer', robots: { index: false, follow: false } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
