import Script from 'next/script';

// Mirrors the Consent Mode v2 + GTM setup on anythingmcp.com so both
// properties report into the same container and respect the same
// regional defaults. Activated only when GTM_ID is set at runtime —
// keeps community self-hosted builds free of any tracking.

const EEA_UK_CH = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO',
  'GB', 'CH',
];

export function GoogleTagManager() {
  const gtmId = process.env.GTM_ID;
  if (!gtmId) return null;

  const consentDefault = `
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('consent', 'default', {
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'denied',
      functionality_storage: 'denied',
      personalization_storage: 'denied',
      security_storage: 'granted',
      wait_for_update: 500,
      region: ${JSON.stringify(EEA_UK_CH)}
    });
    gtag('consent', 'default', {
      ad_storage: 'granted',
      ad_user_data: 'granted',
      ad_personalization: 'granted',
      analytics_storage: 'granted',
      functionality_storage: 'granted',
      personalization_storage: 'granted',
      security_storage: 'granted'
    });
  `;

  const gtmSnippet = `
    (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
    new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
    j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
    'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
    })(window,document,'script','dataLayer','${gtmId}');
  `;

  return (
    <>
      {/* beforeInteractive is required so Consent Mode defaults are set before GTM loads.
          The lint rule targets pages/_document.js but App Router supports this in root layout. */}
      {/* eslint-disable-next-line @next/next/no-before-interactive-script-outside-document */}
      <Script id="gtm-consent-default" strategy="beforeInteractive">
        {consentDefault}
      </Script>
      <Script id="gtm-script" strategy="afterInteractive">
        {gtmSnippet}
      </Script>
    </>
  );
}

export function GoogleTagManagerNoscript() {
  const gtmId = process.env.GTM_ID;
  if (!gtmId) return null;

  return (
    <noscript>
      <iframe
        src={`https://www.googletagmanager.com/ns.html?id=${gtmId}`}
        height="0"
        width="0"
        style={{ display: 'none', visibility: 'hidden' }}
      />
    </noscript>
  );
}
