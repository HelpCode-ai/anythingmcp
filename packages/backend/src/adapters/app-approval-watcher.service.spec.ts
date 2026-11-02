import { AppApprovalWatcherService } from './app-approval-watcher.service';
import { encrypt } from '../common/crypto/encryption.util';
import { getAdapter } from './catalog';
import { appApprovedEmail } from '../settings/email-templates';
import { EMPTY_TRUST_STATS, formatTrustStats } from '../public-stats/trust-stats.format';

const KEY = 'k'.repeat(32);
const H = 60 * 60 * 1000;
const now = new Date('2026-11-02T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

type Row = {
  id: string;
  userId: string;
  organizationId: string;
  createdAt: Date;
  baseUrl: string;
  authType: string;
  authConfig: string | null;
  envVars: unknown;
  config: any;
  credentialScope: string;
};

function etsyRow(over: Partial<Row> = {}): Row {
  const etsy = getAdapter('etsy')!;
  return {
    id: 'c1',
    userId: 'u1',
    organizationId: 'o1',
    createdAt: ago(2 * H),
    baseUrl: etsy.connector.baseUrl,
    authType: 'OAUTH2',
    authConfig: encrypt(JSON.stringify(etsy.connector.authConfig), KEY),
    envVars: { ETSY_CLIENT_ID: 'abcdefghijklmnopqrstuvwx', ETSY_CLIENT_SECRET: 'secret1234' },
    config: { adapterSlug: 'etsy' },
    credentialScope: 'SHARED',
    ...over,
  };
}

/**
 * The service against an in-memory connectors table: $executeRaw applies the
 * JSON merge of writeWatch, and the claim only while no notifiedAt is set,
 * the same as the SQL.
 */
function build(opts: {
  rows: Row[];
  events?: any[];
  answer?: 'accepted' | 'refused' | 'unknown';
  emailSent?: boolean;
  noEmailService?: boolean;
}) {
  process.env.ENCRYPTION_KEY = KEY;
  const rows = opts.rows;
  const loggedEvents: any[] = [...(opts.events ?? [])];
  const prisma: any = {
    connector: {
      findMany: jest.fn(async () => rows.map((r) => ({ ...r, config: JSON.parse(JSON.stringify(r.config)) }))),
    },
    productEvent: {
      findMany: jest.fn(async () => loggedEvents),
      findFirst: jest.fn(async ({ where }: any) =>
        loggedEvents.find((e) => e.event === where.event && e.metadata?.connectorId === where.metadata.equals) ?? null,
      ),
    },
    user: { findUnique: jest.fn(async () => ({ email: 'owner@example.com', name: 'Ada' })) },
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, json: string, id: string) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return 0;
      const claim = strings.join('?').includes("->>'notifiedAt') IS NULL");
      const watch = row.config.appApprovalWatch ?? {};
      if (claim && watch.notifiedAt) return 0;
      row.config = { ...row.config, appApprovalWatch: { ...watch, ...JSON.parse(json) } };
      return 1;
    }),
  };
  const adapters: any = { recheckAppKeys: jest.fn(async () => opts.answer ?? 'refused') };
  const productEvents: any = {
    log: jest.fn(async (e: any) => {
      loggedEvents.push({ ...e, createdAt: now });
    }),
  };
  const email: any = { sendAppApprovedEmail: jest.fn(async () => opts.emailSent ?? true) };
  const service = new AppApprovalWatcherService(prisma, adapters, productEvents, opts.noEmailService ? undefined : email);
  return { service, prisma, adapters, productEvents, email, rows, loggedEvents };
}

const logged = (productEvents: any, event: string) =>
  productEvents.log.mock.calls.map((c: any[]) => c[0]).filter((e: any) => e.event === event);

describe('AppApprovalWatcherService', () => {
  describe('selection', () => {
    it('reads only recent OAuth2 connectors of watched adapters', async () => {
      const { service, prisma } = build({ rows: [] });
      await service.sweep(now);
      const where = prisma.connector.findMany.mock.calls[0][0].where;
      expect(where.authType).toBe('OAUTH2');
      expect(where.createdAt.gte).toEqual(new Date(now.getTime() - 14 * 24 * H));
      expect(where.OR).toEqual([{ config: { path: ['adapterSlug'], equals: 'etsy' } }]);
    });

    it('re-checks the stored keys of a connector still waiting for the sign-in', async () => {
      const { service, adapters } = build({ rows: [etsyRow()] });
      await service.sweep(now);
      expect(adapters.recheckAppKeys).toHaveBeenCalledWith('etsy', 'https://openapi.etsy.com/v3/application', {
        ETSY_CLIENT_ID: 'abcdefghijklmnopqrstuvwx',
        ETSY_CLIENT_SECRET: 'secret1234',
      });
    });

    it('leaves alone a connector already signed in, and stops watching it', async () => {
      const row = etsyRow({ envVars: { ETSY_CLIENT_ID: 'abcdefghijklmnopqrstuvwx', ETSY_CLIENT_SECRET: 's1234567', ETSY_REFRESH_TOKEN: 'rt-1' } });
      const { service, adapters, rows } = build({ rows: [row] });
      await service.sweep(now);
      expect(adapters.recheckAppKeys).not.toHaveBeenCalled();
      expect(rows[0].config.appApprovalWatch.doneAt).toBe(now.toISOString());
    });

    it('skips a connector without keys, a per-user connector, and one created over 14 days ago', async () => {
      const { service, adapters } = build({
        rows: [
          etsyRow({ id: 'nokeys', envVars: {} }),
          etsyRow({ id: 'user', credentialScope: 'USER' }),
          etsyRow({ id: 'old', createdAt: ago(15 * 24 * H) }),
        ],
      });
      await service.sweep(now);
      expect(adapters.recheckAppKeys).not.toHaveBeenCalled();
    });

    it('skips a connector checked less than an hour ago', async () => {
      const row = etsyRow({
        config: { adapterSlug: 'etsy', appApprovalWatch: { pendingSince: ago(2 * H).toISOString(), lastCheckedAt: ago(20 * 60 * 1000).toISOString() } },
      });
      const { service, adapters } = build({ rows: [row] });
      expect(await service.sweep(now)).toEqual({ checked: 0, notified: 0 });
      expect(adapters.recheckAppKeys).not.toHaveBeenCalled();
    });
  });

  describe('while the provider refuses the keys', () => {
    it('records when they were first refused and when they were checked, and logs it once', async () => {
      const { service, rows, productEvents, email } = build({ rows: [etsyRow()], answer: 'refused' });
      await service.sweep(now);
      expect(rows[0].config.appApprovalWatch).toEqual({
        pendingSince: now.toISOString(),
        lastCheckedAt: now.toISOString(),
      });
      expect(rows[0].config.adapterSlug).toBe('etsy');
      expect(logged(productEvents, 'etsy_app_pending_seen')).toEqual([
        expect.objectContaining({ metadata: { adapterSlug: 'etsy', via: 'watcher', connectorId: 'c1' } }),
      ]);
      // An hour later: checked again, pendingSince kept, no second event.
      const later = new Date(now.getTime() + H);
      await service.sweep(later);
      expect(rows[0].config.appApprovalWatch.pendingSince).toBe(now.toISOString());
      expect(rows[0].config.appApprovalWatch.lastCheckedAt).toBe(later.toISOString());
      expect(logged(productEvents, 'etsy_app_pending_seen')).toHaveLength(1);
      expect(email.sendAppApprovedEmail).not.toHaveBeenCalled();
    });

    it('dates the refusal from the setup check when there was one', async () => {
      const setupCheck = {
        event: 'etsy_app_pending_seen',
        organizationId: 'o1',
        createdAt: ago(3 * H),
        metadata: { adapterSlug: 'etsy', via: 'setup' },
      };
      const { service, rows } = build({ rows: [etsyRow()], events: [setupCheck], answer: 'refused' });
      await service.sweep(now);
      expect(rows[0].config.appApprovalWatch.pendingSince).toBe(ago(3 * H).toISOString());
    });
  });

  describe('when the provider accepts the keys', () => {
    const pending = () =>
      etsyRow({ config: { adapterSlug: 'etsy', appApprovalWatch: { pendingSince: ago(30 * H).toISOString(), lastCheckedAt: ago(7 * H).toISOString() } } });

    it('emails the connector owner once, with the connector page and the first request', async () => {
      const { service, email, rows, productEvents } = build({ rows: [pending()], answer: 'accepted' });
      expect(await service.sweep(now)).toEqual({ checked: 1, notified: 1 });
      expect(email.sendAppApprovedEmail).toHaveBeenCalledTimes(1);
      expect(email.sendAppApprovedEmail).toHaveBeenCalledWith(
        'owner@example.com',
        {
          name: 'Ada',
          providerName: 'Etsy',
          connectorPath: '/connectors/c1',
          prompt: 'Show my last 10 Etsy orders',
          promptUrl: 'https://claude.ai/new?q=Show%20my%20last%2010%20Etsy%20orders',
        },
        'o1',
      );
      expect(rows[0].config.appApprovalWatch).toEqual(
        expect.objectContaining({ approvedAt: now.toISOString(), notifiedAt: now.toISOString() }),
      );
      expect(logged(productEvents, 'etsy_app_approved_notified')).toEqual([
        expect.objectContaining({ organizationId: 'o1', metadata: { connectorId: 'c1', adapterSlug: 'etsy', kind: 'emailed' } }),
      ]);
    });

    it('never sends a second email: not on the next sweep, not after a restart', async () => {
      const first = build({ rows: [pending()], answer: 'accepted' });
      await first.service.sweep(now);
      await first.service.sweep(new Date(now.getTime() + 7 * H));
      expect(first.email.sendAppApprovedEmail).toHaveBeenCalledTimes(1);

      // A new process reading the same table.
      const restarted = build({ rows: first.rows, answer: 'accepted', events: first.loggedEvents });
      await restarted.service.sweep(new Date(now.getTime() + 14 * H));
      expect(restarted.email.sendAppApprovedEmail).not.toHaveBeenCalled();
    });

    it('sends one email when two processes sweep at the same time', async () => {
      const rows = [pending()];
      const a = build({ rows, answer: 'accepted' });
      const b = build({ rows, answer: 'accepted' });
      await Promise.all([a.service.sweep(now), b.service.sweep(now)]);
      expect(a.email.sendAppApprovedEmail.mock.calls.length + b.email.sendAppApprovedEmail.mock.calls.length).toBe(1);
    });

    it('does not send when an earlier email was recorded but the config lost the watch', async () => {
      const notified = {
        event: 'etsy_app_approved_notified',
        organizationId: 'o1',
        createdAt: ago(H),
        metadata: { connectorId: 'c1', adapterSlug: 'etsy', kind: 'emailed' },
      };
      const { service, email } = build({ rows: [pending()], answer: 'accepted', events: [notified] });
      await service.sweep(now);
      expect(email.sendAppApprovedEmail).not.toHaveBeenCalled();
    });

    it('announces nothing when the keys were never seen refused', async () => {
      const { service, email, rows } = build({ rows: [etsyRow()], answer: 'accepted' });
      await service.sweep(now);
      expect(email.sendAppApprovedEmail).not.toHaveBeenCalled();
      expect(rows[0].config.appApprovalWatch.notPending).toBe(now.toISOString());
    });

    it('without SMTP: no email, the outcome logged, and no retry', async () => {
      const { service, rows, productEvents, email } = build({ rows: [pending()], answer: 'accepted', emailSent: false });
      await service.sweep(now);
      expect(logged(productEvents, 'etsy_app_approved_notified')[0].metadata.kind).toBe('not_sent');
      await service.sweep(new Date(now.getTime() + 7 * H));
      expect(email.sendAppApprovedEmail).toHaveBeenCalledTimes(1);
      expect(rows[0].config.appApprovalWatch.notifiedAt).toBe(now.toISOString());
    });

    it('a provider that does not answer changes nothing but the check time', async () => {
      const { service, rows, email } = build({ rows: [pending()], answer: 'unknown' });
      await service.sweep(now);
      expect(email.sendAppApprovedEmail).not.toHaveBeenCalled();
      expect(rows[0].config.appApprovalWatch.lastCheckedAt).toBe(now.toISOString());
      expect(rows[0].config.appApprovalWatch.approvedAt).toBeUndefined();
    });
  });

  describe('the email', () => {
    const email = appApprovedEmail(
      {
        name: 'Ada',
        providerName: 'Etsy',
        connectorUrl: 'https://cloud.anythingmcp.com/connectors/c1',
        prompt: 'Show my last 10 Etsy orders',
        promptUrl: 'https://claude.ai/new?q=Show%20my%20last%2010%20Etsy%20orders',
      },
      { stats: formatTrustStats(EMPTY_TRUST_STATS), cloud: true },
    );

    it('says Etsy approved the app, with one button to the connector page', () => {
      expect(email.subject).toBe('Etsy approved your app');
      expect(email.marketing).toBe(false);
      expect(email.html).toContain('href="https://cloud.anythingmcp.com/connectors/c1"');
      expect(email.html).toContain('Finish the Etsy sign-in');
      expect(email.html.match(/<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 14px 0;">/g)).toHaveLength(1);
      expect(email.text).toContain('Finish the Etsy sign-in: https://cloud.anythingmcp.com/connectors/c1');
    });

    it('ends with the request to try in Claude, as a claude.ai/new link', () => {
      expect(email.html).toContain('href="https://claude.ai/new?q=Show%20my%20last%2010%20Etsy%20orders"');
      expect(email.html).toContain('Then ask Claude:');
      expect(email.text).toContain('Then ask Claude: "Show my last 10 Etsy orders" https://claude.ai/new?q=Show%20my%20last%2010%20Etsy%20orders');
      expect(email.text).toContain('This is the only email about it.');
    });
  });
});
