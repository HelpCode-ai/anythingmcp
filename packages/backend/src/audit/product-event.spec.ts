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

  it('keeps how a search matched, and only the known kinds', async () => {
    const { controller, req, stored } = build();
    await controller.record(req, { event: 'catalog_search', metadata: { query: 'telgram', results: 1, match: 'fuzzy', via: 'store' } });
    await controller.record(req, { event: 'catalog_search', metadata: { query: 'etsy', results: 1, match: 'anything else', via: 'store' } });
    expect(stored().map((e: any) => e.metadata)).toEqual([
      { via: 'store', query: 'telgram', results: 1, match: 'fuzzy' },
      { via: 'store', query: 'etsy', results: 1 },
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

describe('POST /api/product-events — /start-trial funnel', () => {
  it('keeps the source the page was opened from on both events', async () => {
    const { controller, req, stored } = build();
    await controller.record(req, {
      event: 'start_trial_viewed',
      metadata: { source: 'first_success_banner', kind: 'trial' },
    });
    await controller.record(req, {
      event: 'start_trial_checkout_started',
      metadata: { source: 'trial_ended_wall', kind: 'pay' },
    });
    expect(stored().map((e: any) => [e.event, e.metadata])).toEqual([
      ['start_trial_viewed', { kind: 'trial', source: 'first_success_banner' }],
      ['start_trial_checkout_started', { kind: 'pay', source: 'trial_ended_wall' }],
    ]);
  });

  it('records a skip, and a coarse device on the view', async () => {
    const { controller, req, stored } = build();
    await controller.record(req, {
      event: 'start_trial_viewed',
      metadata: { source: 'signup_prompt', kind: 'trial', device: 'mobile' },
    });
    await controller.record(req, { event: 'start_trial_skipped', metadata: { source: 'signup_prompt', kind: 'trial' } });
    expect(stored().map((e: any) => [e.event, e.metadata])).toEqual([
      ['start_trial_viewed', { kind: 'trial', source: 'signup_prompt', device: 'mobile' }],
      ['start_trial_skipped', { kind: 'trial', source: 'signup_prompt' }],
    ]);
  });

  it('drops a device value other than mobile or desktop', async () => {
    const { controller, req, stored } = build();
    await controller.record(req, {
      event: 'start_trial_viewed',
      metadata: { source: 'signup_prompt', kind: 'trial', device: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' },
    });
    expect(stored()[0].metadata).toEqual({ kind: 'trial', source: 'signup_prompt' });
  });

  it('drops a source that is not a known checkout entry point', async () => {
    const { controller, req, stored } = build();
    await controller.record(req, {
      event: 'start_trial_viewed',
      metadata: { source: 'me@corp.de', kind: 'trial' },
    });
    expect(stored()[0].metadata).toEqual({ kind: 'trial' });
  });
});

describe('POST /api/product-events — File Search wizard', () => {
  it('records the funnel with protocol, preset, adapter and coarse counts', async () => {
    const { controller, req, stored } = build();
    const base = { protocol: 'sftp', preset: 'synology', adapterSlug: 'synology-file-search' };
    await controller.record(req, { event: 'file_search_wizard_opened', metadata: { ...base, via: 'store_hint' } });
    await controller.record(req, { event: 'file_search_test_failed', metadata: { ...base, kind: 'auth' } });
    await controller.record(req, { event: 'file_search_test_passed', metadata: base });
    await controller.record(req, { event: 'file_search_scan_finished', metadata: { ...base, kind: 'fits', files: '101-500' } });
    await controller.record(req, { event: 'file_search_activated', metadata: { ...base, files: '101-500' } });
    await controller.record(req, { event: 'file_search_locked_shown', metadata: { kind: 'connector_limit' } });
    expect(stored().map((e: any) => [e.event, e.metadata])).toEqual([
      ['file_search_wizard_opened', { adapterSlug: 'synology-file-search', via: 'store_hint', protocol: 'sftp', preset: 'synology' }],
      ['file_search_test_failed', { adapterSlug: 'synology-file-search', kind: 'auth', protocol: 'sftp', preset: 'synology' }],
      ['file_search_test_passed', { adapterSlug: 'synology-file-search', protocol: 'sftp', preset: 'synology' }],
      ['file_search_scan_finished', { adapterSlug: 'synology-file-search', kind: 'fits', protocol: 'sftp', preset: 'synology', files: '101-500' }],
      ['file_search_activated', { adapterSlug: 'synology-file-search', protocol: 'sftp', preset: 'synology', files: '101-500' }],
      ['file_search_locked_shown', { kind: 'connector_limit' }],
    ]);
  });

  it('drops an unknown protocol or preset and an exact file count', async () => {
    const { controller, req, stored } = build();
    await controller.record(req, {
      event: 'file_search_scan_finished',
      metadata: { protocol: 'nas.example.com', preset: '/volume1/share', files: 1234, kind: 'fits' },
    });
    await controller.record(req, { event: 'file_search_activated', metadata: { protocol: 'webdav', files: '1234' } });
    expect(stored().map((e: any) => e.metadata)).toEqual([{ kind: 'fits' }, { protocol: 'webdav' }]);
  });

  it('keeps a search whose first result is a File Search suggestion', async () => {
    const { controller, req, stored } = build();
    await controller.record(req, { event: 'catalog_search', metadata: { query: 'Dateiserver', results: 2, match: 'suggested', via: 'welcome' } });
    expect(stored()[0].metadata).toEqual({ via: 'welcome', query: 'Dateiserver', results: 2, match: 'suggested' });
  });
});

describe('scrubProviderMessage', () => {
  it('drops query strings, masks given secrets and token-like runs, caps the length', () => {
    expect(scrubProviderMessage('GET https://x.example/api?appid=abc failed', [])).toBe('GET https://x.example/api failed');
    expect(scrubProviderMessage('bad key s3cr3t-value', ['s3cr3t-value'])).toBe('bad key ***');
    expect(scrubProviderMessage(`token ${'a1'.repeat(20)} expired`)).toBe('token *** expired');
    expect(scrubProviderMessage('x'.repeat(30) + ' ' + 'word '.repeat(100))!.length).toBe(400);
    expect(scrubProviderMessage('   ')).toBeNull();
  });

  it("keeps the provider's words that follow our hint", () => {
    const hint = 'The target API returned a server error (500). This is on their side, not your configuration.';
    const odoo = `${hint} (Request failed with status code 500: {"name":"builtins.ValueError","message":"Invalid field 'customer_rank' on 'res.partner'"})`;
    expect(scrubProviderMessage(odoo)).toContain("Invalid field 'customer_rank' on 'res.partner'");
  });

  it('cuts a URL at its first ? or #, wherever it sits in the text', () => {
    expect(scrubProviderMessage('see "https://a.example/x#frag" and http://b.example/y?k=v&z=1 now')).toBe(
      'see "https://a.example/x" and http://b.example/y now',
    );
    expect(scrubProviderMessage('plain https://c.example/path, done')).toBe('plain https://c.example/path, done');
  });

  it('masks a secret that straddles the part the regexes read', () => {
    const secret = 'zz-secret-value';
    // Cut first, mask after, and "zz-secret-" would survive the 2000-character cut.
    expect(scrubProviderMessage(`${' '.repeat(1990)}${secret} given`, [secret])).toBe('*** given');
  });

  it('stays fast on a long crafted input (CodeQL js/polynomial-redos)', () => {
    for (const input of ['http://'.repeat(50_000), `${'http://a'.repeat(20_000)}?`, 'a'.repeat(31).concat(' ').repeat(10_000)]) {
      const started = Date.now();
      const out = scrubProviderMessage(input);
      expect(Date.now() - started).toBeLessThan(200);
      expect(out!.length).toBeLessThanOrEqual(400);
    }
  });
});

describe('ProductEventService.log — server-written metadata', () => {
  it('keeps cardTrialOffered on the empty-workspace prompt (the #920 measurement)', async () => {
    const create = jest.fn().mockResolvedValue({});
    const service = new ProductEventService({ productEvent: { create } } as any);
    await service.log({
      event: 'empty_workspace_prompt',
      userId: 'u1',
      organizationId: 'org-1',
      metadata: { client: 'Claude', cardTrialOffered: true },
    });
    expect(create.mock.calls[0][0].data.metadata).toEqual({ client: 'Claude', cardTrialOffered: true });
  });

  it('keeps the reactivation-link arm on a blocked call and the state on a page view', async () => {
    const create = jest.fn().mockResolvedValue({});
    const service = new ProductEventService({ productEvent: { create } } as any);
    for (const variant of ['page', 'pricing']) {
      await service.log({
        event: 'trial_expired_call_blocked',
        organizationId: 'org-1',
        metadata: { toolName: 't', adapterSlug: 'odoo', client: 'claude-ai', variant },
      });
    }
    await service.log({ event: 'reactivate_page_viewed', organizationId: 'org-1', metadata: { state: 'trial-ended' } });
    await service.log({ event: 'license_wall_viewed', organizationId: 'org-1', metadata: { variant: 'trust' } });
    await service.log({ event: 'reactivate_page_viewed', organizationId: 'org-1', metadata: { state: 'x', variant: 'y' } });
    const stored = create.mock.calls.map((c) => c[0].data.metadata);
    expect(stored[0]).toEqual({ toolName: 't', adapterSlug: 'odoo', client: 'claude-ai', variant: 'page' });
    expect(stored[1].variant).toBe('pricing');
    expect(stored[2]).toEqual({ state: 'trial-ended' });
    expect(stored[3]).toEqual({ variant: 'trust' });
    expect(stored[4]).toBeNull();
  });

  it('keeps a paywall_action from either pay screen, with only known actions, plans and periods', async () => {
    const create = jest.fn().mockResolvedValue({});
    const service = new ProductEventService({ productEvent: { create } } as any);
    expect(service.isKnown('paywall_action')).toBe(true);
    await service.log({
      event: 'paywall_action',
      organizationId: 'org-1',
      metadata: { source: 'trial_ended_wall', variant: 'trust', action: 'subscribe_clicked', plan: 'team', period: 'yearly', device: 'mobile' },
    });
    await service.log({
      event: 'paywall_action',
      organizationId: 'org-1',
      metadata: { source: 'mcp_reactivate', action: 'pwned', plan: 'business', period: 'weekly', email: 'a@b.c' },
    });
    const stored = create.mock.calls.map((c) => c[0].data.metadata);
    expect(stored[0]).toEqual({
      source: 'trial_ended_wall',
      device: 'mobile',
      variant: 'trust',
      action: 'subscribe_clicked',
      plan: 'team',
      period: 'yearly',
    });
    expect(stored[1]).toEqual({ source: 'mcp_reactivate' });
  });

  it('keeps the Telegram price test arm, and only its two values', async () => {
    const create = jest.fn().mockResolvedValue({});
    const service = new ProductEventService({ productEvent: { create } } as any);
    await service.log({ event: 'reactivate_page_viewed', organizationId: 'org-1', metadata: { state: 'trial-ended', offer: 'personal' } });
    await service.log({ event: 'paywall_action', organizationId: 'org-1', metadata: { action: 'shown', offer: 'free-forever' } });
    const stored = create.mock.calls.map((c) => c[0].data.metadata);
    expect(stored[0]).toEqual({ state: 'trial-ended', offer: 'personal' });
    expect(stored[1]).toEqual({ action: 'shown' });
  });
});

describe('ProductEventService — the Claude setup discoverability events', () => {
  it('keeps the shared tool call metadata, and only known profiles and setup tools', async () => {
    const create = jest.fn().mockResolvedValue({});
    const service = new ProductEventService({ productEvent: { create } } as any);
    await service.log({
      event: 'shared_tool_called',
      organizationId: 'org-1',
      metadata: { tool: 'anythingmcp_run_read_tool', profile: 'default', setupTool: 'setup_find_connectors', client: 'Claude' },
    });
    await service.log({
      event: 'shared_tool_called',
      organizationId: 'org-1',
      metadata: { tool: 'anythingmcp_search_tools', profile: 'other', setupTool: 'drop_tables' },
    });
    expect(create.mock.calls.map(([{ data }]) => data.metadata)).toEqual([
      { client: 'Claude', tool: 'anythingmcp_run_read_tool', profile: 'default', setupTool: 'setup_find_connectors' },
      { tool: 'anythingmcp_search_tools' },
    ]);
  });

  it('refuses both events from a page: only the server writes them', async () => {
    const { controller, req, stored } = build();
    for (const event of ['shared_tool_called', 'post_approve_app_picked']) {
      await controller.record(req as any, { event, metadata: { adapterSlug: 'telegram-bot' } } as any);
    }
    expect(stored()).toEqual([]);
  });
});
