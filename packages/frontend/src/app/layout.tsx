import type { Metadata } from 'next';
import './globals.css';
import { Providers } from './providers';
import { TrialBanner } from '@/components/trial-banner';
import { LicenseWall } from '@/components/license-wall';

export const metadata: Metadata = {
  title: 'Anything MCP',
  description: 'Convert any API into an MCP server',
  icons: { icon: '/icon.svg', apple: '/apple-icon.svg' },
};

// Inline script to prevent FOUC — runs before React hydrates
const themeScript = `(function(){try{var t=localStorage.getItem('theme');var d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme:dark)').matches);if(d)document.documentElement.classList.add('dark')}catch(e){}})()`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <Providers>
          <TrialBanner />
          <LicenseWall />
          {children}
        </Providers>
      </body>
    </html>
  );
}
