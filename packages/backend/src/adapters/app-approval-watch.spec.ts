import {
  APP_APPROVAL_ADAPTERS,
  FIRST_PROMPT,
  REMIND_AFTER_MS,
  REMIND_WINDOW_MS,
  SWEEP_LOOKBACK_MS,
  WATCH_FOR_MS,
  appApprovalAnnounced,
  checkInterval,
  claudePromptUrl,
  isCheckDue,
  isReminderDue,
  pendingEvidence,
  readWatch,
  signInPath,
  watchFinished,
} from './app-approval-watch';
import { getAdapter } from './catalog';

const H = 60 * 60 * 1000;
const D = 24 * H;
const now = new Date('2026-11-02T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const iso = (ms: number) => ago(ms).toISOString();

describe('app-approval-watch', () => {
  it('watches only adapters that have a key check to repeat', () => {
    for (const slug of APP_APPROVAL_ADAPTERS) {
      expect(getAdapter(slug)?.checkBeforeAuthorization).toBeDefined();
      expect(FIRST_PROMPT[slug]).toBeTruthy();
    }
    expect(FIRST_PROMPT.etsy).toBe('Show my last 10 Etsy orders');
  });

  describe('readWatch', () => {
    it('reads the watch from the connector config and drops anything that is not a date', () => {
      expect(readWatch({ adapterSlug: 'etsy' })).toEqual({});
      expect(readWatch(null)).toEqual({});
      expect(
        readWatch({ appApprovalWatch: { pendingSince: iso(H), notifiedAt: 'soon', lastCheckedAt: 5, x: iso(0) } }),
      ).toEqual({ pendingSince: iso(H) });
      expect(readWatch({ appApprovalWatch: { notifiedAt: iso(3 * D), remindedAt: iso(D) } })).toEqual({
        notifiedAt: iso(3 * D),
        remindedAt: iso(D),
      });
    });
  });

  describe('backoff', () => {
    it('checks hourly during the first day after the keys were refused', () => {
      expect(checkInterval({ pendingSince: iso(3 * H) }, now)).toBe(H);
      expect(checkInterval({}, now)).toBe(H);
    });

    it('checks every 6 hours after the first day', () => {
      expect(checkInterval({ pendingSince: iso(D + H) }, now)).toBe(6 * H);
    });

    it('is due at once when never checked', () => {
      expect(isCheckDue({}, ago(H), now)).toBe(true);
    });

    it('is due an hour after the last check on the first day, a few minutes early included', () => {
      const pendingSince = iso(5 * H);
      expect(isCheckDue({ pendingSince, lastCheckedAt: iso(30 * 60 * 1000) }, ago(5 * H), now)).toBe(false);
      expect(isCheckDue({ pendingSince, lastCheckedAt: iso(56 * 60 * 1000) }, ago(5 * H), now)).toBe(true);
      expect(isCheckDue({ pendingSince, lastCheckedAt: iso(H) }, ago(5 * H), now)).toBe(true);
    });

    it('waits 6 hours between checks after the first day', () => {
      const pendingSince = iso(3 * D);
      expect(isCheckDue({ pendingSince, lastCheckedAt: iso(2 * H) }, ago(3 * D), now)).toBe(false);
      expect(isCheckDue({ pendingSince, lastCheckedAt: iso(5 * H) }, ago(3 * D), now)).toBe(false);
      expect(isCheckDue({ pendingSince, lastCheckedAt: iso(6 * H) }, ago(3 * D), now)).toBe(true);
    });

    it('stops 14 days after the connector was created or the keys were first refused', () => {
      expect(isCheckDue({}, ago(15 * D), now)).toBe(false);
      expect(isCheckDue({ pendingSince: iso(14 * D + H), lastCheckedAt: iso(7 * H) }, ago(13 * D), now)).toBe(false);
      expect(isCheckDue({ pendingSince: iso(13 * D), lastCheckedAt: iso(7 * H) }, ago(13 * D), now)).toBe(true);
    });

    it('never checks again once the watch has ended', () => {
      for (const end of ['notifiedAt', 'approvedAt', 'notPending', 'doneAt'] as const) {
        const watch = { pendingSince: iso(H), [end]: iso(0) };
        expect(watchFinished(watch)).toBe(true);
        expect(isCheckDue(watch, ago(H), now)).toBe(false);
      }
    });
  });

  describe('pendingEvidence', () => {
    const connector = { id: 'c1', organizationId: 'o1', createdAt: ago(2 * H), adapterSlug: 'etsy' };
    const ev = (over: Partial<{ event: string; organizationId: string; createdAt: Date; metadata: unknown }>) => ({
      event: 'etsy_app_pending_seen',
      organizationId: 'o1',
      createdAt: ago(3 * H),
      metadata: { adapterSlug: 'etsy', via: 'setup' },
      ...over,
    });

    it('takes the setup check of the same workspace, made just before the connector existed', () => {
      expect(pendingEvidence(connector, [ev({})], 'etsy_app_pending_seen')).toEqual(ago(3 * H));
    });

    it('takes the earliest refusal', () => {
      const events = [ev({ createdAt: ago(H) }), ev({ createdAt: ago(5 * H) })];
      expect(pendingEvidence(connector, events, 'etsy_app_pending_seen')).toEqual(ago(5 * H));
    });

    it('takes a 403 setup_verify_failed from before the event existed, not other failures', () => {
      const old = ev({ event: 'setup_verify_failed', metadata: { adapterSlug: 'etsy', kind: 'auth_failed', status: 403 } });
      const other = ev({ event: 'setup_verify_failed', metadata: { adapterSlug: 'etsy', kind: 'invalid_input' } });
      expect(pendingEvidence(connector, [old], 'etsy_app_pending_seen')).toEqual(ago(3 * H));
      expect(pendingEvidence(connector, [other], 'etsy_app_pending_seen')).toBeUndefined();
    });

    it('ignores other workspaces, other adapters, other connectors and refusals long before', () => {
      const events = [
        ev({ organizationId: 'o2' }),
        ev({ metadata: { adapterSlug: 'pinterest' } }),
        ev({ metadata: { adapterSlug: 'etsy', connectorId: 'c2' } }),
        ev({ createdAt: ago(2 * H + D + 1) }),
      ];
      expect(pendingEvidence(connector, events, 'etsy_app_pending_seen')).toBeUndefined();
      expect(
        pendingEvidence(connector, [ev({ metadata: { adapterSlug: 'etsy', connectorId: 'c1' } })], 'etsy_app_pending_seen'),
      ).toEqual(ago(3 * H));
    });
  });

  describe('the reminder', () => {
    const notified = (ms: number, more: Record<string, string> = {}) => ({
      pendingSince: iso(ms + D),
      approvedAt: iso(ms),
      notifiedAt: iso(ms),
      ...more,
    });

    it('is due 48 hours after the approval email, not before', () => {
      expect(REMIND_AFTER_MS).toBe(48 * H);
      expect(isReminderDue(notified(47 * H), now)).toBe(false);
      expect(isReminderDue(notified(48 * H), now)).toBe(true);
      expect(isReminderDue(notified(60 * H), now)).toBe(true);
    });

    it('is never due without an approval email, after a reminder, or once the sign-in was seen', () => {
      expect(isReminderDue({ pendingSince: iso(60 * H) }, now)).toBe(false);
      expect(isReminderDue({ notPending: iso(60 * H) }, now)).toBe(false);
      expect(isReminderDue(notified(60 * H, { remindedAt: iso(10 * H) }), now)).toBe(false);
      expect(isReminderDue(notified(60 * H, { doneAt: iso(10 * H) }), now)).toBe(false);
    });

    it('is dropped a day after it fell due, so an old approval is not reminded of', () => {
      expect(REMIND_WINDOW_MS).toBe(24 * H);
      expect(isReminderDue(notified(72 * H - 1), now)).toBe(true);
      expect(isReminderDue(notified(72 * H), now)).toBe(false);
      expect(isReminderDue(notified(20 * D), now)).toBe(false);
    });

    it('keeps the key checks at 14 days and reads three days further for a late approval', () => {
      expect(WATCH_FOR_MS).toBe(14 * D);
      expect(SWEEP_LOOKBACK_MS).toBe(17 * D);
      // Approved on the last day of the watch: no more key checks, the reminder still due.
      const late = notified(48 * H);
      expect(isCheckDue(late, ago(16 * D), now)).toBe(false);
      expect(isReminderDue(late, now)).toBe(true);
    });
  });

  describe('what the AI client is told', () => {
    it('counts an approval of a watched adapter until the sign-in was seen', () => {
      const approved = { pendingSince: iso(2 * D), approvedAt: iso(D), notifiedAt: iso(D) };
      expect(appApprovalAnnounced({ adapterSlug: 'etsy', appApprovalWatch: approved })).toBe(true);
      expect(appApprovalAnnounced({ adapterSlug: 'etsy', appApprovalWatch: { ...approved, remindedAt: iso(H) } })).toBe(true);
      expect(appApprovalAnnounced({ adapterSlug: 'etsy', appApprovalWatch: { ...approved, doneAt: iso(H) } })).toBe(false);
    });

    it('says nothing while the app is pending, when it never was, or for another adapter', () => {
      expect(appApprovalAnnounced({ adapterSlug: 'etsy' })).toBe(false);
      expect(appApprovalAnnounced({ adapterSlug: 'etsy', appApprovalWatch: { pendingSince: iso(D) } })).toBe(false);
      expect(appApprovalAnnounced({ adapterSlug: 'etsy', appApprovalWatch: { notPending: iso(D) } })).toBe(false);
      expect(appApprovalAnnounced({ adapterSlug: 'pinterest', appApprovalWatch: { approvedAt: iso(D) } })).toBe(false);
      expect(appApprovalAnnounced(null)).toBe(false);
    });
  });

  it('links to the connector page with the sign-in started, and to nothing else', () => {
    expect(signInPath('c1')).toBe('/connectors/c1?signin=1');
    expect(signInPath('a/b?x=1#y')).toBe('/connectors/a%2Fb%3Fx%3D1%23y?signin=1');
  });

  it('builds the claude.ai link with the request typed in', () => {
    expect(claudePromptUrl('Show my last 10 Etsy orders')).toBe(
      'https://claude.ai/new?q=Show%20my%20last%2010%20Etsy%20orders',
    );
  });
});
