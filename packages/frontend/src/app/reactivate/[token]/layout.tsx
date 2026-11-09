import type { Metadata } from 'next';

// The URL is the credential of the link: keep it out of Referer headers and
// search engines.
export const metadata: Metadata = {
  title: 'Reactivate your workspace — AnythingMCP',
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
