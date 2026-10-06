import { ProductEventController } from './product-event.controller';
import { ProductEventService, sanitizeSearchQuery, scrubProviderMessage } from './product-event.service';

function build() {
  const create = jest.fn().mockResolvedValue({});
  const service = new ProductEventService({ productEvent: { create } } as any);
  const controller = new ProductEventController(service);
  const req = { user: { sub: 'u1', organizationId: 'org-1' } };
  const stored = () => create.mock.calls.map(([{ data }]) => data);
  return { controller, req, stored };
}

describe('sanitizeSearchQuery', () => {
  it('keeps an app name, with its spacing tidied', () => {
    expect(sanitizeSearchQuery('  hr   works ')).toBe('hr works');
    expect(sanitizeSearchQuery('Bill.com')).toBe('Bill.com');
    expect(sanitizeSearchQuery('S/4HANA')).toBe('S/4HANA');
  });

  it('drops an email address, a pasted key and anything too long', () => {
    expect(sanitizeSearchQuery('max@example.com')).toBeNull();
    expect(sanitizeSearchQuery('sk_live_51Hx2kQ8rT9vZpYwA3bC')).toBeNull();
    expect(sanitizeSearchQuery('x'.repeat(101))).toBeNull();
    expect(sanitizeSearchQuery('   ')).toBeNull();
    expect(sanitizeSearchQuery(42)).toBeNull();
  });
});

describe('POST /api/product-events — catalog searches', () => {
  it('records a search from the store with its query and result count', async () => {
    const { controller, req, stored } = build();
    await controller.record(req, { event: 'catalog_search', metadata: { query: 'Atera', results: 0, via: 'store' } });
    expect(stored()).toEqual([
      expect.objectContaining({
        event: 'catalog_search',
        userId: 'u1',
        organizationId: 'org-1',
        metadata: { via: 'store', query: 'Atera', results: 0 },
      }),
    ]);
  });

  it('refuses a search a page claims came from a chat, or from nowhere', async () => {
    const { controller, req, stored } = build();
    await controller.record(req, { event: 'catalog_search', metadata: { query: 'x', results: 0, via: 'mcp' } });
    await controller.record(req, { event: 'catalog_search_picked', metadata: { query: 'x', adapterSlug: 'etsy' } });
    expect(stored()).toEqual([]);
  });

  it('keeps the event but not a query that holds an email address', async () => {
    const { controller, req, stored } = build();
    await controller.record(req, { event: 'catalog_search', metadata: { query: 'me@corp.de', results: 0, via: 'welcome' } });
    expect(stored()[0].metadata).toEqual({ via: 'welcome', results: 0 });
  });
});

describe('scrubProviderMessage', () => {
  it('drops query strings, masks given secrets and token-like runs, caps the length', () => {
    expect(scrubProviderMessage('GET https://x.example/api?appid=abc failed', [])).toBe('GET https://x.example/api failed');
    expect(scrubProviderMessage('bad key s3cr3t-value', ['s3cr3t-value'])).toBe('bad key ***');
    expect(scrubProviderMessage(`token ${'a1'.repeat(20)} expired`)).toBe('token *** expired');
    expect(scrubProviderMessage('x'.repeat(30) + ' ' + 'word '.repeat(60))!.length).toBe(160);
    expect(scrubProviderMessage('   ')).toBeNull();
  });
});
