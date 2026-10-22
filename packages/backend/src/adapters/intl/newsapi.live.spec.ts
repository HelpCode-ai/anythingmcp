import * as adapter from './newsapi.json';
import { pickProbe } from '../probe.util';

const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: { headerName: string } };
  probe?: { tool: string; params?: Record<string, unknown> };
  tools: Array<{ name: string; endpointMapping: { method: string; path: string }; parameters: object }>;
};
describe('newsapi adapter — static spec conformance', () => {
  it('newsapi.org/v2 base URL', () =>
    expect(a.connector.baseUrl).toBe('https://newsapi.org/v2'));
  it('X-Api-Key header auth', () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('X-Api-Key');
  });

  /**
   * Without a declared probe the setup check fell back to the first GET with
   * no required parameter, newsapi_everything, which NewsAPI answers with 400
   * parametersMissing when it gets no q, sources or domains: a valid key was
   * reported as a failed setup (22 Oct 2026). The sources list needs nothing.
   */
  it('verifies the key with the sources list, which needs no parameter', () => {
    const probe = pickProbe(a as any);
    expect(probe?.toolName).toBe('newsapi_sources');
    const tool = a.tools.find((t) => t.name === probe!.toolName)!;
    expect(tool.endpointMapping).toMatchObject({ method: 'GET', path: '/top-headlines/sources' });
  });
});
