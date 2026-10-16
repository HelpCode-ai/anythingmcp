import * as weclapp from './weclapp.json';

/**
 * About 50 calls across 10 workspaces failed with 400 "unknown property" in
 * the ten days to 14 Oct 2026: the model guessed names in `properties`. The
 * list tools now say to leave it empty and list the names that exist (taken
 * from weclapp's API v2 OpenAPI file, https://www.weclapp.com/api/openapi_v2.yaml).
 */
describe('weclapp adapter: the properties parameter of the list tools', () => {
  const tools = (weclapp as unknown as {
    tools: Array<{ name: string; parameters: { properties: Record<string, { description?: string }> } }>;
  }).tools;
  const listTools = tools.filter((t) => t.parameters?.properties?.properties);

  /** The names a description offers as valid, from its "Valid … fields" sentence. */
  function validNames(description: string): string[] {
    const m = description.match(/fields \(weclapp API v2\): ([^.]+)\./);
    return m ? m[1].split(',').map((s) => s.trim()) : [];
  }

  it('tells the model to leave it empty on every list tool', () => {
    expect(listTools.length).toBeGreaterThanOrEqual(8);
    for (const t of listTools) {
      expect(`${t.name}: ${t.parameters.properties.properties.description}`).toMatch(
        /: Leave empty \(the default\)/,
      );
    }
  });

  it.each([
    ['weclapp_list_sales_orders', ['customerNumber', 'salesOrderItems', 'shippingAddress', 'shippingCarrierId', 'currencyId', 'quotationNumber']],
    ['weclapp_list_invoices', ['customerNumber', 'openAmount', 'paidAmount', 'createdById', 'recordCurrencyName', 'salesOrderNumber']],
    ['weclapp_list_customers', ['city', 'mobilePhone', 'paymentMethodId', 'salesChannel']],
    ['weclapp_list_articles', ['unitName', 'stockQuantity', 'availableQuantity', 'descriptionFixed']],
    ['weclapp_list_quotations', ['validUntil', 'publicPageUrl', 'contactId', 'customerContactId']],
    ['weclapp_list_opportunities', ['expectedCloseDate', 'salesStage', 'expectedValue']],
  ])('%s lists real fields and none of the names guessed wrong in production', (name, guessed) => {
    const tool = tools.find((t) => t.name === name)!;
    const description = tool.parameters.properties.properties.description!;
    const valid = validNames(description);
    expect(valid.length).toBeGreaterThan(20);
    expect(valid).toContain('id');
    for (const g of guessed) {
      expect(valid).not.toContain(g);
      // ...and the description says what to use instead.
      expect(description).toContain(g);
    }
  });
});
