import * as adapter from './youtube-data.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  envVarMeta: Record<string, { pattern: string }>;
};
describe('youtube-data adapter — static spec conformance', () => {
  it('googleapis.com/youtube/v3', () => expect(a.connector.baseUrl).toBe('https://www.googleapis.com/youtube/v3'));
  it('QUERY_AUTH with key', () => {
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig.key).toBe('{{YOUTUBE_API_KEY}}');
  });
  // 7 of 8 YouTube setups in the first week of Nov 2026 stopped at "API key
  // not valid": the form now refuses the Google credentials that are not API keys.
  it('refuses the OAuth client ID, client secret and access token, not an API key', () => {
    const pattern = new RegExp(a.envVarMeta.YOUTUBE_API_KEY.pattern);
    const key = ['AIza', 'Sy', 'x'.repeat(33)].join('');
    expect(pattern.test(key)).toBe(true);
    expect(pattern.test('GOCSPX-' + 'a'.repeat(28))).toBe(false);
    expect(pattern.test('123456789012-' + 'a'.repeat(32) + '.apps.googleusercontent.com')).toBe(false);
    expect(pattern.test('ya29.' + 'a'.repeat(40))).toBe(false);
    expect(pattern.test('AIza with spaces ' + 'a'.repeat(20))).toBe(false);
  });
});
