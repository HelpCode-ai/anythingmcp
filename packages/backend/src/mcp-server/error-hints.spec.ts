import { deriveErrorHint, hostFromAxiosConfig } from './error-hints';

describe('deriveErrorHint', () => {
  it('says nothing for an ordinary failure', () => {
    expect(
      deriveErrorHint({ host: 'api.example.com', status: 500, body: { message: 'boom' } }),
    ).toBeUndefined();
  });

  describe('weclapp', () => {
    it('explains unknown properties instead of letting the model guess spellings', () => {
      const hint = deriveErrorHint({
        host: 'purora.weclapp.com',
        status: 400,
        body: { detail: 'unknown property: orderItems.articleNumber', status: 400 },
      });
      expect(hint).toMatch(/fetch ONE record/);
      expect(hint).toMatch(/orderItems/);
    });

    it('names the right field for the spellings seen guessed in production', () => {
      const hint = deriveErrorHint({ host: 'x.weclapp.com', status: 400, body: { detail: 'unknown property: shippingAddress' } });
      expect(hint).toMatch(/`deliveryAddress` \(not `shippingAddress`\)/);
      expect(hint).toMatch(/`unitId` \(not `unitName`\)/);
    });

    it('treats "unexpected filter property" the same way', () => {
      expect(
        deriveErrorHint({ host: 'x.weclapp.com', body: 'unexpected filter property' }),
      ).toMatch(/fetch ONE record/);
    });

    it('teaches the expression grammar when weclapp cannot parse the filter', () => {
      const hint = deriveErrorHint({
        host: 'purora.weclapp.com',
        status: 400,
        body: { detail: 'Expression contains errors' },
      });
      expect(hint).toMatch(/~ "%pattern%"/);
      expect(hint).toMatch(/like\/ilike do not exist/);
    });

    it('applies to hand-built tools on the same host, not only catalog ones', () => {
      expect(
        deriveErrorHint({ host: 'tenant.weclapp.com', body: 'unknown property: x' }),
      ).toBeDefined();
    });

    it('does not fire for another vendor that happens to say "unknown property"', () => {
      expect(
        deriveErrorHint({ host: 'api.other.com', body: 'unknown property: x' }),
      ).toBeUndefined();
    });
  });

  describe('login refused from a new country', () => {
    it('tells the model to hand over to the user, regardless of host', () => {
      const hint = deriveErrorHint({
        message: 'LOGIN_TOKEN: the service refused the login — authenticate_from_new_country',
      });
      expect(hint).toMatch(/confirm the login/);
      expect(hint).toMatch(/cannot be fixed by retrying/);
    });
  });
});

describe('hostFromAxiosConfig', () => {
  it('reads an absolute url', () => {
    expect(hostFromAxiosConfig({ url: 'https://a.weclapp.com/webapp/api/v2/article' })).toBe('a.weclapp.com');
  });

  it('combines a relative url with the baseURL', () => {
    expect(hostFromAxiosConfig({ baseURL: 'https://b.weclapp.com/webapp/api/v2', url: '/article' })).toBe('b.weclapp.com');
  });

  it('is undefined without a config', () => {
    expect(hostFromAxiosConfig(undefined)).toBeUndefined();
  });
});

describe('deriveErrorHint — SQL-backed customer APIs', () => {
  // Real failures from a customer connector on 2026-09-16: 16 errors in 155
  // calls, every one of them the model inventing filter grammar.
  it('names the boolean when SQL read a filter value as a column', () => {
    const hint = deriveErrorHint({
      status: 400,
      body: { message: 'Ungültiger Spaltenname "false".', error: 'Bad Request' },
    });
    expect(hint).toMatch(/Booleans are the usual culprit/);
  });

  it('answers the English phrasing of the same error', () => {
    const hint = deriveErrorHint({
      status: 400,
      body: { message: "Invalid column name 'false'." },
    });
    expect(hint).toMatch(/was not quoted/);
  });

  it('tells the model that a parenthesised IN list is the problem, not the value', () => {
    const hint = deriveErrorHint({
      status: 400,
      body: {
        message:
          'Falsche Syntax in der Nähe von ")".\r\nUngültige Verwendung der Option NEXT in der FETCH-Anweisung.',
      },
    });
    expect(hint).toMatch(/one call per value/);
  });

  it('tells the model to drop the field list rather than permute spellings', () => {
    const hint = deriveErrorHint({
      status: 400,
      body: { message: 'Invalid field in selected fields: exit_date' },
    });
    expect(hint).toMatch(/`fields` omitted/);
  });

  // Jev answers `type: "bool"` (and a top-level field it does not know) with a
  // bare "Invalid request." that names neither the question nor the field.
  it('spells out the Jev question shapes when TypeSafe says only "Invalid request."', () => {
    const hint = deriveErrorHint({
      host: 'api.typesafe.ai',
      status: 400,
      body: { detail: { error_type: 'api_usage_error', message: 'Invalid request.' } },
    });
    expect(hint).toMatch(/there is no "bool"/);
    expect(
      deriveErrorHint({ host: 'api.example.com', status: 400, body: { message: 'Invalid request.' } }),
    ).toBeUndefined();
  });

  it('tells the user to install the Shopify app when the token answers app_not_installed', () => {
    const hint = deriveErrorHint({
      host: 'acme.myshopify.com',
      status: 400,
      message: 'Request failed with status code 400',
      body: '<title>400 - Oauth error app_not_installed</title>',
    });
    expect(hint).toMatch(/Install app/);
    expect(deriveErrorHint({ host: 'example.com', status: 400, body: 'app_not_installed' })).toBeUndefined();
  });

  it('sends the Shopify owner to protected customer data access', () => {
    const hint = deriveErrorHint({
      host: 'acme.myshopify.com',
      status: 200,
      message: 'GraphQL errors: [{"message":"This app is not approved to access the Customer object."}]',
    });
    expect(hint).toMatch(/API access requests/);
  });

  it('points an account-level Printful token at store_id', () => {
    const hint = deriveErrorHint({
      host: 'api.printful.com',
      status: 400,
      body: { code: 400, result: 'This endpoint requires `store_id`!' },
    });
    expect(hint).toMatch(/printful_list_stores/);
  });

  it('still says nothing about an error it does not recognise', () => {
    expect(deriveErrorHint({ status: 500, body: { message: 'boom' } })).toBeUndefined();
  });

  describe('Telegram', () => {
    const host = 'api.telegram.org';
    it('points at the bot token on a 404 Not Found', () => {
      expect(
        deriveErrorHint({ host, status: 404, body: { ok: false, error_code: 404, description: 'Not Found' } }),
      ).toMatch(/TELEGRAM_BOT_TOKEN/);
    });
    it('explains how a bot reaches a chat', () => {
      expect(
        deriveErrorHint({ host, status: 400, body: { description: 'Bad Request: chat not found' } }),
      ).toMatch(/pressed Start/);
      expect(
        deriveErrorHint({ host, status: 403, body: { description: "Forbidden: bot can't initiate conversation with a user" } }),
      ).toMatch(/pressed Start/);
    });
    it('gives the new id when a group became a supergroup', () => {
      expect(
        deriveErrorHint({
          host,
          status: 400,
          body: { description: 'Bad Request: group chat was upgraded to a supergroup chat', parameters: { migrate_to_chat_id: -1004376396847 } },
        }),
      ).toMatch(/migrate_to_chat_id/);
    });
    it('explains a photo URL Telegram could not fetch', () => {
      expect(
        deriveErrorHint({ host, status: 400, body: { description: 'Bad Request: failed to get HTTP URL content' } }),
      ).toMatch(/public https link/);
    });
    it('stays quiet for another host answering Not Found', () => {
      expect(deriveErrorHint({ host: 'api.example.com', status: 404, body: '"Not Found"' })).toBeUndefined();
    });
  });

  it('tells the model to split Lexware overdue from other statuses', () => {
    expect(
      deriveErrorHint({
        host: 'api.lexware.io',
        status: 400,
        body: { message: "voucherStatus filter 'overdue' cannot be used in combination with other states" },
      }),
    ).toMatch(/one call with voucherStatus=overdue/);
  });
});
