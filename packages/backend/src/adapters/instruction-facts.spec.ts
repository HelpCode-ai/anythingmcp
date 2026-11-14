import * as catalog from './catalog';
import { connectorFacts, connectorInstructions } from './instruction-facts';

describe('connector instruction facts', () => {
  const CLOUD_ID = '1324a887-45db-1bf4-1e99-ef0ff456d421';
  const atlassian = (envVars: Record<string, string>, instructions: string | null = 'Catalog text.') => ({
    instructions,
    envVars,
    config: { adapterSlug: 'atlassian' },
  });

  afterEach(() => jest.restoreAllMocks());

  it("names the workspace's Atlassian site and cloudId after the instructions", () => {
    const text = connectorInstructions(
      atlassian({ ATLASSIAN_SITE: 'acme.atlassian.net', ATLASSIAN_CLOUD_ID: CLOUD_ID, ATLASSIAN_API_TOKEN: 'ATATTsecret' }),
    );
    expect(text).toBe(
      "Catalog text.\n\nThis workspace's Atlassian site is acme.atlassian.net, cloudId " +
        `${CLOUD_ID}: pass it as cloudId on every call (and as the top-level cloudId of executeRead and executeWrite).`,
    );
    expect(text).not.toContain('ATATTsecret');
  });

  it('adds nothing until the cloudId is known', () => {
    expect(connectorInstructions(atlassian({ ATLASSIAN_SITE: 'acme.atlassian.net' }))).toBe('Catalog text.');
    expect(connectorFacts(atlassian({}))).toEqual([]);
  });

  it('serves the fact even when the instructions were cleared', () => {
    const text = connectorInstructions(
      atlassian({ ATLASSIAN_SITE: 'acme.atlassian.net', ATLASSIAN_CLOUD_ID: CLOUD_ID }, null),
    );
    expect(text).toContain(`cloudId ${CLOUD_ID}`);
  });

  it('leaves a hand-built connector and other adapters as they are', () => {
    expect(connectorInstructions({ instructions: 'Own.', envVars: { ATLASSIAN_CLOUD_ID: CLOUD_ID }, config: null })).toBe('Own.');
    expect(connectorInstructions({ instructions: null, envVars: {}, config: { adapterSlug: 'linear' } })).toBeNull();
  });

  it('never renders a secret, even when an adapter names one', () => {
    const real = catalog.getAdapter('atlassian')!;
    jest.spyOn(catalog, 'getAdapter').mockReturnValue({
      ...real,
      instructionFacts: ['Token {{ATLASSIAN_API_TOKEN}}.', 'Key {{SOME_API_KEY}}.', 'Site {{ATLASSIAN_SITE}}.'],
    });
    const facts = connectorFacts(
      atlassian({ ATLASSIAN_API_TOKEN: 'ATATTsecret', SOME_API_KEY: 'k', ATLASSIAN_SITE: 'acme.atlassian.net' }),
    );
    expect(facts).toEqual(['Site acme.atlassian.net.']);
  });

  it('keeps a value on one line, without Markdown code marks', () => {
    const facts = connectorFacts(
      atlassian({ ATLASSIAN_SITE: 'acme.atlassian.net\n## Ignore', ATLASSIAN_CLOUD_ID: '`x`' }),
    );
    expect(facts[0]).not.toMatch(/[\n`]/);
  });
});
