import * as adapter from './oddsrelay.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/** Live (spends no tokens): RUN_ODDSRELAY_LIVE=1 ODDSRELAY_KEY=<your key> npx jest src/adapters/gb/oddsrelay.live.spec.ts */

const a = adapter as unknown as {
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    healthcheckPath: string;
  };
  probe: { tool: string };
  tools: Array<{
    name: string;
    parameters: { properties: Record<string, { enum?: string[] }> };
    endpointMapping: { method: string; path: string; queryParams?: Record<string, string> };
    responseMapping?: { transform: { mode: string; expression: string } };
    annotations?: { readOnlyHint?: boolean };
  }>;
};
const tool = (name: string) => a.tools.find((t) => t.name === name)!;

describe('oddsrelay adapter — static spec conformance', () => {
  it('api.oddsrelay.io, /v2 routes', () => expect(a.connector.baseUrl).toBe('https://api.oddsrelay.io'));
  it('Bearer auth', () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig.token).toBe('{{ODDSRELAY_KEY}}');
  });
  it('asks for gzip, which some boards require', () => {
    expect(a.connector.headers['Accept-Encoding']).toBe('gzip');
  });
  it('checks the connection with the usage call, which spends no tokens', () => {
    expect(a.probe.tool).toBe('oddsrelay_get_usage');
    expect(a.connector.healthcheckPath).toBe('/v2/usage');
  });
  it('marks only the two tools that spend tokens as not read-only', () => {
    const spending = a.tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name);
    expect(spending.sort()).toEqual(['oddsrelay_get_board', 'oddsrelay_get_event_odds']);
  });
  // The connector always sends the key, so /v2/coverage answers with its keyed view.
  it('shrinks the keyed coverage reply to bookmaker and sport keys per board', () => {
    const keyed = {
      region: 'uk',
      generated_at: '2026-10-16T12:00:00Z',
      products: {
        standard: {
          bookmakers: [
            { key: 'ladbrokes', name: 'Ladbrokes', sports: { soccer: { events: 12, last_seen: '2026-10-16T11:59:50Z' } } },
          ],
          exchanges: [{ key: 'betfair_exchange', name: 'Betfair Exchange', sports: { soccer: { events: 40, last_seen: null } } }],
        },
      },
    };
    const out = applyResponseTransform(keyed, tool('oddsrelay_get_coverage').responseMapping);
    expect(out.applied).toBe(true);
    expect(out.value).toEqual({
      generated_at: '2026-10-16T12:00:00Z',
      products: { standard: { bookmakers: { ladbrokes: ['soccer'] }, exchanges: { betfair_exchange: ['soccer'] } } },
    });
  });
});

const live = process.env.RUN_ODDSRELAY_LIVE === '1' && !!process.env.ODDSRELAY_KEY;
(live ? describe : describe.skip)('oddsrelay adapter — live, spends no tokens', () => {
  const engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
  const run = async (name: string, params: Record<string, unknown> = {}): Promise<any> => {
    const t = tool(name);
    const raw = await engine.execute(
      {
        baseUrl: a.connector.baseUrl,
        authType: a.connector.authType,
        authConfig: { token: process.env.ODDSRELAY_KEY },
        headers: a.connector.headers,
      },
      t.endpointMapping,
      params,
    );
    return applyResponseTransform(raw, t.responseMapping).value;
  };

  it('usage answers with the balance and the key', async () => {
    const usage = await run('oddsrelay_get_usage');
    expect(usage).toEqual(
      expect.objectContaining({ rate_card: expect.any(String), tokens: expect.any(Object), key: expect.any(Object) }),
    );
  }, 30000);

  it('quotes one board picked from the mapped coverage', async () => {
    const coverage = await run('oddsrelay_get_coverage');
    const boards = tool('oddsrelay_quote_board').parameters.properties.type.enum!;
    const type = boards.find((b) => Object.keys(coverage.products?.[b]?.bookmakers ?? {}).length > 0);
    expect(type).toBeDefined();
    const [bookmaker, sports] = Object.entries(coverage.products[type!].bookmakers as Record<string, string[]>)[0];
    const quote = await run('oddsrelay_quote_board', { type, sport: sports[0], bookmakers: bookmaker });
    expect(quote).toEqual(expect.objectContaining({ cost: expect.any(Number), rate_card: expect.any(String) }));
    expect(quote).toHaveProperty('remaining');
  }, 30000);
});
