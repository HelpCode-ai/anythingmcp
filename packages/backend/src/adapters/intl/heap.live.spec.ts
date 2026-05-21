import * as adapter from './heap.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string } };
describe('heap adapter — static spec conformance', () => {
  it('heapanalytics.com/api', () => expect(a.connector.baseUrl).toBe('https://heapanalytics.com/api'));
  it('NONE auth (app_id is in request body, not header)', () => expect(a.connector.authType).toBe('NONE'));
});
