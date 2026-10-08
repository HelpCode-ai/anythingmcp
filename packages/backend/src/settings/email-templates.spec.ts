import { EMAIL_SAMPLES, MARKETING_SAMPLE_IDS, SAMPLE_TRUST_STATS } from './email-samples';
import { formatTrustStats, EMPTY_TRUST_STATS } from '../public-stats/trust-stats.format';
import type { EmailBrandContext } from './email-layout';

/**
 * Every email the backend sends, rendered with sample data: what reaches an
 * inbox must be complete, safe and deliverable.
 */

const HOSTILE = '<img src=x onerror="alert(1)">';
const HOSTILE_OTHER = '"><script>alert(2)</script>';

const ALLOWED_HOSTS = new Set([
  'anythingmcp.com',
  'cloud.anythingmcp.com',
  'github.com',
  'claude.ai',
]);

const cloud: EmailBrandContext = { stats: formatTrustStats(SAMPLE_TRUST_STATS), cloud: true };
const selfHosted: EmailBrandContext = { stats: formatTrustStats(SAMPLE_TRUST_STATS), cloud: false };
const noStats: EmailBrandContext = { stats: formatTrustStats(EMPTY_TRUST_STATS), cloud: true };

function urlsIn(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/\b(?:href|src)="([^"]*)"/g)) out.push(m[1].replace(/&amp;/g, '&'));
  return out;
}

function textUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s)]+/g)].map((m) => m[0]);
}

describe.each([
  ['cloud', cloud],
  ['self-hosted', selfHosted],
  ['without trust numbers', noStats],
])('emails (%s)', (_label, ctx) => {
  describe.each(EMAIL_SAMPLES.map((s) => [s.id, s] as const))('%s', (id, sample) => {
    const email = sample.render(ctx, { name: HOSTILE, other: HOSTILE_OTHER });

    it('has a subject, an HTML part and a text part', () => {
      expect(email.subject.trim().length).toBeGreaterThan(5);
      expect(email.html).toContain('<!doctype html>');
      expect(email.text.trim().length).toBeGreaterThan(80);
      // The text part carries the same call to action as the HTML.
      const htmlTargets = urlsIn(email.html).filter((u) => u.startsWith('https://cloud.') || u.includes('/pricing'));
      for (const target of htmlTargets) {
        expect(email.text).toContain(target);
      }
    });

    it('leaves no placeholder or broken value behind', () => {
      for (const part of [email.subject, email.html, email.text]) {
        expect(part).not.toMatch(/\{\{|\}\}|\bundefined\b|\bNaN\b|\[object Object\]|\bnull\b/);
      }
    });

    it('names no customer in the footer', () => {
      expect(email.html).not.toContain('KOCH');
      expect(email.text).not.toContain('KOCH');
    });

    it('sells the product, not the price: no card, charge or price talk', () => {
      // The win-back offers are about a discount by design.
      if (id.startsWith('winback-discount')) return;
      expect(`${email.subject}\n${email.text}`).not.toMatch(/charged|payment method|your card|€\s?\d|\d\s?€/i);
    });

    it('escapes every user-supplied value', () => {
      expect(email.html).not.toContain('<img src=x');
      expect(email.html).not.toContain('<script>');
      expect(email.html).not.toMatch(/onerror="/);
      if (email.text.includes('onerror')) {
        // The text part is plain text: the value appears as typed, never as markup in HTML.
        expect(email.html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
      }
    });

    it('stays well under the 90 KB Gmail clipping limit', () => {
      expect(Buffer.byteLength(email.html)).toBeLessThan(90 * 1024);
    });

    it('links only to AnythingMCP, GitHub and Claude, over HTTPS', () => {
      const urls = [...urlsIn(email.html), ...textUrls(email.text)];
      expect(urls.length).toBeGreaterThan(3);
      for (const raw of urls) {
        const url = new URL(raw);
        expect(url.protocol).toBe('https:');
        expect(ALLOWED_HOSTS.has(url.hostname)).toBe(true);
      }
    });

    it('carries an unsubscribe line only when it is a marketing email', () => {
      const marketing = MARKETING_SAMPLE_IDS.has(id);
      expect(email.marketing).toBe(marketing);
      expect(email.html.includes('Unsubscribe from tips and offers')).toBe(marketing);
      expect(email.text.includes('Unsubscribe from tips and offers')).toBe(marketing);
    });

    it('has a preheader and every image has width, height and alt', () => {
      expect(email.html).toMatch(/<div style="display:none;[^"]*">[^<]{10,}/);
      for (const img of email.html.match(/<img [^>]*>/g) ?? []) {
        expect(img).toMatch(/ width="\d+"/);
        expect(img).toMatch(/ height="\d+"/);
        expect(img).toMatch(/ alt="/);
        expect(img).toMatch(/src="https:\/\/anythingmcp\.com\/email\/[a-z-]+\.png"/);
      }
    });

    it('uses no web fonts', () => {
      expect(email.html).not.toMatch(/fonts\.googleapis|@import|@font-face/);
    });

    it('makes Cloud-only claims only on Cloud', () => {
      const claims = /Frankfurt|DPA included|Claude Directory|workspaces on AnythingMCP Cloud|AI tool calls last month/;
      if (ctx.cloud) {
        expect(email.html).toMatch(/Frankfurt/);
      } else {
        expect(email.html).not.toMatch(claims);
        expect(email.text).not.toMatch(claims);
      }
    });
  });
});

describe('trust band', () => {
  const verify = EMAIL_SAMPLES.find((s) => s.id === 'verification')!;

  it('shows the numbers, never below their floors', () => {
    const html = verify.render(cloud, { name: 'A', other: 'B' }).html;
    expect(html).toContain('1,000+');
    expect(html).toContain('200,000+');
    expect(html).toContain('1M+');
    expect(html).toContain('3,800+');
  });

  it('shows the floors without live numbers, and no workspace count', () => {
    const html = verify.render(noStats, { name: 'A', other: 'B' }).html;
    expect(html).toContain('stars on GitHub');
    expect(html).toContain('200,000+');
    expect(html).not.toContain('workspaces on');
    expect(html).not.toMatch(/\b0\+/);
    // Badges and the client list stay.
    expect(html).toContain('AES-256-GCM');
    expect(html).toContain('Works with');
  });

  it('shows the user’s own usage in trial emails', () => {
    const trial = EMAIL_SAMPLES.find((s) => s.id === 'trial-warn3')!.render(cloud, { name: 'Anna', other: '' });
    expect(trial.html).toContain('148');
    expect(trial.html).toContain('successful tool calls');
    expect(trial.text).toContain('148 successful tool calls');
  });
});
