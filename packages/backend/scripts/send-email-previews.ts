/**
 * Render every email the backend sends, with sample data, to look at them.
 *
 *   npx ts-node scripts/send-email-previews.ts --out /tmp/email-previews
 *   npx ts-node scripts/send-email-previews.ts --to someone@helpcode.ai
 *
 * --out <dir>         write <id>.html and <id>.txt for every email and variant
 * --to <address>      send them all through the SMTP in SMTP_HOST/PORT/USER/PASS/FROM,
 *                     subjects prefixed "[Preview]". Only @helpcode.ai addresses.
 * --self-hosted       render the self-hosted variant (no Cloud-only claims)
 * --stats-url <url>   take the trust numbers from a /api/public/stats endpoint
 *                     instead of the sample ones
 * --asset-base <url>  where the logo PNGs are (default https://anythingmcp.com/email),
 *                     e.g. a local folder for offline previews
 */
import * as fs from 'fs';
import * as path from 'path';
import * as nodemailer from 'nodemailer';
import { EMAIL_SAMPLES, SAMPLE_TRUST_STATS } from '../src/settings/email-samples';
import { formatTrustStats, type TrustStats } from '../src/public-stats/trust-stats.format';
import type { EmailBrandContext } from '../src/settings/email-layout';

const ALLOWED_DOMAIN = 'helpcode.ai';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function loadStats(url?: string): Promise<TrustStats> {
  if (!url) return SAMPLE_TRUST_STATS;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return (await res.json()) as TrustStats;
}

async function main() {
  const out = arg('out');
  const to = arg('to');
  if (!out && !to) {
    console.error('Usage: send-email-previews.ts --out <dir> | --to <name@helpcode.ai> [--self-hosted] [--stats-url <url>] [--asset-base <url>]');
    process.exit(2);
  }
  if (to && !new RegExp(`^[^@\\s]+@${ALLOWED_DOMAIN.replace('.', '\\.')}$`, 'i').test(to)) {
    console.error(`Refusing to send previews to ${to}: only @${ALLOWED_DOMAIN} addresses.`);
    process.exit(2);
  }

  const ctx: EmailBrandContext = {
    stats: formatTrustStats(await loadStats(arg('stats-url'))),
    cloud: !flag('self-hosted'),
    ...(arg('asset-base') ? { assetBase: arg('asset-base') } : {}),
  };
  const names = { name: 'Anna', other: 'Editor' };
  const rendered = EMAIL_SAMPLES.map((s) => ({
    id: s.id,
    email: s.render(ctx, s.id === 'onboarding-client-connected' ? { name: 'Anna', other: 'Claude' } : names),
  }));

  if (out) {
    fs.mkdirSync(out, { recursive: true });
    for (const { id, email } of rendered) {
      fs.writeFileSync(path.join(out, `${id}.html`), email.html);
      fs.writeFileSync(path.join(out, `${id}.txt`), `Subject: ${email.subject}\n\n${email.text}`);
      console.log(`${id.padEnd(30)} ${(Buffer.byteLength(email.html) / 1024).toFixed(1)} KB  ${email.subject}`);
    }
    console.log(`\n${rendered.length} emails written to ${out}`);
  }

  if (to) {
    const host = process.env.SMTP_HOST;
    if (!host) {
      console.error('SMTP_HOST is not set.');
      process.exit(2);
    }
    const port = Number(process.env.SMTP_PORT) || 587;
    const transport = nodemailer.createTransport({
      host,
      port,
      secure: process.env.SMTP_SECURE === 'true' || port === 465,
      auth: { user: process.env.SMTP_USER || '', pass: process.env.SMTP_PASS || '' },
      connectionTimeout: 10_000,
    });
    const from = process.env.SMTP_FROM || `AnythingMCP <${process.env.SMTP_USER}>`;
    for (const { id, email } of rendered) {
      await transport.sendMail({ from, to, subject: `[Preview] ${email.subject}`, html: email.html, text: email.text });
      console.log(`sent ${id}`);
    }
    console.log(`\n${rendered.length} previews sent to ${to}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
