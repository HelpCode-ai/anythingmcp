import * as adapter from './bitrix24.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string };
  tools: Array<{ endpointMapping: { bodyEncoding?: string } }>;
};
describe('bitrix24 adapter — static spec conformance', () => {
  it('per-tenant webhook URL placeholder', () =>
    expect(a.connector.baseUrl).toBe('{{BITRIX24_WEBHOOK_URL}}'));
  it('no header auth (URL contains the secret webhook code)', () =>
    expect(a.connector.authType).toBe('NONE'));
  it('every typed tool uses form-urlencoded body', () => {
    for (const t of a.tools) expect(t.endpointMapping.bodyEncoding).toBe('form-urlencoded');
  });
});
