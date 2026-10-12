import { deriveErrorHint, hostFromAxiosConfig } from './error-hints';

describe('deriveErrorHint', () => {
  it('says nothing for an ordinary failure', () => {
    expect(
      deriveErrorHint({ host: 'api.example.com', status: 500, body: { message: 'boom' } }),
    ).toBeUndefined();
  });

  it('tells the model to have the connector re-authorized when a scope is missing', () => {
    const hint = deriveErrorHint({
      host: 'openapi.etsy.com',
      status: 403,
      body: { error: 'Access token lacks scope for this request (requires scope: listings_w).' },
    });
    expect(hint).toMatch(/Authorize with Provider/);
    expect(deriveErrorHint({ status: 403, body: { error: 'insufficient_scope' } })).toMatch(/Authorize/);
  });

  it('sends the model to the field list on an unknown Odoo field or model', () => {
    const field = deriveErrorHint({
      host: 'acme.odoo.com',
      status: 500,
      body: { name: 'builtins.ValueError', message: "Invalid field 'expense_policy' on 'product.product'" },
    });
    expect(field).toMatch(/fields_get/);
    expect(
      deriveErrorHint({ message: "JSON-RPC error 200: Odoo Server Error: Invalid field sale.order.commercial_partner_id in leaf ('x')" }),
    ).toMatch(/fields_get/);
    expect(
      deriveErrorHint({ message: "JSON-RPC error 200: Odoo Server Error: Object stock.production.lot doesn't exist" }),
    ).toMatch(/stock\.lot/);
  });

  it('names phone when Odoo 18.3+ refuses the dropped mobile field on contacts', () => {
    // 10 Oct 2026: 28 calls in a day asked res.partner for mobile on Odoo 19.
    const rest = deriveErrorHint({
      host: 'acme.odoo.com',
      status: 500,
      body: { name: 'builtins.ValueError', message: "Invalid field 'mobile' on 'res.partner'" },
    });
    expect(rest).toMatch(/`phone`/);
    expect(
      deriveErrorHint({ message: "JSON-RPC error 200: Odoo Server Error: Invalid field res.partner.mobile in leaf ('mobile', '!=', False)" }),
    ).toMatch(/`phone`/);
    // Another model's own mobile field keeps the generic advice.
    expect(
      deriveErrorHint({ status: 500, body: { message: "Invalid field 'mobile' on 'hr.employee'" } }),
    ).toMatch(/fields_get/);
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

  it('reads Figma\'s "File not found" on dev resources as missing Dev Mode, not a missing file', () => {
    const read = deriveErrorHint({
      host: 'api.figma.com',
      status: 404,
      body: { error: true, status: 404, message: 'File not found', i18n: 'error.not_found' },
    });
    expect(read).toMatch(/Dev Mode/);
    const write = deriveErrorHint({
      host: 'api.figma.com',
      status: 400,
      message: 'The API answered with an error in a successful response: File not found',
      body: { links_created: [], errors: [{ file_key: 'k', node_id: '1:2', error: 'File not found' }] },
    });
    expect(write).toBe(read);
    expect(deriveErrorHint({ host: 'api.figma.com', status: 404, body: { status: 404, err: 'Not found' } })).toBeUndefined();
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

  it('tells the model to send Etsy property values back complete', () => {
    const hint = deriveErrorHint({
      host: 'openapi.etsy.com',
      status: 400,
      body: { error: "Expected string value for 'property_name' (got NULL)." },
    });
    expect(hint).toMatch(/etsy_read_listing_inventory/);
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

describe('deriveErrorHint: generative AI APIs', () => {
  const gemini = 'generativelanguage.googleapis.com';
  const openai = 'api.openai.com';

  it('explains the Gemini failures a retry cannot fix', () => {
    expect(
      deriveErrorHint({
        host: gemini,
        status: 400,
        body: { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } },
      }),
    ).toMatch(/aistudio\.google\.com\/apikey/);
    expect(
      deriveErrorHint({ host: gemini, status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota' } } }),
    ).toMatch(/free tier.*image models have no free tier/);
    expect(
      deriveErrorHint({ host: gemini, status: 404, body: { error: { message: 'models/gemini-9-ultra is not found for API version v1beta, or is not supported for generateContent.' } } }),
    ).toMatch(/gemini_list_models/);
    expect(
      deriveErrorHint({ host: gemini, status: 400, body: { error: { status: 'FAILED_PRECONDITION', message: 'User location is not supported for the API use.' } } }),
    ).toMatch(/billing/);
    expect(deriveErrorHint({ host: gemini, status: 403, body: { error: { status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } } })).toMatch(
      /API restrictions/,
    );
  });

  it('reads the safety blocks that the gemini adapter turns into errors', () => {
    expect(
      deriveErrorHint({ host: gemini, status: 400, message: 'The API answered with an error in a successful response: SAFETY' }),
    ).toMatch(/safety or content filters/);
    expect(
      deriveErrorHint({ host: gemini, status: 400, message: 'The API answered with an error in a successful response: IMAGE_SAFETY Unable to show the generated image.' }),
    ).toMatch(/Retrying the same request will not help/);
    expect(
      deriveErrorHint({ host: gemini, status: 400, body: { error: { message: "Invalid value at 'safety_settings[0].category'" } } }),
    ).toBeUndefined();
  });

  it('explains the OpenAI failures a retry cannot fix', () => {
    expect(
      deriveErrorHint({ host: openai, status: 401, body: { error: { message: 'Incorrect API key provided: sk-abc***', code: 'invalid_api_key' } } }),
    ).toMatch(/platform\.openai\.com\/api-keys/);
    expect(
      deriveErrorHint({ host: openai, status: 429, body: { error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } } }),
    ).toMatch(/add credit/);
    expect(
      deriveErrorHint({ host: openai, status: 429, body: { error: { message: 'Rate limit reached for gpt-image-1-mini', code: 'rate_limit_exceeded' } } }),
    ).toMatch(/Do not retry in a loop/);
    expect(
      deriveErrorHint({ host: openai, status: 403, body: { error: { message: 'Your organization must be verified to use the model `gpt-image-2`.' } } }),
    ).toMatch(/Verify Organization/);
    expect(
      deriveErrorHint({ host: openai, status: 404, body: { error: { message: 'The model `gpt-9` does not exist or you do not have access to it.', code: 'model_not_found' } } }),
    ).toMatch(/openai_list_models/);
    expect(
      deriveErrorHint({ host: openai, status: 400, body: { error: { message: 'Your request was rejected by the safety system.', code: 'moderation_blocked' } } }),
    ).toMatch(/safety system refused/);
  });

  it('stays quiet for these phrases on other hosts', () => {
    expect(deriveErrorHint({ host: 'api.example.com', status: 429, body: { error: 'insufficient_quota' } })).toBeUndefined();
    expect(deriveErrorHint({ host: 'api.example.com', status: 400, message: 'SAFETY' })).toBeUndefined();
  });
});
