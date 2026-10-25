import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import './globals.css';
import { Providers } from './providers';

// Geist and Geist Mono are committed under src/fonts/geist (the variable
// woff2 files of the vercel/geist-font v1.8.1 release, SIL OFL 1.1), so
// `next build` never has to reach Google Fonts. The local loader names the
// font-family after the constant, so `Geist` keeps the family name the app
// had before; the mono face becomes `GeistMono`, as a constant cannot hold a
// space. The upstream files carry more glyphs than Google's subsets (arrows,
// for one), so unicode-range is the union of the subsets Google served:
// characters outside it keep falling back to the system font as before.
const Geist = localFont({
  src: '../fonts/geist/Geist-Variable.woff2',
  variable: '--font-geist-sans',
  weight: '400 700',
  style: 'normal',
  display: 'swap',
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+0000-02CC, U+02CE-02D7, U+02DA, U+02DC-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+0400-052F, U+1C80-1C8A, U+1D00-1DBF, U+1E00-1EFF, U+2000-206F, U+20A0-20C4, U+2113, U+2116, U+2122, U+2191, U+2193, U+2212, U+2215, U+2C60-2C7F, U+2DE0-2DFF, U+A640-A69F, U+A720-A7FF, U+FE2E-FE2F, U+FEFF, U+FFFD',
    },
  ],
});
const GeistMono = localFont({
  src: '../fonts/geist/GeistMono-Variable.woff2',
  variable: '--font-geist-mono',
  weight: '400 500',
  style: 'normal',
  display: 'swap',
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+0000-02CC, U+02CE-02D7, U+02DA, U+02DC-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+0400-052F, U+1C80-1C8A, U+1D00-1DBF, U+1E00-1EFF, U+2000-206F, U+20A0-20C4, U+2113, U+2116, U+2122, U+2191, U+2193, U+2212, U+2215, U+23B8-23BD, U+2500-259F, U+2C60-2C7F, U+2DE0-2DFF, U+A640-A69F, U+A720-A7FF, U+FE2E-FE2F, U+FEFF, U+FFFD',
    },
  ],
});
import { LicenseWall } from '@/components/license-wall';
import { GoogleTagManager, GoogleTagManagerNoscript } from '@/components/google-tag-manager';
import { CookieConsentBanner } from '@/components/cookie-consent';
import { SentryConfig } from '@/components/sentry-config';
import { TRANSLATION_SAFE_DOM_SCRIPT } from '@/lib/translation-safe-dom';

export const metadata: Metadata = {
  title: 'AnythingMCP — Custom connectors for Claude, ChatGPT, Copilot & any AI agent',
  description:
    'Create custom connectors for Claude, ChatGPT, Copilot, Meta Muse and any AI agent. Turn any REST, SOAP, GraphQL or SQL system into AI tools — no code.',
  // favicon.ico lives in src/app (Next serves it at /favicon.ico); it used
  // to be an empty file in public/, which is what anything asking for
  // "the site's icon" without parsing HTML — directory crawlers, chat
  // clients — got back. The PNGs exist for the same audience.
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon-192.png', type: 'image/png', sizes: '192x192' },
      { url: '/icon-512.png', type: 'image/png', sizes: '512x512' },
    ],
    apple: '/apple-icon.svg',
  },
};

// No maximumScale: clamping it fails WCAG 1.4.4 and blocks pinch-zoom on
// the browsers that still honour it. The iOS auto-zoom-on-focus that used
// to widen the layout is fixed at its source in globals.css, by giving
// form controls the 16px text iOS asks for.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
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
    <html lang="en" className={`${Geist.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: TRANSLATION_SAFE_DOM_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <SentryConfig />
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
