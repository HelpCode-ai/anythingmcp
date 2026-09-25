import {
  isSecretName,
  isSecretValue,
  maskEnvVars,
  maskHeaders,
  mergeMaskedEnvVars,
  mergeMaskedHeaders,
  secretContext,
  toPublicConnector,
} from './connector-secrets.util';

describe('isSecretName', () => {
  it.each([
    'IS24_CONSUMER_KEY',
    'IS24_CONSUMER_SECRET',
    'IS24_CLIENT_SECRET',
    'SHOPIFY_ACCESS_TOKEN',
    'GOOGLE_REFRESH_TOKEN',
    'MYSQL_PASSWORD',
    'WORDPRESS_APP_PASSWORD',
    'CLOCKODO_API_KEY',
    'KLAVIYO_PRIVATE_API_KEY',
    'HRWORKS_SECRET_ACCESS_KEY',
    'GHOST_ADMIN_JWT',
    'SENTRY_AUTH_TOKEN',
    'BITRIX24_WEBHOOK_URL',
    'apiKey',
    'clientSecret',
    'x-api-key',
    'Authorization',
  ])('treats %s as a secret', (name) => {
    expect(isSecretName(name)).toBe(true);
  });

  it.each([
    'WHATSAPP_BUSINESS_ACCOUNT_ID',
    'ECWID_STORE_ID',
    'BIGCOMMERCE_STORE_HASH',
    'SUBSTACK_PUBLICATION_URL',
    'SHOPWARE_URL',
    'GOOGLE_CLIENT_ID',
    'ZENDESK_SUBDOMAIN',
    'MYSQL_HOST',
    'MYSQL_USER',
    'SHIPPING_REGION',
    'Harvest-Account-Id',
    'Accept',
  ])('shows %s', (name) => {
    expect(isSecretName(name)).toBe(false);
  });
});

describe('isSecretValue', () => {
  it('catches a connection string with a password', () => {
    expect(isSecretValue('postgres://reader:not-a-real-pw@db.example.test:5432/app')).toBe(true);
    expect(isSecretValue('mongodb://u:p@h1.example.test,h2.example.test/db')).toBe(true);
  });

  it('catches bearer strings and PEM keys', () => {
    expect(isSecretValue('Bearer abc.def')).toBe(true);
    expect(isSecretValue('-----BEGIN PRIVATE KEY-----\nMIIE')).toBe(true);
  });

  it('leaves ordinary URLs and IDs alone', () => {
    expect(isSecretValue('https://shop.example.test/api')).toBe(false);
    expect(isSecretValue('https://user@example.test/')).toBe(false);
    expect(isSecretValue('102938475610')).toBe(false);
    expect(isSecretValue('someone@example.test')).toBe(false);
  });
});

describe('secretContext', () => {
  it('marks variables the adapter puts in a credential slot, whatever their name', () => {
    // Etsy sends `x-api-key: {{ETSY_CLIENT_ID}}:{{ETSY_CLIENT_SECRET}}`.
    const ctx = secretContext({ config: { adapterSlug: 'etsy' } });
    expect(ctx.slotVars.has('ETSY_CLIENT_ID')).toBe(true);
  });

  it('marks the previous name of a renamed secret', () => {
    const ctx = secretContext({ config: { adapterSlug: 'immobilienscout24' } });
    expect(ctx.slotVars.has('IS24_CLIENT_ID')).toBe(true);
  });

  it('marks a header the adapter fills from a secret variable', () => {
    const ctx = secretContext({ config: { adapterSlug: 'billbee' } });
    expect(ctx.secretHeaders.has('x-billbee-api-key')).toBe(true);
    expect(ctx.secretHeaders.has('accept')).toBe(false);
  });

  it('reads the templates in a hand-built connector\'s headers', () => {
    const ctx = secretContext({
      config: null,
      headers: { 'X-Session': '{{SHOP_LOGIN}}' },
    });
    expect(ctx.slotVars.has('SHOP_LOGIN')).toBe(true);
  });
});

describe('masking', () => {
  const ctx = secretContext({ config: null });

  it('empties secrets, names them, and keeps everything else', () => {
    const result = maskEnvVars(
      {
        WHATSAPP_ACCESS_TOKEN: 'test-token-value',
        WHATSAPP_BUSINESS_ACCOUNT_ID: '1234567890',
        SHOP_URL: 'https://shop.example.test',
        EMPTY_SECRET_KEY: '',
      },
      ctx,
    );
    expect(result.envVars).toEqual({
      WHATSAPP_ACCESS_TOKEN: '',
      WHATSAPP_BUSINESS_ACCOUNT_ID: '1234567890',
      SHOP_URL: 'https://shop.example.test',
      EMPTY_SECRET_KEY: '',
    });
    // An empty secret is not "set", so it is not listed.
    expect(result.maskedEnvVars).toEqual(['WHATSAPP_ACCESS_TOKEN']);
  });

  it('handles a connector without env vars or headers', () => {
    expect(maskEnvVars(null, ctx)).toEqual({ envVars: null, maskedEnvVars: [] });
    expect(maskHeaders(undefined, ctx)).toEqual({ headers: null, maskedHeaders: [] });
  });

  it('shows a header that only references a variable', () => {
    const result = maskHeaders(
      { Authorization: 'Bearer {{API_TOKEN}}', 'X-Api-Key': 'test-key-123' },
      ctx,
    );
    expect(result.headers).toEqual({
      Authorization: 'Bearer {{API_TOKEN}}',
      'X-Api-Key': '',
    });
    expect(result.maskedHeaders).toEqual(['X-Api-Key']);
  });

  it('toPublicConnector masks both maps and keeps the rest of the row', () => {
    const pub = toPublicConnector({
      id: 'c1',
      name: 'Billbee',
      config: { adapterSlug: 'billbee' },
      headers: { 'X-Billbee-Api-Key': 'test-key-123', Accept: 'application/json' },
      envVars: { BILLBEE_API_KEY: 'test-key-123', BILLBEE_LOGIN_EMAIL: 'shop@example.test' },
    });
    expect(pub).toMatchObject({
      id: 'c1',
      name: 'Billbee',
      headers: { 'X-Billbee-Api-Key': '', Accept: 'application/json' },
      envVars: { BILLBEE_API_KEY: '', BILLBEE_LOGIN_EMAIL: 'shop@example.test' },
      maskedEnvVars: ['BILLBEE_API_KEY'],
      maskedHeaders: ['X-Billbee-Api-Key'],
    });
    expect(JSON.stringify(pub)).not.toContain('test-key-123');
  });
});

describe('merging an edit made against the masked view', () => {
  const ctx = secretContext({ config: null });
  const stored = {
    API_TOKEN: 'stored-token',
    SHOP_URL: 'https://shop.example.test',
    OLD_SECRET: 'old-secret',
  };

  it('keeps a secret sent back empty, applies typed values, drops left-out names', () => {
    const merged = mergeMaskedEnvVars(
      { API_TOKEN: '', SHOP_URL: 'https://other.example.test', NEW_KEY: 'new' },
      stored,
      ctx,
    );
    expect(merged).toEqual({
      API_TOKEN: 'stored-token',
      SHOP_URL: 'https://other.example.test',
      NEW_KEY: 'new',
    });
  });

  it('replaces a secret that was retyped', () => {
    expect(mergeMaskedEnvVars({ API_TOKEN: 'typed' }, stored, ctx)).toEqual({
      API_TOKEN: 'typed',
    });
  });

  it('stores an emptied non-secret as empty', () => {
    expect(mergeMaskedEnvVars({ SHOP_URL: '' }, stored, ctx)).toEqual({ SHOP_URL: '' });
  });

  it('does the same for headers', () => {
    expect(
      mergeMaskedHeaders(
        { 'X-Api-Key': '', Accept: 'text/plain' },
        { 'X-Api-Key': 'test-key-123', Accept: 'application/json' },
        ctx,
      ),
    ).toEqual({ 'X-Api-Key': 'test-key-123', Accept: 'text/plain' });
  });
});
