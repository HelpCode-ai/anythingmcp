import * as adapter from './signwell.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: any } };
describe('signwell adapter — static spec conformance', () => {
  it('signwell.com/api/v1', () => expect(a.connector.baseUrl).toBe('https://www.signwell.com/api/v1'));
  it('X-Api-Key + X-Api-Application extraHeaders', () => {
    expect(a.connector.authConfig.headerName).toBe('X-Api-Key');
    expect(a.connector.authConfig.extraHeaders['X-Api-Application']).toBe('{{SIGNWELL_APPLICATION_ID}}');
  });
});
