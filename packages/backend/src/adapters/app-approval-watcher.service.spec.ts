import { AppApprovalWatcherService } from './app-approval-watcher.service';
import { encrypt } from '../common/crypto/encryption.util';
import { getAdapter } from './catalog';
import { appApprovedEmail, appApprovedReminderEmail } from '../settings/email-templates';
import { EMPTY_TRUST_STATS, formatTrustStats } from '../public-stats/trust-stats.format';

const KEY = 'k'.repeat(32);
const H = 60 * 60 * 1000;
const D = 24 * H;
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
 * JSON merge of writeWatch, and a claim only while its date (notifiedAt,
 * remindedAt) is not set, the same as the SQL.
 */
function build(opts: {
  rows: Row[];
  events?: any[];
  answer?: 'accepted' | 'refused' | 'unknown';
  emailSent?: boolean;
  noEmailService?: boolean;
  owner?: { email: string; name: string | null; emailMarketingOptOut?: boolean } | null;
  /** What the trial extension answers; absent = no such service (as on a build without it). */
  trialExtension?: jest.Mock;
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
    user: {
      findUnique: jest.fn(async () =>
        opts.owner === undefined ? { email: 'owner@example.com', name: 'Ada', emailMarketingOptOut: false } : opts.owner,
      ),
    },
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, json: string, id: string) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return 0;
      const sql = strings.join('?');
      const watch = row.config.appApprovalWatch ?? {};
      if (sql.includes("->>'notifiedAt') IS NULL") && watch.notifiedAt) return 0;
      if (sql.includes("->>'remindedAt') IS NULL") && watch.remindedAt) return 0;
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
  const email: any = {
    sendAppApprovedEmail: jest.fn(async () => opts.emailSent ?? true),
    sendAppApprovedReminderEmail: jest.fn(async () => opts.emailSent ?? true),
  };
  const trialExtension: any = opts.trialExtension ? { extendIfTooLate: opts.trialExtension } : undefined;
  const service = new AppApprovalWatcherService(
    prisma,
    adapters,
    productEvents,
    opts.noEmailService ? undefined : email,
    trialExtension,
  );
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
      // 14 days of key checks, and three more for the reminder of a late approval.
      expect(where.createdAt.gte).toEqual(new Date(now.getTime() - 17 * 24 * H));
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
      expect(await service.sweep(now)).toEqual({ checked: 0, notified: 0, reminded: 0 });
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

    it('emails the connector owner once, with the link that starts the sign-in and the first request', async () => {
      const { service, email, rows, productEvents } = build({ rows: [pending()], answer: 'accepted' });
      expect(await service.sweep(now)).toEqual({ checked: 1, notified: 1, reminded: 0 });
      expect(email.sendAppApprovedEmail).toHaveBeenCalledTimes(1);
      expect(email.sendAppApprovedEmail).toHaveBeenCalledWith(
        'owner@example.com',
        {
          name: 'Ada',
          providerName: 'Etsy',
          connectorPath: '/connectors/c1?signin=1',
          prompt: 'Show my last 10 Etsy orders',
          promptUrl: 'https://claude.ai/new?q=Show%20my%20last%2010%20Etsy%20orders',
          reminderFollows: true,
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

  describe('extra trial days when the approval comes too late', () => {
    const pending = () =>
      etsyRow({ config: { adapterSlug: 'etsy', appApprovalWatch: { pendingSince: ago(30 * H).toISOString(), lastCheckedAt: ago(7 * H).toISOString() } } });

    it('asks for the extension before the email and tells the days in it', async () => {
      const trialExtension = jest.fn(async () => ({ daysAdded: 7, until: new Date(now.getTime() + 7 * D) }));
      const { service, email, productEvents } = build({ rows: [pending()], answer: 'accepted', trialExtension });
      await service.sweep(now);
      expect(trialExtension).toHaveBeenCalledTimes(1);
      expect(trialExtension).toHaveBeenCalledWith('o1', { connectorId: 'c1', adapterSlug: 'etsy' }, now);
      expect(email.sendAppApprovedEmail.mock.calls[0][1].trialDaysAdded).toBe(7);
      expect(trialExtension.mock.invocationCallOrder[0]).toBeLessThan(email.sendAppApprovedEmail.mock.invocationCallOrder[0]);
      expect(logged(productEvents, 'etsy_app_approved_notified')[0].metadata).toEqual({
        connectorId: 'c1',
        adapterSlug: 'etsy',
        kind: 'emailed',
        trialDaysAdded: 7,
      });
    });

    it('sends the email without the sentence when nothing was added', async () => {
      const trialExtension = jest.fn(async () => null);
      const { service, email, productEvents } = build({ rows: [pending()], answer: 'accepted', trialExtension });
      await service.sweep(now);
      expect(email.sendAppApprovedEmail).toHaveBeenCalledTimes(1);
      expect(email.sendAppApprovedEmail.mock.calls[0][1]).not.toHaveProperty('trialDaysAdded');
      expect(logged(productEvents, 'etsy_app_approved_notified')[0].metadata).toEqual({
        connectorId: 'c1',
        adapterSlug: 'etsy',
        kind: 'emailed',
      });
    });

    it('sends the email all the same when the extension fails', async () => {
      const trialExtension = jest.fn(async () => {
        throw new Error('licence site down');
      });
      const { service, email } = build({ rows: [pending()], answer: 'accepted', trialExtension });
      expect(await service.sweep(now)).toEqual({ checked: 1, notified: 1, reminded: 0 });
      expect(email.sendAppApprovedEmail).toHaveBeenCalledTimes(1);
      expect(email.sendAppApprovedEmail.mock.calls[0][1]).not.toHaveProperty('trialDaysAdded');
    });

    it('asks once per approval email: not on later sweeps, not for the reminder, not without an email to send', async () => {
      const trialExtension = jest.fn(async () => ({ daysAdded: 7, until: new Date(now.getTime() + 7 * D) }));
      const first = build({ rows: [pending()], answer: 'accepted', trialExtension });
      await first.service.sweep(now);
      await first.service.sweep(new Date(now.getTime() + 7 * H));
      await first.service.sweep(new Date(now.getTime() + 49 * H));
      expect(first.email.sendAppApprovedReminderEmail).toHaveBeenCalledTimes(1);
      expect(trialExtension).toHaveBeenCalledTimes(1);

      const noOwner = build({ rows: [pending()], answer: 'accepted', trialExtension: jest.fn(), owner: null });
      await noOwner.service.sweep(now);
      expect(noOwner.email.sendAppApprovedEmail).not.toHaveBeenCalled();
    });
  });

  describe('the reminder two days later', () => {
    const notifiedAt = now;
    const later = (ms: number) => new Date(notifiedAt.getTime() + ms);
    /** A connector whose approval email went out at `now` and that still waits for the sign-in. */
    const notified = (over: Partial<Row> = {}) =>
      etsyRow({
        createdAt: ago(3 * D),
        config: {
          adapterSlug: 'etsy',
          appApprovalWatch: {
            pendingSince: ago(2 * D).toISOString(),
            lastCheckedAt: notifiedAt.toISOString(),
            approvedAt: notifiedAt.toISOString(),
            notifiedAt: notifiedAt.toISOString(),
          },
        },
        ...over,
      });

    it('goes out once, 48 hours after the approval email, with the same link, and is counted', async () => {
      const { service, email, rows, productEvents, adapters } = build({ rows: [notified()] });
      expect(await service.sweep(later(47 * H))).toEqual({ checked: 0, notified: 0, reminded: 0 });
      expect(email.sendAppApprovedReminderEmail).not.toHaveBeenCalled();

      expect(await service.sweep(later(48 * H))).toEqual({ checked: 0, notified: 0, reminded: 1 });
      expect(email.sendAppApprovedReminderEmail).toHaveBeenCalledTimes(1);
      expect(email.sendAppApprovedReminderEmail).toHaveBeenCalledWith(
        'owner@example.com',
        {
          name: 'Ada',
          providerName: 'Etsy',
          connectorPath: '/connectors/c1?signin=1',
          prompt: 'Show my last 10 Etsy orders',
          promptUrl: 'https://claude.ai/new?q=Show%20my%20last%2010%20Etsy%20orders',
        },
        'o1',
      );
      expect(rows[0].config.appApprovalWatch.remindedAt).toBe(later(48 * H).toISOString());
      expect(logged(productEvents, 'etsy_app_approved_reminded')).toEqual([
        expect.objectContaining({
          userId: 'u1',
          organizationId: 'o1',
          metadata: { connectorId: 'c1', adapterSlug: 'etsy', kind: 'emailed' },
        }),
      ]);
      // No call to the provider and no second approval email for it.
      expect(adapters.recheckAppKeys).not.toHaveBeenCalled();
      expect(email.sendAppApprovedEmail).not.toHaveBeenCalled();
    });

    it('is never sent twice: not on later sweeps, not after a restart, not by two processes at once', async () => {
      const first = build({ rows: [notified()] });
      await first.service.sweep(later(48 * H));
      await first.service.sweep(later(49 * H));
      await first.service.sweep(later(60 * H));
      expect(first.email.sendAppApprovedReminderEmail).toHaveBeenCalledTimes(1);

      const restarted = build({ rows: first.rows, events: first.loggedEvents });
      await restarted.service.sweep(later(61 * H));
      expect(restarted.email.sendAppApprovedReminderEmail).not.toHaveBeenCalled();

      const rows = [notified()];
      const a = build({ rows });
      const b = build({ rows });
      await Promise.all([a.service.sweep(later(48 * H)), b.service.sweep(later(48 * H))]);
      expect(
        a.email.sendAppApprovedReminderEmail.mock.calls.length + b.email.sendAppApprovedReminderEmail.mock.calls.length,
      ).toBe(1);
    });

    it('does not send when an earlier reminder was recorded but the config lost its date', async () => {
      const reminded = {
        event: 'etsy_app_approved_reminded',
        organizationId: 'o1',
        createdAt: later(48 * H),
        metadata: { connectorId: 'c1', adapterSlug: 'etsy', kind: 'emailed' },
      };
      const { service, email } = build({ rows: [notified()], events: [reminded] });
      await service.sweep(later(50 * H));
      expect(email.sendAppApprovedReminderEmail).not.toHaveBeenCalled();
    });

    it('is not sent when the user signed in meanwhile, and the watch ends', async () => {
      const row = notified({
        envVars: { ETSY_CLIENT_ID: 'abcdefghijklmnopqrstuvwx', ETSY_CLIENT_SECRET: 's1234567', ETSY_REFRESH_TOKEN: 'rt-1' },
      });
      const { service, email, rows, productEvents } = build({ rows: [row] });
      expect(await service.sweep(later(48 * H))).toEqual({ checked: 0, notified: 0, reminded: 0 });
      expect(email.sendAppApprovedReminderEmail).not.toHaveBeenCalled();
      expect(rows[0].config.appApprovalWatch.doneAt).toBe(later(48 * H).toISOString());
      expect(rows[0].config.appApprovalWatch.remindedAt).toBeUndefined();
      expect(logged(productEvents, 'etsy_app_approved_reminded')).toEqual([]);
      // Nothing more on the following sweeps either.
      await service.sweep(later(50 * H));
      expect(email.sendAppApprovedReminderEmail).not.toHaveBeenCalled();
    });

    it('is not sent after its window: a day late it is dropped for good', async () => {
      const { service, email, rows } = build({ rows: [notified()] });
      // The server was down from before the reminder fell due until a day after.
      expect(await service.sweep(later(72 * H))).toEqual({ checked: 0, notified: 0, reminded: 0 });
      await service.sweep(later(10 * D));
      expect(email.sendAppApprovedReminderEmail).not.toHaveBeenCalled();
      expect(rows[0].config.appApprovalWatch.remindedAt).toBeUndefined();
    });

    it('still reaches an approval of the last watched day, when the key checks have stopped', async () => {
      // Created 13 days before the approval: the reminder falls due on day 15.
      const { service, email, adapters, prisma } = build({ rows: [notified({ createdAt: ago(13 * D) })] });
      expect(await service.sweep(later(48 * H))).toEqual({ checked: 0, notified: 0, reminded: 1 });
      expect(email.sendAppApprovedReminderEmail).toHaveBeenCalledTimes(1);
      expect(adapters.recheckAppKeys).not.toHaveBeenCalled();
      // And the sweep reads no connector older than 17 days: watching does not go on.
      const where = prisma.connector.findMany.mock.calls[0][0].where;
      expect(where.createdAt.gte).toEqual(new Date(later(48 * H).getTime() - 17 * D));
    });

    it('is withheld from an owner who opted out of tips and offers, and not looked at again', async () => {
      const { service, email, rows, productEvents } = build({
        rows: [notified()],
        owner: { email: 'owner@example.com', name: 'Ada', emailMarketingOptOut: true },
      });
      expect(await service.sweep(later(48 * H))).toEqual({ checked: 0, notified: 0, reminded: 0 });
      expect(email.sendAppApprovedReminderEmail).not.toHaveBeenCalled();
      expect(rows[0].config.appApprovalWatch.remindedAt).toBe(later(48 * H).toISOString());
      expect(logged(productEvents, 'etsy_app_approved_reminded')[0].metadata.kind).toBe('opted_out');
      await service.sweep(later(49 * H));
      expect(logged(productEvents, 'etsy_app_approved_reminded')).toHaveLength(1);
    });

    it('tells an owner who opted out, in the first email, that it is the only one', async () => {
      const pending = etsyRow({
        config: { adapterSlug: 'etsy', appApprovalWatch: { pendingSince: ago(30 * H).toISOString(), lastCheckedAt: ago(7 * H).toISOString() } },
      });
      const { service, email } = build({
        rows: [pending],
        answer: 'accepted',
        owner: { email: 'owner@example.com', name: 'Ada', emailMarketingOptOut: true },
      });
      await service.sweep(now);
      expect(email.sendAppApprovedEmail.mock.calls[0][1].reminderFollows).toBe(false);
    });

    it('without SMTP: no reminder, the outcome logged, and no retry', async () => {
      const { service, email, productEvents } = build({ rows: [notified()], emailSent: false });
      await service.sweep(later(48 * H));
      await service.sweep(later(49 * H));
      expect(email.sendAppApprovedReminderEmail).toHaveBeenCalledTimes(1);
      expect(logged(productEvents, 'etsy_app_approved_reminded').map((e: any) => e.metadata.kind)).toEqual(['not_sent']);
    });

    it('leaves alone a per-user connector and one whose keys were removed', async () => {
      const { service, email, rows } = build({
        rows: [notified({ id: 'user', credentialScope: 'USER' }), notified({ id: 'nokeys', envVars: {} })],
      });
      await service.sweep(later(48 * H));
      expect(email.sendAppApprovedReminderEmail).not.toHaveBeenCalled();
      expect(rows.every((r) => r.config.appApprovalWatch.remindedAt === undefined)).toBe(true);
    });

    it('follows the approval email of the same service, 48 hours on', async () => {
      const pending = etsyRow({
        config: { adapterSlug: 'etsy', appApprovalWatch: { pendingSince: ago(30 * H).toISOString(), lastCheckedAt: ago(7 * H).toISOString() } },
      });
      const { service, email } = build({ rows: [pending], answer: 'accepted' });
      await service.sweep(now);
      await service.sweep(later(24 * H));
      expect(email.sendAppApprovedReminderEmail).not.toHaveBeenCalled();
      expect(await service.sweep(later(48 * H))).toEqual({ checked: 0, notified: 0, reminded: 1 });
      expect(email.sendAppApprovedEmail).toHaveBeenCalledTimes(1);
      expect(email.sendAppApprovedReminderEmail).toHaveBeenCalledTimes(1);
    });
  });

  describe('the email', () => {
    const email = appApprovedEmail(
      {
        name: 'Ada',
        providerName: 'Etsy',
        connectorUrl: 'https://cloud.anythingmcp.com/connectors/c1?signin=1',
        prompt: 'Show my last 10 Etsy orders',
        promptUrl: 'https://claude.ai/new?q=Show%20my%20last%2010%20Etsy%20orders',
      },
      { stats: formatTrustStats(EMPTY_TRUST_STATS), cloud: true },
    );

    it('says Etsy approved the app, with one button that starts the sign-in', () => {
      expect(email.subject).toBe('Etsy approved your app');
      expect(email.marketing).toBe(false);
      expect(email.html).toContain('href="https://cloud.anythingmcp.com/connectors/c1?signin=1"');
      expect(email.html).toContain('Finish the Etsy sign-in');
      expect(email.html).toContain('The button below starts the Etsy sign-in');
      expect(email.html.match(/<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 14px 0;">/g)).toHaveLength(1);
      expect(email.text).toContain('Finish the Etsy sign-in: https://cloud.anythingmcp.com/connectors/c1?signin=1');
    });

    it('ends with the request to try in Claude, as a claude.ai/new link', () => {
      expect(email.html).toContain('href="https://claude.ai/new?q=Show%20my%20last%2010%20Etsy%20orders"');
      expect(email.html).toContain('Then ask Claude:');
      expect(email.text).toContain('Then ask Claude: "Show my last 10 Etsy orders" https://claude.ai/new?q=Show%20my%20last%2010%20Etsy%20orders');
    });

    it('no longer says it is the only email: it announces the one reminder', () => {
      for (const part of [email.html, email.text]) {
        expect(part).not.toContain('only email');
        expect(part).toContain(
          'If the sign-in is still open in two days, we remind you once; after that we send nothing more about it.',
        );
      }
    });

    it('says it is the only email to a reader who gets no reminder', () => {
      const optedOut = appApprovedEmail(
        { name: 'Ada', providerName: 'Etsy', connectorUrl: 'https://cloud.anythingmcp.com/connectors/c1?signin=1', prompt: 'p', promptUrl: 'https://claude.ai/new?q=p', reminderFollows: false },
        { stats: formatTrustStats(EMPTY_TRUST_STATS), cloud: true },
      );
      expect(optedOut.text).toContain('This is the only email about it.');
      expect(optedOut.text).not.toContain('we remind you once');
    });

    it('mentions the added trial days only when the extension worked', () => {
      const sentence = /We added \d+ days? to your trial/;
      expect(email.html).not.toMatch(sentence);
      expect(email.text).not.toMatch(sentence);
      expect(email.text).not.toMatch(/trial/i);

      const render = (trialDaysAdded: number | undefined) =>
        appApprovedEmail(
          { name: 'Ada', providerName: 'Etsy', connectorUrl: 'https://cloud.anythingmcp.com/connectors/c1?signin=1', prompt: 'p', promptUrl: 'https://claude.ai/new?q=p', trialDaysAdded },
          { stats: formatTrustStats(EMPTY_TRUST_STATS), cloud: true },
        );
      const extended = render(7);
      expect(extended.html).toContain('We added 7 days to your trial so you can try it.');
      expect(extended.text).toContain('We added 7 days to your trial so you can try it.');
      expect(render(1).text).toContain('We added 1 day to your trial so you can try it.');
      for (const none of [render(0), render(undefined), render(Number.NaN)]) {
        expect(none.text).not.toMatch(sentence);
        expect(none.html).not.toMatch(sentence);
      }
    });
  });

  describe('the reminder email', () => {
    const email = appApprovedReminderEmail(
      {
        name: 'Ada',
        providerName: 'Etsy',
        connectorUrl: 'https://cloud.anythingmcp.com/connectors/c1?signin=1',
        prompt: 'Show my last 10 Etsy orders',
        promptUrl: 'https://claude.ai/new?q=Show%20my%20last%2010%20Etsy%20orders',
      },
      {
        stats: formatTrustStats(EMPTY_TRUST_STATS),
        cloud: true,
        unsubscribeUrl: 'https://cloud.anythingmcp.com/api/public/unsubscribe?u=u1&t=tok',
      },
    );

    it('says the sign-in is still open, with the same one button, and that nothing follows', () => {
      expect(email.subject).toBe('Your Etsy sign-in is still open');
      expect(email.html).toContain('href="https://cloud.anythingmcp.com/connectors/c1?signin=1"');
      expect(email.html.match(/<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 14px 0;">/g)).toHaveLength(1);
      expect(email.text).toContain('Etsy approved your app two days ago');
      expect(email.text).toContain('Finish the Etsy sign-in: https://cloud.anythingmcp.com/connectors/c1?signin=1');
      expect(email.text).toContain('This is the last email about it.');
    });

    it('is a nudge: it carries the unsubscribe line', () => {
      expect(email.marketing).toBe(true);
      expect(email.html).toContain('href="https://cloud.anythingmcp.com/api/public/unsubscribe?u=u1&amp;t=tok"');
      expect(email.text).toContain('Unsubscribe from tips and offers');
    });
  });
});
