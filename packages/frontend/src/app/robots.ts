import type { MetadataRoute } from 'next';

// /robots.txt answered 404. Nothing is blocked here: the pages carry their
// own `noindex` (app/layout.tsx), and a crawler has to be allowed to fetch a
// page to see it. There is no sitemap; the public pages live on the website.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: '*', allow: '/' } };
}
