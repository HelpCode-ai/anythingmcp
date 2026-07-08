import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';

const geistSans = Geist({
  subsets: ['latin'],
  variable: '--font-geist-sans',
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});
const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
  weight: ['400', '500'],
  display: 'swap',
});
import { LicenseWall } from '@/components/license-wall';
import { GoogleTagManager, GoogleTagManagerNoscript } from '@/components/google-tag-manager';
import { CookieConsentBanner } from '@/components/cookie-consent';

export const metadata: Metadata = {
  title: 'AnythingMCP — Custom connectors for Claude, ChatGPT, Copilot & any AI agent',
  description:
    'Create custom connectors for Claude, ChatGPT, Copilot and any AI agent. Turn any REST, SOAP, GraphQL or SQL system into AI tools — no code.',
  icons: { icon: '/icon.svg', apple: '/apple-icon.svg' },
};

// process.env.GTM_ID is read by GoogleTagManager() during the layout
// render. Without `force-dynamic`, Next.js prerenders the layout at
// build time and bakes in whatever the env was during `next build` —
// which is empty in CI, so cloud builds would never get GTM. Forcing
// dynamic keeps a single Docker image working for both flavors:
// the runtime env on the cloud droplet enables GTM, and self-hosted
// containers leave it empty and ship nothing.
export const dynamic = 'force-dynamic';

// Inline script to prevent FOUC — runs before React hydrates
const themeScript = `(function(){try{var t=localStorage.getItem('theme');var d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme:dark)').matches);if(d)document.documentElement.classList.add('dark')}catch(e){}})()`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const gtmEnabled = Boolean(process.env.GTM_ID);
  const cookieDomain = process.env.COOKIE_DOMAIN;

  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <GoogleTagManager />
      </head>
      <body>
        <GoogleTagManagerNoscript />
        <Providers>
          <LicenseWall />
          {children}
        </Providers>
        {gtmEnabled && <CookieConsentBanner cookieDomain={cookieDomain} />}
      </body>
    </html>
  );
}
