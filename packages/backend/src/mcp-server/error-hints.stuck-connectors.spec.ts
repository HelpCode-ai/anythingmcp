import { deriveErrorHint } from './error-hints';

/**
 * Errors from connectors that failed every call, as they reached production,
 * and the hint each now gets. See error-hints.ts.
 */
describe('deriveErrorHint: stuck-connector errors', () => {
  const gemini = 'generativelanguage.googleapis.com';

  describe('Gemini quota, rate and prepaid credits', () => {
    // Shape of the 429 a project without billing gets from a model with no free tier.
    const noFreeTier = {
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        message:
          'You exceeded your current quota, please check your plan and billing details. \n* Quota exceeded for metric: ' +
          'generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-3.1-pro, ' +
          'description: Generate content input tokens per minute limit exceeded on Free Tier.',
      },
    };

    it('says a model without a free tier needs billing, not a wait', () => {
      const hint = deriveErrorHint({ host: gemini, status: 429, body: noFreeTier })!;
      expect(hint).toMatch(/has no free tier/);
      expect(hint).toMatch(/enable billing/);
      expect(hint).toMatch(/gemini-3\.1-flash-lite/);
      expect(hint).not.toMatch(/Wait for the time/);
    });

    it('treats a 429 with a real limit as a rate limit to wait out', () => {
      const hint = deriveErrorHint({
        host: gemini,
        status: 429,
        body: {
          error: {
            code: 429,
            status: 'RESOURCE_EXHAUSTED',
            message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 15, model: gemini-3.1-flash-lite',
          },
        },
      })!;
      expect(hint).toMatch(/rate limit reached/);
      expect(hint).toMatch(/Wait for the time in the RetryInfo/);
    });

    it('tells depleted prepaid credits from a quota, although both say RESOURCE_EXHAUSTED', () => {
      const hint = deriveErrorHint({
        host: gemini,
        status: 402,
        body: {
          error: {
            code: 402,
            status: 'RESOURCE_EXHAUSTED',
            message: 'Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.',
          },
        },
      })!;
      expect(hint).toMatch(/prepaid credits .* are used up/);
      expect(hint).toMatch(/top up/);
    });
  });

  describe('Odoo JSON-2', () => {
    const noDatabase =
      '<!DOCTYPE html>\n<title>404 Not Found</title>\n<h1>Not Found</h1>\n<p>No database is selected</p>';

    it('points at ODOO_DB and at a path after the host for "No database is selected"', () => {
      const hint = deriveErrorHint({ host: 'erp.example.com', status: 404, body: noDatabase, adapterSlug: 'odoo' })!;
      expect(hint).toMatch(/ODOO_DB/);
      expect(hint).toMatch(/no \/web, no \/odoo/);
    });

    it('tells a key that was not sent apart from an expired one', () => {
      const notSent = deriveErrorHint({
        host: 'erp.example.com',
        status: 401,
        body: { name: 'werkzeug.exceptions.Unauthorized', message: 'User not authenticated, use an API key', arguments: [] },
      })!;
      expect(notSent).toMatch(/received no API key/);
      expect(notSent).toMatch(/Bearer/);
      const expired = deriveErrorHint({ host: 'erp.example.com', status: 401, body: { message: 'Invalid apikey' } })!;
      expect(expired).toMatch(/API keys expire/);
    });

    it('links the connector page after a credential hint', () => {
      const hint = deriveErrorHint({
        host: 'erp.example.com',
        status: 404,
        body: noDatabase,
        connectorPage: 'https://cloud.example.com/connectors/c1',
      })!;
      expect(hint.endsWith("The connector's settings are at https://cloud.example.com/connectors/c1")).toBe(true);
    });
  });

  it('says an Etsy account without a shop has to be swapped for the shop owner', () => {
    const hint = deriveErrorHint({
      host: 'openapi.etsy.com',
      status: 404,
      body: { error: 'Could not find a shop for User with user_id = 123' },
    })!;
    expect(hint).toMatch(/has no shop/);
    expect(hint).toMatch(/Authorize with Provider/);
  });

  it('explains Zoho CRM refusing API access by edition or profile', () => {
    const hint = deriveErrorHint({
      host: 'www.zohoapis.eu',
      status: 403,
      body: { code: 'NO_PERMISSION', details: { permissions: ['Crm_Implied_Api_Access'] }, message: 'permission denied', status: 'error' },
    })!;
    expect(hint).toMatch(/Free edition has no API access/);
    expect(hint).toMatch(/API Access/);
  });

  describe('Bitrix24 webhook URL', () => {
    const page = '<!DOCTYPE html><html><head><title>404 Not Found</title></head></html>';

    it('reads an HTML 404 as a URL that is not an inbound webhook', () => {
      expect(deriveErrorHint({ host: 'acme.bitrix24.com', status: 404, body: page })).toMatch(/\/rest\/<user_id>\/<code>\//);
      // A Bitrix24 box on its own domain, known from the adapter.
      expect(deriveErrorHint({ host: 'crm.acme.example', status: 404, body: page, adapterSlug: 'bitrix24' })).toMatch(
        /Inbound webhook/,
      );
    });

    it('leaves a JSON 404 of a real webhook alone', () => {
      expect(
        deriveErrorHint({
          host: 'acme.bitrix24.com',
          status: 404,
          body: { error: 'ERROR_METHOD_NOT_FOUND', error_description: 'Method not found!' },
        }),
      ).toBeUndefined();
    });
  });

  it('explains the Companies House key refusal', () => {
    const hint = deriveErrorHint({
      host: 'api.company-information.service.gov.uk',
      status: 400,
      body: { error: 'Invalid Authorization header', type: 'ch:service' },
    })!;
    expect(hint).toMatch(/REST API key \(not a streaming key\)/);
    expect(hint).toMatch(/Live application/);
  });

  it('explains a Google API key refusal outside Gemini (YouTube Data), with the connector page', () => {
    const hint = deriveErrorHint({
      host: 'www.googleapis.com',
      status: 400,
      body: { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } },
      connectorPage: 'https://cloud.example.com/connectors/yt',
    })!;
    expect(hint).toMatch(/APIs & Services → Credentials/);
    expect(hint).toContain('https://cloud.example.com/connectors/yt');
  });

  describe('on-premises APIs', () => {
    const aborted = 'Could not reach the API: the request was aborted before the API responded (ECONNABORTED).';

    it('tells a Cloud user to publish the host or self-host', () => {
      const hint = deriveErrorHint({ message: aborted, adapterSlug: 'tallyprime', cloud: true })!;
      expect(hint).toMatch(/TALLY_URL must be an address reachable from the internet/);
      expect(hint).toMatch(/Cloudflare Tunnel/);
      expect(hint).toMatch(/self-hosted/);
    });

    it('tells a self-hosted user to check the network path', () => {
      const hint = deriveErrorHint({ message: aborted, adapterSlug: 'jtl-wawi', cloud: false })!;
      expect(hint).toMatch(/This AnythingMCP server must reach JTL_WAWI_URL/);
      expect(hint).not.toMatch(/Cloudflare/);
    });

    it('reads an ngrok error page as a tunnel that is offline', () => {
      const hint = deriveErrorHint({
        status: 404,
        body: '<!DOCTYPE html><html><head><link rel="preload" href="https://assets.ngrok.com/fonts/x.woff2"></head></html>',
        adapterSlug: 'tallyprime',
      })!;
      expect(hint).toMatch(/tunnel is offline/);
    });

    it('says nothing for other adapters', () => {
      expect(deriveErrorHint({ message: aborted, adapterSlug: 'weclapp', cloud: true })).toBeUndefined();
    });
  });

  describe("the adapter's own verifyHints at call time", () => {
    const verifyHints = { '401': 'Copy the token again from the vendor dashboard.' };

    it('repeats the setup advice for a 401 no rule covers, with the connector page', () => {
      const hint = deriveErrorHint({
        host: 'api.vendor.example',
        status: 401,
        body: { message: 'unauthorized' },
        verifyHints,
        connectorPage: 'https://cloud.example.com/connectors/c9',
      });
      expect(hint).toBe(
        "The API refused the connector's credentials (401). Copy the token again from the vendor dashboard. Retrying will not help. " +
          "The connector's settings are at https://cloud.example.com/connectors/c9",
      );
    });

    it('falls back to auth_failed and reads the object form', () => {
      expect(deriveErrorHint({ status: 401, verifyHints: { auth_failed: { hint: 'Paste the key again.' } } })).toMatch(
        /Paste the key again\./,
      );
    });

    it('leaves other statuses and a matching rule alone', () => {
      expect(deriveErrorHint({ status: 404, verifyHints: { '404': 'x' } })).toBeUndefined();
      // Telegram has its own rule; the adapter's hint does not replace it.
      expect(
        deriveErrorHint({ host: 'api.telegram.org', status: 401, body: { description: 'Unauthorized' }, verifyHints }),
      ).toMatch(/@BotFather/);
    });
  });

  describe('WooCommerce 401s', () => {
    const page = 'https://cloud.example.com/connectors/c7';
    const verifyHints = { '401': 'WooCommerce refused the key.' };

    it('reads woocommerce_rest_cannot_view as a user who may not see the data (377 of 384 refusals)', () => {
      const hint = deriveErrorHint({
        status: 401,
        body: { code: 'woocommerce_rest_cannot_view', message: 'Sorry, you cannot list resources.', data: { status: 401 } },
        adapterSlug: 'woocommerce',
        verifyHints,
        connectorPage: page,
      })!;
      expect(hint).toMatch(/administrator or shop manager/);
      expect(hint).toMatch(/does not know it runs on https/);
      expect(hint).toMatch(/Retrying will not help\./);
      expect(hint.endsWith(`The connector's settings are at ${page}`)).toBe(true);
    });

    it('reads an unknown consumer key as a key from elsewhere', () => {
      const hint = deriveErrorHint({
        status: 401,
        body: { code: 'woocommerce_rest_authentication_error', message: 'Consumer key is invalid.' },
        adapterSlug: 'woocommerce',
        verifyHints,
      })!;
      expect(hint).toMatch(/does not know this key/);
    });

    it('keeps the adapter advice for another 401, and leaves other adapters alone', () => {
      expect(deriveErrorHint({ status: 401, body: 'Unauthorized', adapterSlug: 'woocommerce', verifyHints })).toMatch(
        /WooCommerce refused the key\./,
      );
      expect(
        deriveErrorHint({ status: 401, body: { code: 'woocommerce_rest_cannot_view' }, adapterSlug: 'wordpress' }),
      ).toBeUndefined();
    });
  });

  describe("Atlassian's Rovo MCP server with an API token", () => {
    const page = 'https://app.example.test/connectors/c1';
    const unscoped =
      'Unable to resolve user scopes from the user-context token for "getJiraIssue". The session token is ' +
      'missing the scope claim required to authorize this operation.';

    it('tells a token without scopes to be replaced by one with scopes, not re-authorized', () => {
      const hint = deriveErrorHint({ adapterSlug: 'atlassian', message: unscoped, connectorPage: page })!;
      expect(hint).toMatch(/has no scopes/);
      expect(hint).toMatch(/API token with scopes/);
      expect(hint).toMatch(/read:jira:agent-interface/);
      expect(hint).not.toMatch(/Authorize with Provider/);
      expect(hint).toContain(page);
    });

    it('explains invalid_token and a 401 as the email and token not belonging together', () => {
      for (const input of [
        { message: 'Error POSTing to endpoint: {"error":"invalid_token"}' },
        { status: 401, message: 'Unauthorized' },
      ]) {
        const hint = deriveErrorHint({ adapterSlug: 'atlassian', connectorPage: page, ...input })!;
        expect(hint).toMatch(/Atlassian refused the email and token together/);
        expect(hint).toMatch(/pasted once/);
        expect(hint).toMatch(/Rovo MCP server settings/);
        expect(hint).toContain(page);
      }
    });

    it('keeps the OAuth advice for a missing scope on other connectors', () => {
      expect(deriveErrorHint({ message: 'insufficient_scope', status: 403 })).toMatch(/Authorize with Provider/);
      expect(
        deriveErrorHint({ host: 'mcp.atlassian.com', message: 'Error POSTing to endpoint: {"error":"invalid_token"}' }),
      ).toBeUndefined();
    });
  });
});
