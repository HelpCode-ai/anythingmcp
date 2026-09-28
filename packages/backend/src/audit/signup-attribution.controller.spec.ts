import { GUARDS_METADATA } from '@nestjs/common/constants';
import { SignupAttributionController } from './signup-attribution.controller';
import { ProductEventService, ProductEvents } from './product-event.service';

/**
 * GET /api/auth/attribution/click-ids: the caller's own click id, stored with
 * ad consent, on AnythingMCP Cloud only.
 */

type Row = { event: string; userId: string | null; organizationId: string | null; createdAt: Date; metadata: unknown };

const ROWS: Row[] = [
  {
    event: ProductEvents.SIGNUP_ATTRIBUTED,
    userId: 'alice',
    organizationId: 'org-a',
    createdAt: new Date('2026-09-20T10:00:00Z'),
    metadata: {
      first_touch: { utm_source: 'google', gclid: 'alice-gclid', ad_consent: 'granted', paid: true, channel: 'google_ads' },
      first_channel: 'google_ads',
    },
  },
  {
    // Same organization, another user: never Alice's answer.
    event: ProductEvents.SIGNUP_ATTRIBUTED,
    userId: 'bob',
    organizationId: 'org-a',
    createdAt: new Date('2026-09-25T10:00:00Z'),
    metadata: { first_touch: { gclid: 'bob-gclid', ad_consent: 'granted', channel: 'google_ads' } },
  },
  {
    // A client-reportable event that happens to carry a click id-shaped field.
    event: ProductEvents.MCP_URL_COPIED,
    userId: 'alice',
    organizationId: 'org-a',
    createdAt: new Date('2026-09-26T10:00:00Z'),
    metadata: { first_touch: { gclid: 'forged', ad_consent: 'granted' } },
  },
  {
    event: ProductEvents.SIGNUP_ATTRIBUTED,
    userId: 'carol',
    organizationId: 'org-c',
    createdAt: new Date('2026-09-21T10:00:00Z'),
    // Stored without consent (or before the rule existed): no id comes back.
    metadata: { first_touch: { gclid: 'carol-gclid', ad_consent: 'denied', channel: 'google_ads' } },
  },
  {
    event: ProductEvents.SIGNUP_ATTRIBUTED,
    userId: 'dave',
    organizationId: 'org-d',
    createdAt: new Date('2026-09-22T10:00:00Z'),
    metadata: { first_touch: { referrer_host: 'github.com', channel: 'github' } },
  },
];

function fakePrisma() {
  const findMany = jest.fn(async ({ where, orderBy, take }: any) => {
    let rows = ROWS.filter(
      (r) => Object.entries(where).every(([k, v]) => (r as Record<string, unknown>)[k] === v),
    );
    if (orderBy?.createdAt === 'desc') rows = [...rows].sort((a, b) => +b.createdAt - +a.createdAt);
    return rows.slice(0, take ?? rows.length).map((r) => ({ metadata: r.metadata }));
  });
  return { prisma: { productEvent: { findMany } }, findMany };
}

function makeController(mode: 'cloud' | 'self-hosted') {
  const { prisma, findMany } = fakePrisma();
  const controller = new SignupAttributionController(new ProductEventService(prisma as any), {
    isCloud: () => mode === 'cloud',
  } as any);
  return { controller, findMany };
}

const asUser = (sub: string, organizationId = 'org-a') => ({ user: { sub, organizationId } });

describe('SignupAttributionController — GET click-ids', () => {
  it('sits behind the JWT guard', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, SignupAttributionController) ?? [];
    expect(guards).toHaveLength(1);
  });

  it("returns the caller's own click id and consent, nothing else", async () => {
    const { controller, findMany } = makeController('cloud');
    await expect(controller.clickIds(asUser('alice'))).resolves.toEqual({
      gclid: 'alice-gclid',
      ad_consent: 'granted',
    });
    // Keyed by the session's user id and the server-written event only.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'alice', event: ProductEvents.SIGNUP_ATTRIBUTED } }),
    );
  });

  it("never answers with another user's click id, even in the same organization", async () => {
    const { controller } = makeController('cloud');
    const bob = await controller.clickIds(asUser('bob'));
    expect(bob).toEqual({ gclid: 'bob-gclid', ad_consent: 'granted' });
    expect(JSON.stringify(bob)).not.toContain('alice');
    await expect(controller.clickIds(asUser('eve', 'org-a'))).resolves.toEqual({});
  });

  it('returns nothing for an id stored without granted consent, or no id at all', async () => {
    const { controller } = makeController('cloud');
    await expect(controller.clickIds(asUser('carol', 'org-c'))).resolves.toEqual({});
    await expect(controller.clickIds(asUser('dave', 'org-d'))).resolves.toEqual({});
  });

  it('returns nothing without a user id, and does not query', async () => {
    const { controller, findMany } = makeController('cloud');
    await expect(controller.clickIds({ user: {} })).resolves.toEqual({});
    await expect(controller.clickIds({})).resolves.toEqual({});
    expect(findMany).not.toHaveBeenCalled();
  });

  it('is empty on a self-hosted instance, and does not query', async () => {
    const { controller, findMany } = makeController('self-hosted');
    await expect(controller.clickIds(asUser('alice'))).resolves.toEqual({});
    expect(findMany).not.toHaveBeenCalled();
  });
});
