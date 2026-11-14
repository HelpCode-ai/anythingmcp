import * as adapter from './strava.json';

const a = adapter as unknown as {
  slug: string;
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
  };
  tools: Array<{ name: string }>;
};

describe('strava adapter â€” static spec conformance', () => {
  it('uses the Strava API v3 base URL', () => {
    expect(a.connector.baseUrl).toBe('https://www.strava.com/api/v3');
  });

  it('uses OAuth 2.0 authentication', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig.clientId).toBe('{{STRAVA_CLIENT_ID}}');
    expect(a.connector.authConfig.clientSecret).toBe('{{STRAVA_CLIENT_SECRET}}');
    expect(a.connector.authConfig.scopes).toBe('read,activity:read');
  });

  it('contains all seven read-only tools', () => {
    expect(a.tools.map((tool) => tool.name).sort()).toEqual(
      [
        'strava_get_athlete',
        'strava_list_activities',
        'strava_get_activity',
        'strava_list_starred_segments',
        'strava_get_segment',
        'strava_list_routes',
        'strava_get_route',
      ].sort(),
    );
  });
});

const runLive = process.env.RUN_STRAVA_LIVE === '1';

describe('strava adapter â€” live API', () => {
  (runLive ? it : it.skip)('can retrieve the authenticated athlete', async () => {
    const token = process.env.STRAVA_ACCESS_TOKEN;

    if (!token) {
      throw new Error('Set STRAVA_ACCESS_TOKEN to run the live Strava test.');
    }

    const response = await fetch('https://www.strava.com/api/v3/athlete', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    expect(response.status).toBe(200);

    const athlete = await response.json();
    expect(typeof athlete.id).toBe('number');
  });
});
