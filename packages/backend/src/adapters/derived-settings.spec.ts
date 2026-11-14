import { bareHost, resolveDerivedEnvVars, withDerivedValues } from './derived-settings';

describe('derived settings', () => {
  const adapter = {
    derivedEnvVars: {
      ATLASSIAN_CLOUD_ID: {
        fromHost: 'ATLASSIAN_SITE',
        url: 'https://{{ATLASSIAN_SITE}}/_edge/tenant_info',
        path: 'cloudId',
        pattern: '^[0-9a-fA-F-]{36}$',
        error: 'No Atlassian site answers at {{host}}.',
      },
    },
  };
  const CLOUD_ID = '1324a887-45db-1bf4-1e99-ef0ff456d421';

  it('reads a bare lower-case host from what people paste', () => {
    expect(bareHost('https://Acme.atlassian.net/')).toBe('acme.atlassian.net');
    expect(bareHost('acme.atlassian.net')).toBe('acme.atlassian.net');
    expect(bareHost('https://acme.atlassian.net/wiki/spaces')).toBe('acme.atlassian.net');
    expect(bareHost('  ')).toBeUndefined();
  });

  it('looks the value up at the host and stores the host bare', async () => {
    const fetch = jest.fn().mockResolvedValue({ status: 200, data: { cloudId: CLOUD_ID } });
    const out = await resolveDerivedEnvVars(adapter, { ATLASSIAN_SITE: 'https://Acme.atlassian.net/' }, { fetch });
    expect(fetch).toHaveBeenCalledWith('https://acme.atlassian.net/_edge/tenant_info');
    expect(out).toEqual({
      values: { ATLASSIAN_SITE: 'acme.atlassian.net', ATLASSIAN_CLOUD_ID: CLOUD_ID },
      clear: [],
      fields: {},
    });
  });

  it('reads the value from a JSON text answer too', async () => {
    const fetch = jest.fn().mockResolvedValue({ status: 200, data: JSON.stringify({ cloudId: CLOUD_ID }) });
    const out = await resolveDerivedEnvVars(adapter, { ATLASSIAN_SITE: 'acme.atlassian.net' }, { fetch });
    expect(out.values.ATLASSIAN_CLOUD_ID).toBe(CLOUD_ID);
  });

  it('names the host on its field when it answers without a value', async () => {
    for (const answer of [
      { status: 404, data: '<html>not found</html>' },
      { status: 200, data: { cloudId: 'not-a-cloud-id' } },
      { status: 200, data: {} },
    ]) {
      const out = await resolveDerivedEnvVars(adapter, { ATLASSIAN_SITE: 'acme.atlassian.net' }, {
        fetch: jest.fn().mockResolvedValue(answer),
      });
      expect(out.fields).toEqual({ ATLASSIAN_SITE: 'No Atlassian site answers at acme.atlassian.net.' });
      expect(out.clear).toEqual(['ATLASSIAN_CLOUD_ID']);
    }
  });

  it('neither stores nor refuses when the host does not answer, and drops a stale value', async () => {
    for (const fetch of [
      jest.fn().mockRejectedValue(new Error('ETIMEDOUT')),
      jest.fn().mockResolvedValue({ status: 503, data: 'down' }),
    ]) {
      const out = await resolveDerivedEnvVars(adapter, { ATLASSIAN_SITE: 'acme.atlassian.net' }, { fetch });
      expect(out).toEqual({ values: { ATLASSIAN_SITE: 'acme.atlassian.net' }, clear: ['ATLASSIAN_CLOUD_ID'], fields: {} });
    }
  });

  it('clears the value when the host is empty, without a request', async () => {
    const fetch = jest.fn();
    const out = await resolveDerivedEnvVars(adapter, { ATLASSIAN_SITE: '' }, { fetch });
    expect(out).toEqual({ values: {}, clear: ['ATLASSIAN_CLOUD_ID'], fields: {} });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('asks again only when an edit changes the host', async () => {
    const fetch = jest.fn();
    const out = await resolveDerivedEnvVars(adapter, { ATLASSIAN_SITE: 'acme.atlassian.net' }, {
      fetch,
      only: ['ATLASSIAN_EMAIL'],
    });
    expect(out).toEqual({ values: {}, clear: [], fields: {} });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does nothing for an adapter without derived settings', async () => {
    expect(await resolveDerivedEnvVars({}, { X: 'y' })).toEqual({ values: {}, clear: [], fields: {} });
  });

  it('merges found values into the variables and drops cleared ones', () => {
    expect(
      withDerivedValues(
        { ATLASSIAN_EMAIL: 'a@b.test', ATLASSIAN_SITE: 'https://acme.atlassian.net/', ATLASSIAN_CLOUD_ID: 'old' },
        { values: { ATLASSIAN_SITE: 'acme.atlassian.net' }, clear: ['ATLASSIAN_CLOUD_ID'] },
      ),
    ).toEqual({ ATLASSIAN_EMAIL: 'a@b.test', ATLASSIAN_SITE: 'acme.atlassian.net' });
    const same = { A: '1' };
    expect(withDerivedValues(same, { values: {}, clear: [] })).toBe(same);
  });
});
