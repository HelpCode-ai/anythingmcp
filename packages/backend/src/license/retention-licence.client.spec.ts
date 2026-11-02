import axios from 'axios';
import { RetentionLicenceClient } from './retention-licence.client';

jest.mock('axios');
const post = axios.post as jest.Mock;

describe('RetentionLicenceClient', () => {
  const ENV = { ...process.env };
  const make = (cloud = true) => new RetentionLicenceClient({ isCloud: () => cloud } as any);
  const httpError = (status: number, data?: unknown) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });

  beforeEach(() => {
    post.mockReset();
    process.env.LICENSE_SERVICE_TOKEN = 'svc-token';
  });
  afterAll(() => {
    process.env = ENV;
  });

  describe('winbackCode', () => {
    it('asks the site with the service token and returns the code and its expiry', async () => {
      post.mockResolvedValue({ data: { code: 'KEEP-7F3K9Q', expiresAt: '2026-11-15T10:00:00.000Z' } });
      await expect(make().winbackCode('org-1', 'business', 'locked-monthly')).resolves.toEqual({
        code: 'KEEP-7F3K9Q',
        expiresAt: new Date('2026-11-15T10:00:00.000Z'),
      });
      const [url, body, config] = post.mock.calls[0];
      expect(url).toMatch(/\/api\/license\/winback-code$/);
      expect(body).toEqual({ organizationId: 'org-1', segment: 'business', offer: 'locked-monthly' });
      expect(config.headers).toEqual({ 'x-amcp-service-token': 'svc-token' });
    });

    it('answers null, so the caller postpones, when the site is unreachable or refuses', async () => {
      for (const failure of [Object.assign(new Error('ECONNRESET'), {}), httpError(502), httpError(429), httpError(400)]) {
        post.mockRejectedValueOnce(failure);
        await expect(make().winbackCode('org-1', 'consumer', 'personal-monthly')).resolves.toBeNull();
      }
    });

    it('answers null for a reply without a usable code or date', async () => {
      for (const data of [{}, { code: 'KEEP-1', expiresAt: 'soon' }, { code: '<b>', expiresAt: '2026-11-15T10:00:00Z' }]) {
        post.mockResolvedValueOnce({ data });
        await expect(make().winbackCode('org-1', 'consumer', 'personal-monthly')).resolves.toBeNull();
      }
    });

    it('never calls without a service token, nor off Cloud', async () => {
      delete process.env.LICENSE_SERVICE_TOKEN;
      await expect(make().winbackCode('org-1', 'business', 'locked-yearly')).resolves.toBeNull();
      process.env.LICENSE_SERVICE_TOKEN = 'svc-token';
      await expect(make(false).winbackCode('org-1', 'business', 'locked-yearly')).resolves.toBeNull();
      expect(post).not.toHaveBeenCalled();
    });
  });

  describe('extendTrial', () => {
    it('returns the new end date', async () => {
      post.mockResolvedValue({ data: { expiresAt: '2026-11-08T10:00:00.000Z' } });
      await expect(make().extendTrial('AMCP-AAAA-BBBB-CCCC-DDDD')).resolves.toEqual({
        ok: true,
        expiresAt: new Date('2026-11-08T10:00:00.000Z'),
      });
      expect(post.mock.calls[0][1]).toEqual({ key: 'AMCP-AAAA-BBBB-CCCC-DDDD' });
    });

    it.each([
      [404, 'not_found'],
      [409, 'not_trial'],
      [409, 'already_extended'],
      [409, 'too_late'],
      [409, 'revoked'],
      [400, 'invalid_key'],
    ])('passes on a %s refusal with reason %s', async (status, reason) => {
      post.mockRejectedValue(httpError(status, { error: 'x', reason }));
      await expect(make().extendTrial('AMCP-AAAA-BBBB-CCCC-DDDD')).resolves.toEqual({ ok: false, reason });
    });

    it('answers null when there is no answer: network, 5xx, 429, an unknown reason', async () => {
      for (const failure of [new Error('timeout'), httpError(500), httpError(429), httpError(409, { reason: 'other' })]) {
        post.mockRejectedValueOnce(failure);
        await expect(make().extendTrial('AMCP-AAAA-BBBB-CCCC-DDDD')).resolves.toBeNull();
      }
    });
  });
});
