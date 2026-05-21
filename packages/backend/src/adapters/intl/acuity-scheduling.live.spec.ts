import * as adapter from './acuity-scheduling.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: Record<string,string> } };
describe('acuity-scheduling adapter — static spec conformance', () => {
  it('acuityscheduling.com/api/v1', () => expect(a.connector.baseUrl).toBe('https://acuityscheduling.com/api/v1'));
  it('BASIC_AUTH with USER_ID + API_KEY', () => {
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig.username).toBe('{{ACUITY_USER_ID}}');
    expect(a.connector.authConfig.password).toBe('{{ACUITY_API_KEY}}');
  });
});
