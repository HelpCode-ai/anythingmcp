import * as adapter from './serply.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/** Live: RUN_SERPLY_LIVE=1 SERPLY_API_KEY=... npx jest src/adapters/intl/serply.live.spec.ts */

type Mapping = { method: string; path: string; queryParams: Record<string, string> };
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Array<{ name: string; endpointMapping: Mapping }>;
};
const tool = (name: string) => a.tools.find((t) => t.name === name)!;

describe('serply adapter - static spec conformance', () => {
  it('api.serply.io base URL', () => expect(a.connector.baseUrl).toBe('https://api.serply.io'));
  it('X-Api-Key header auth', () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('X-Api-Key');
    expect(a.connector.authConfig.apiKey).toBe('{{SERPLY_API_KEY}}');
  });
  it('news is /v1/search with the fixed tbm=nws vertical', () => {
    const m = tool('serply_news').endpointMapping;
    expect(m.path).toBe('/v1/search');
    expect(m.queryParams.tbm).toBe('nws');
  });
  it('scholar is /v1/scholar', () => expect(tool('serply_scholar').endpointMapping.path).toBe('/v1/scholar'));
});

const maybe = process.env.RUN_SERPLY_LIVE ? describe : describe.skip;
maybe('serply adapter - live', () => {
  const engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
  const apiKey = process.env.SERPLY_API_KEY || 'bogus-key-for-edge-validation';
  const hasRealKey = !!process.env.SERPLY_API_KEY;
  const config = { baseUrl: a.connector.baseUrl, authType: 'API_KEY', authConfig: { headerName: 'X-Api-Key', apiKey } };

  it('serply_search reaches Serply and (with a real key) returns results[]', async () => {
    let res: any, err: any;
    try {
      res = await engine.execute(config, tool('serply_search').endpointMapping, { q: 'model context protocol', num: 3 });
    } catch (e) {
      err = e;
    }
    if (hasRealKey) {
      expect(err).toBeUndefined();
      expect(res.results.length).toBeGreaterThan(0);
      expect(res.results[0]).toEqual(expect.objectContaining({ title: expect.any(String), link: expect.any(String) }));
    } else {
      expect(err.response?.status).toBe(401);
    }
  }, 30000);

  (hasRealKey ? it : it.skip)('serply_news returns publisher links in results[]', async () => {
    const res: any = await engine.execute(config, tool('serply_news').endpointMapping, { q: 'open source', num: 3 });
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results[0].link).toMatch(/^https?:\/\//);
  }, 30000);

  (hasRealKey ? it : it.skip)('serply_scholar returns articles[]', async () => {
    const res: any = await engine.execute(config, tool('serply_scholar').endpointMapping, { q: 'attention is all you need', num: 2 });
    expect(res.articles.length).toBeGreaterThan(0);
  }, 30000);
});
