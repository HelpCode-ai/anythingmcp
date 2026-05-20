import * as adapter from './youtube-data.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: Record<string,string> } };
describe('youtube-data adapter — static spec conformance', () => {
  it('googleapis.com/youtube/v3', () => expect(a.connector.baseUrl).toBe('https://www.googleapis.com/youtube/v3'));
  it('QUERY_AUTH with key', () => {
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig.key).toBe('{{YOUTUBE_API_KEY}}');
  });
});
