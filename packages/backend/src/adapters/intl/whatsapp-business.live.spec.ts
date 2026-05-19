import * as adapter from './whatsapp-business.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/**
 * Two layers of verification for the whatsapp-business adapter:
 *
 *   1. Static — always runs. Asserts the adapter targets a currently-supported
 *      Graph API version, that send-tool bodies carry the mandatory
 *      `messaging_product: "whatsapp"` discriminator, and that paths follow the
 *      Meta Cloud API routing convention (`/{phoneNumberId}/messages`,
 *      `/{businessAccountId}/message_templates`, etc.). Catches the most common
 *      failure modes: pinning back to a deprecated API version, omitting the
 *      messaging_product field, or accidentally pointing at the old On-Premises
 *      API base path.
 *
 *   2. Live — skipped in CI. Hits graph.facebook.com with a bogus token to
 *      prove every endpoint path is recognised by Meta's router (401 OAuth
 *      error, not 404 path-not-found). A real end-to-end test requires a
 *      verified WhatsApp Business Account, a permanent system-user token and
 *      a test recipient — Meta provides a free sandbox tier in the Developer
 *      Console (up to 5 test numbers).
 *
 *   Run live with:  RUN_WHATSAPP_LIVE=1 npx jest src/adapters/intl/whatsapp-business.live.spec.ts
 */

interface Tool {
  name: string;
  endpointMapping: {
    method: string;
    path: string;
    bodyMapping?: Record<string, unknown>;
    bodyTemplate?: string;
  };
}

const a = adapter as unknown as {
  slug: string;
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
  };
  tools: Tool[];
};

describe('whatsapp-business adapter — static spec conformance', () => {
  it('targets a currently-supported Graph API version (>= v18, not deprecated)', () => {
    // v15.0 expired May 2024; v16/v17 expire 2025. v18+ are still active as of
    // 2026. v25 is the newest. Anything below v18 should not be used.
    const match = a.connector.baseUrl.match(/\/v(\d+)\.0$/);
    expect(match).not.toBeNull();
    const major = parseInt(match![1], 10);
    expect(major).toBeGreaterThanOrEqual(18);
    expect(major).toBeLessThanOrEqual(30);
  });

  it('uses the Cloud API base (graph.facebook.com), not the deprecated On-Premises API', () => {
    expect(a.connector.baseUrl).toContain('graph.facebook.com');
    // The On-Prem API used a self-hosted /v1/messages base — make sure nobody
    // accidentally re-introduces it.
    expect(a.connector.baseUrl).not.toMatch(/\/v1\/?$/);
  });

  it('authenticates with Bearer token (System User permanent access token)', () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig.token).toContain('{{WHATSAPP_ACCESS_TOKEN}}');
  });

  it('every send tool posts to /{phoneNumberId}/messages', () => {
    const sendTools = a.tools.filter((t) => t.name.startsWith('whatsapp_send_') || t.name === 'whatsapp_mark_message_as_read');
    expect(sendTools.length).toBeGreaterThan(0);
    for (const tool of sendTools) {
      expect(tool.endpointMapping.method).toBe('POST');
      expect(tool.endpointMapping.path).toBe('/{phoneNumberId}/messages');
    }
  });

  it('every send tool sets messaging_product="whatsapp" (mandatory discriminator per Meta API)', () => {
    const sendTools = a.tools.filter((t) => t.name.startsWith('whatsapp_send_') || t.name === 'whatsapp_mark_message_as_read');
    for (const tool of sendTools) {
      const body = tool.endpointMapping.bodyMapping;
      expect(body).toBeDefined();
      expect(body!['messaging_product']).toBe('whatsapp');
    }
  });

  it('whatsapp_mark_message_as_read sends status:"read" + message_id', () => {
    const tool = a.tools.find((t) => t.name === 'whatsapp_mark_message_as_read')!;
    const body = tool.endpointMapping.bodyMapping!;
    expect(body['status']).toBe('read');
    expect(body['message_id']).toBe('$messageId');
  });

  it('whatsapp_send_text_message places preview_url inside the text object (not at root)', () => {
    const tool = a.tools.find((t) => t.name === 'whatsapp_send_text_message')!;
    const body = tool.endpointMapping.bodyMapping!;
    expect(body['type']).toBe('text');
    expect((body['text'] as Record<string, unknown>)['body']).toBe('$body');
    expect((body['text'] as Record<string, unknown>)['preview_url']).toBe('$previewUrl');
    // preview_url must NOT be at the top level — Meta's API would silently drop it
    expect(body['preview_url']).toBeUndefined();
  });

  it('whatsapp_send_template_message uses template:{name, language:{code}, components}', () => {
    const tool = a.tools.find((t) => t.name === 'whatsapp_send_template_message')!;
    const body = tool.endpointMapping.bodyMapping!;
    expect(body['type']).toBe('template');
    const template = body['template'] as Record<string, unknown>;
    expect(template['name']).toBe('$templateName');
    expect((template['language'] as Record<string, unknown>)['code']).toBe('$languageCode');
    expect(template['components']).toBe('$components');
  });

  it('media tools place filename only on document (not on image/audio/video)', () => {
    const docTool = a.tools.find((t) => t.name === 'whatsapp_send_document')!;
    const docBody = docTool.endpointMapping.bodyMapping!;
    expect((docBody['document'] as Record<string, unknown>)['filename']).toBe('$filename');

    for (const name of ['whatsapp_send_image', 'whatsapp_send_audio', 'whatsapp_send_video']) {
      const tool = a.tools.find((t) => t.name === name)!;
      const body = tool.endpointMapping.bodyMapping!;
      const typeKey = name.replace('whatsapp_send_', '');
      const mediaObj = body[typeKey] as Record<string, unknown>;
      expect(mediaObj['filename']).toBeUndefined();
    }
  });

  it('whatsapp_send_audio does NOT accept caption (Meta API rejects caption on audio)', () => {
    const tool = a.tools.find((t) => t.name === 'whatsapp_send_audio')!;
    const audioObj = (tool.endpointMapping.bodyMapping!['audio'] as Record<string, unknown>);
    expect(audioObj['caption']).toBeUndefined();
  });

  it('WABA-scoped tools target /{businessAccountId}/...', () => {
    const listPhones = a.tools.find((t) => t.name === 'whatsapp_list_phone_numbers')!;
    expect(listPhones.endpointMapping.path).toBe('/{businessAccountId}/phone_numbers');
    expect(listPhones.endpointMapping.method).toBe('GET');

    const listTemplates = a.tools.find((t) => t.name === 'whatsapp_list_message_templates')!;
    expect(listTemplates.endpointMapping.path).toBe('/{businessAccountId}/message_templates');
    expect(listTemplates.endpointMapping.method).toBe('GET');
  });

  it('business profile tools target /{phoneNumberId}/whatsapp_business_profile', () => {
    const get = a.tools.find((t) => t.name === 'whatsapp_get_business_profile')!;
    expect(get.endpointMapping.path).toBe('/{phoneNumberId}/whatsapp_business_profile');
    expect(get.endpointMapping.method).toBe('GET');

    const update = a.tools.find((t) => t.name === 'whatsapp_update_business_profile')!;
    expect(update.endpointMapping.path).toBe('/{phoneNumberId}/whatsapp_business_profile');
    expect(update.endpointMapping.method).toBe('POST');
  });
});

const maybe = process.env.RUN_WHATSAPP_LIVE ? describe : describe.skip;

maybe('whatsapp-business adapter — live edge reachability', () => {
  const oauth = {} as unknown as OAuth2TokenService;
  const login = {} as unknown as LoginTokenService;
  const engine = new RestEngine(oauth, login);

  const baseUrl = a.connector.baseUrl;
  const FAKE_PHONE_NUMBER_ID = '1234567890';
  const FAKE_WABA_ID = '1234567890';

  // With a bogus bearer token, Meta returns 401 OAuthException for valid paths
  // and 404 for unknown paths. So 401 on each endpoint proves the path is
  // recognised by Meta's router.

  it('POST /{phoneNumberId}/messages reaches Meta (401 OAuthException with bogus token)', async () => {
    let err: any;
    try {
      await engine.execute(
        {
          baseUrl,
          authType: 'BEARER_TOKEN',
          authConfig: { token: 'bogus-token-for-endpoint-validation' },
        },
        {
          method: 'POST',
          path: `/${FAKE_PHONE_NUMBER_ID}/messages`,
          bodyMapping: {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: '15551234567',
            type: 'text',
            text: { body: 'smoke-test' },
          },
        },
        {},
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.response?.status).toBe(401);
    expect(err.response?.data?.error?.type).toBe('OAuthException');
  }, 30000);

  it('GET /{wabaId}/phone_numbers reaches Meta (401 OAuthException)', async () => {
    let err: any;
    try {
      await engine.execute(
        {
          baseUrl,
          authType: 'BEARER_TOKEN',
          authConfig: { token: 'bogus-token' },
        },
        { method: 'GET', path: `/${FAKE_WABA_ID}/phone_numbers` },
        {},
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.response?.status).toBe(401);
    expect(err.response?.data?.error?.type).toBe('OAuthException');
  }, 30000);

  it('GET /{wabaId}/message_templates reaches Meta (401 OAuthException)', async () => {
    let err: any;
    try {
      await engine.execute(
        {
          baseUrl,
          authType: 'BEARER_TOKEN',
          authConfig: { token: 'bogus-token' },
        },
        { method: 'GET', path: `/${FAKE_WABA_ID}/message_templates` },
        {},
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.response?.status).toBe(401);
    expect(err.response?.data?.error?.type).toBe('OAuthException');
  }, 30000);

  it('GET /{phoneNumberId}/whatsapp_business_profile reaches Meta (401 OAuthException)', async () => {
    let err: any;
    try {
      await engine.execute(
        {
          baseUrl,
          authType: 'BEARER_TOKEN',
          authConfig: { token: 'bogus-token' },
        },
        {
          method: 'GET',
          path: `/${FAKE_PHONE_NUMBER_ID}/whatsapp_business_profile`,
          queryParams: { fields: 'about' },
        },
        {},
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.response?.status).toBe(401);
    expect(err.response?.data?.error?.type).toBe('OAuthException');
  }, 30000);

  it('Authorization: Bearer header is actually injected by RestEngine', async () => {
    let err: any;
    try {
      await engine.execute(
        {
          baseUrl,
          authType: 'BEARER_TOKEN',
          authConfig: { token: 'sentinel-token-12345' },
        },
        { method: 'GET', path: `/${FAKE_WABA_ID}/phone_numbers` },
        {},
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    const sentHeaders = err.config?.headers || {};
    expect(String(sentHeaders.Authorization || '')).toBe('Bearer sentinel-token-12345');
  }, 30000);
});
