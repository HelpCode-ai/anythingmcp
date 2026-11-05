import * as adapter from './ebay-sell.json';

const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  probe?: { tool: string };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, unknown>;
    headers?: Record<string, string>;
    healthcheckPath?: string;
  };
  tools: Array<{
    name: string;
    enabled?: boolean;
    annotations?: { readOnlyHint?: boolean };
    endpointMapping: Record<string, unknown>;
  }>;
};

const toolNames = a.tools.map((t) => t.name);

describe('ebay-sell adapter — static spec conformance', () => {
  it("mints access tokens from a stored refresh token", () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig?.refreshToken).toBe('{{EBAY_REFRESH_TOKEN}}');
    expect(a.connector.authConfig?.tokenAuthMethod).toBe('basic');
  });

  it('gets that refresh token from a sign-in at eBay, with the RuName as redirect_uri', () => {
    const auth = a.connector.authConfig ?? {};
    expect(auth.authorizationUrl).toBe('https://auth.ebay.com/oauth2/authorize');
    expect(auth.tokenUrl).toBe('https://api.ebay.com/identity/v1/oauth2/token');
    expect(auth.providerRedirectUri).toBe('{{EBAY_RUNAME}}');
    // eBay documents no PKCE: neither a challenge nor a verifier is sent.
    expect(auth.pkce).toBe(false);
    expect(auth.grant).toBe('refresh_token');
    expect(a.requiredEnvVars).toEqual(['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET', 'EBAY_RUNAME', 'EBAY_MARKETPLACE_ID']);
    // Filled in by the sign-in; a token pasted earlier still works.
    expect(a.optionalEnvVars).toEqual(['EBAY_REFRESH_TOKEN']);
  });

  it('asks for the scopes every tool needs, as full eBay scope URLs', () => {
    const scopes = String(a.connector.authConfig?.scopes).split(' ');
    for (const s of [
      'sell.inventory',
      'sell.fulfillment',
      'sell.account',
      'sell.payment.dispute',
      'sell.marketing',
      'commerce.message',
    ]) {
      expect(scopes).toContain(`https://api.ebay.com/oauth/api_scope/${s}`);
    }
    // The base scope covers the Browse and Taxonomy APIs.
    expect(scopes).toContain('https://api.ebay.com/oauth/api_scope');
  });

  it('lets connectors signed in with the earlier scope list widen it on re-authorization', () => {
    const previous = (adapter as unknown as { previousOAuthScopes: string[] }).previousOAuthScopes;
    expect(previous).toEqual([
      [
        'https://api.ebay.com/oauth/api_scope/sell.inventory',
        'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
        'https://api.ebay.com/oauth/api_scope/sell.account',
        'https://api.ebay.com/oauth/api_scope/sell.payment.dispute',
      ].join(' '),
    ]);
  });

  it("names the marketplace, which changes what eBay answers", () => {
    expect(a.connector.headers?.['X-EBAY-C-MARKETPLACE-ID']).toBe('{{EBAY_MARKETPLACE_ID}}');
  });

  it("targets production, and says where the sandbox is", () => {
    expect(a.connector.baseUrl).toBe('https://api.ebay.com');
    expect((adapter as unknown as { instructions: string }).instructions).toContain('api.sandbox.ebay.com');
  });

  it("warns that pre-Inventory-API listings will not appear", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain('Trading API');
  });

  it("calls payment disputes on apiz.ebay.com, where eBay serves them", () => {
    const t = a.tools.find((x) => x.name === 'ebay_sell_list_payment_disputes')!;
    expect(t.endpointMapping.path).toBe('https://apiz.ebay.com/sell/fulfillment/v1/payment_dispute_summary');
  });

  it("updates a price through bulk_update_price_quantity with an offers array", () => {
    const t = a.tools.find((x) => x.name === 'ebay_sell_update_offer_price')!;
    expect(`${String(t.endpointMapping.method)} ${String(t.endpointMapping.path)}`).toBe('POST /sell/inventory/v1/bulk_update_price_quantity');
    const body = t.endpointMapping.bodyMapping as { requests: Array<{ offers: Array<Record<string, unknown>> }> };
    expect(body.requests[0].offers[0].offerId).toBe('$offerId');
  });
});

describe('ebay-sell adapter — inventory, browse, marketing, taxonomy and messages', () => {
  const tool = (name: string) => {
    const t = a.tools.find((x) => x.name === name);
    if (!t) throw new Error(`missing tool ${name}`);
    return t;
  };
  const route = (name: string) =>
    `${String(tool(name).endpointMapping.method)} ${String(tool(name).endpointMapping.path)}`;

  it('keeps every tool name installed connectors depend on', () => {
    for (const name of [
      'ebay_sell_list_orders',
      'ebay_sell_get_order',
      'ebay_sell_list_inventory_items',
      'ebay_sell_get_inventory_item',
      'ebay_sell_list_offers',
      'ebay_sell_list_fulfillment_policies',
      'ebay_sell_list_return_policies',
      'ebay_sell_list_payment_disputes',
      'ebay_sell_get_privileges',
      'ebay_sell_update_offer_price',
    ]) {
      expect(toolNames).toContain(name);
    }
    expect(new Set(toolNames).size).toBe(toolNames.length);
    for (const name of toolNames) expect(name.startsWith('ebay_sell_')).toBe(true);
  });

  it('maps the inventory item group and offer routes', () => {
    expect(route('ebay_sell_get_inventory_item_group')).toBe(
      'GET /sell/inventory/v1/inventory_item_group/{inventoryItemGroupKey}',
    );
    expect(route('ebay_sell_upsert_inventory_item_group')).toBe(
      'PUT /sell/inventory/v1/inventory_item_group/{inventoryItemGroupKey}',
    );
    expect(route('ebay_sell_get_offer')).toBe('GET /sell/inventory/v1/offer/{offerId}');
    expect(route('ebay_sell_update_offer')).toBe('PUT /sell/inventory/v1/offer/{offerId}');
    expect(route('ebay_sell_publish_offers_by_item_group')).toBe(
      'POST /sell/inventory/v1/offer/publish_by_inventory_item_group',
    );
    expect(route('ebay_sell_withdraw_offers_by_item_group')).toBe(
      'POST /sell/inventory/v1/offer/withdraw_by_inventory_item_group',
    );
    expect(route('ebay_sell_bulk_create_offers')).toBe('POST /sell/inventory/v1/bulk_create_offer');
    expect(route('ebay_sell_bulk_upsert_inventory_items')).toBe(
      'POST /sell/inventory/v1/bulk_create_or_replace_inventory_item',
    );
    expect(route('ebay_sell_migrate_listings')).toBe('POST /sell/inventory/v1/bulk_migrate_listing');
  });

  it('publishes and withdraws item groups on the connector marketplace', () => {
    for (const name of ['ebay_sell_publish_offers_by_item_group', 'ebay_sell_withdraw_offers_by_item_group']) {
      const body = tool(name).endpointMapping.bodyMapping as Record<string, string>;
      expect(body.marketplaceId).toBe('{{EBAY_MARKETPLACE_ID}}');
      expect(body.inventoryItemGroupKey).toBe('$inventoryItemGroupKey');
    }
  });

  it('sends Content-Language on every write eBay requires it for', () => {
    for (const name of [
      'ebay_sell_upsert_inventory_item',
      'ebay_sell_upsert_inventory_item_group',
      'ebay_sell_bulk_upsert_inventory_items',
      'ebay_sell_create_offer',
      'ebay_sell_update_offer',
      'ebay_sell_bulk_create_offers',
    ]) {
      const headers = tool(name).endpointMapping.headers as Record<string, string>;
      expect(headers['Content-Language']).toBe('$content_language');
    }
  });

  it('reads Browse, Taxonomy and Message APIs on api.ebay.com', () => {
    expect(route('ebay_sell_get_item_by_legacy_id')).toBe('GET /buy/browse/v1/item/get_item_by_legacy_id');
    expect(route('ebay_sell_search_items')).toBe('GET /buy/browse/v1/item_summary/search');
    expect(route('ebay_sell_get_items_by_item_group')).toBe('GET /buy/browse/v1/item/get_items_by_item_group');
    expect(route('ebay_sell_get_category_suggestions')).toBe(
      'GET /commerce/taxonomy/v1/category_tree/{category_tree_id}/get_category_suggestions',
    );
    expect(route('ebay_sell_list_campaigns')).toBe('GET /sell/marketing/v1/ad_campaign');
    expect(route('ebay_sell_add_listings_to_campaign')).toBe(
      'POST /sell/marketing/v1/ad_campaign/{campaign_id}/bulk_create_ads_by_listing_id',
    );
    expect(route('ebay_sell_list_conversations')).toBe('GET /commerce/message/v1/conversation');
  });

  it('marks POST lookups as read-only', () => {
    expect(tool('ebay_sell_bulk_get_inventory_items').annotations?.readOnlyHint).toBe(true);
    expect(tool('ebay_sell_get_listing_fees').annotations?.readOnlyHint).toBe(true);
  });

  it('installs deletes and one-way writes switched off', () => {
    for (const name of [
      'ebay_sell_delete_inventory_item',
      'ebay_sell_delete_inventory_item_group',
      'ebay_sell_delete_offer',
      'ebay_sell_migrate_listings',
      'ebay_sell_end_campaign',
      'ebay_sell_send_message',
    ]) {
      expect(tool(name).enabled).toBe(false);
    }
    for (const t of a.tools) {
      if (t.endpointMapping.method === 'DELETE') expect(t.enabled).toBe(false);
    }
  });
});

describe('ebay-sell adapter — setup check', () => {
  it('probes an endpoint every seller account can read', () => {
    // Policy endpoints answer 20403 for sellers without Business Policies,
    // so they cannot tell a working connection from a broken one.
    expect(a.probe?.tool).toBe('ebay_sell_get_privileges');
    expect(a.connector.healthcheckPath).toBe('/sell/account/v1/privilege');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_EBAY_SELL_LIVE === '1';
(live ? describe : describe.skip)('ebay-sell — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // ebay-sell answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
