import * as adapter from './etsy.json';
import axios, { AxiosError } from 'axios';
import FormData from 'form-data';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { fetchOutbound } from '../../common/outbound-fetch.util';

jest.mock('../../common/outbound-fetch.util', () => ({
  ...jest.requireActual('../../common/outbound-fetch.util'),
  fetchOutbound: jest.fn(),
}));
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return { __esModule: true, default: jest.fn(), AxiosError: actual.AxiosError };
});
const mockedAxios = axios as jest.MockedFunction<typeof axios>;
const mockedFetchOutbound = fetchOutbound as jest.MockedFunction<typeof fetchOutbound>;
void AxiosError;

type Tool = {
  name: string;
  parameters: { required?: string[]; properties: Record<string, unknown> };
  endpointMapping: Record<string, any>;
};
const tools = (adapter as unknown as { tools: Tool[] }).tools;
const tool = (name: string) => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

/**
 * The listing and order tools that write. Request shapes follow Etsy's
 * OpenAPI spec and, where it is ambiguous, what already works in production:
 * tools customers built themselves create drafts with form-urlencoded bodies
 * and tags as one comma-separated string (54 + 35 + 23 successful calls in
 * the week before these were added).
 */
describe('etsy adapter: write tools', () => {
  const engine = new RestEngine(
    { getAccessToken: jest.fn(), refreshToken: jest.fn() } as any,
    { getToken: jest.fn(), forceRelogin: jest.fn() } as any,
  );
  const config = {
    baseUrl: 'https://openapi.etsy.com/v3/application',
    authType: 'BEARER_TOKEN' as const,
    authConfig: { token: 'etsy-token' },
  };
  const run = (name: string, params: Record<string, unknown>) =>
    engine.execute(config, tool(name).endpointMapping as any, params);
  const sent = () => mockedAxios.mock.calls[0][0] as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.mockResolvedValue({ data: { ok: true } });
  });

  it('creates a draft with a form-urlencoded body and only the fields given', async () => {
    await run('etsy_create_listing_draft', {
      shop_id: 123,
      title: 'Blue ceramic mug',
      description: 'Handmade.',
      price: 24.5,
      quantity: 3,
      who_made: 'i_did',
      when_made: 'made_to_order',
      is_supply: false,
      taxonomy_id: 1049,
      tags: 'mug,ceramic,blue',
      shipping_profile_id: 77,
      readiness_state_id: 88,
    });
    expect(sent().method).toBe('POST');
    expect(sent().url).toBe('https://openapi.etsy.com/v3/application/shops/123/listings');
    expect(sent().headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(sent().data);
    expect(body.get('tags')).toBe('mug,ceramic,blue');
    expect(body.get('price')).toBe('24.5');
    expect(body.get('is_supply')).toBe('false');
    expect(body.get('readiness_state_id')).toBe('88');
    expect(body.has('return_policy_id')).toBe(false);
    expect(body.has('shop_id')).toBe(false);
  });

  it('declares what Etsy requires to create a listing', () => {
    expect(tool('etsy_create_listing_draft').parameters.required).toEqual(
      expect.arrayContaining(['shop_id', 'title', 'description', 'price', 'quantity', 'who_made', 'when_made', 'taxonomy_id']),
    );
  });

  it('edits a listing with PATCH and sends nothing it was not given', async () => {
    await run('etsy_edit_listing', { shop_id: 123, listing_id: 456, state: 'active' });
    expect(sent().method).toBe('PATCH');
    expect(sent().url).toBe('https://openapi.etsy.com/v3/application/shops/123/listings/456');
    expect(sent().data).toBe('state=active');
  });

  it('replaces the inventory with a JSON body', async () => {
    const products = [{ sku: 'MUG-01', property_values: [], offerings: [{ price: 24.5, quantity: 10, is_enabled: true }] }];
    await run('etsy_set_listing_inventory', { listing_id: 456, products });
    expect(sent().method).toBe('PUT');
    expect(sent().url).toBe('https://openapi.etsy.com/v3/application/listings/456/inventory');
    expect(sent().data).toEqual({ products });
  });

  it('uploads a photo as a multipart file fetched from the given URL', async () => {
    mockedFetchOutbound.mockResolvedValueOnce({
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
      body: Buffer.from('jpeg-bytes'),
      finalUrl: 'https://cdn.example.com/mug.jpg',
    } as any);
    const append = jest.spyOn(FormData.prototype, 'append');
    await run('etsy_add_listing_image', {
      shop_id: 123,
      listing_id: 456,
      image_url: 'https://cdn.example.com/mug.jpg',
      rank: 1,
    });
    expect(mockedFetchOutbound).toHaveBeenCalledWith('https://cdn.example.com/mug.jpg', expect.any(Object));
    expect(sent().url).toBe('https://openapi.etsy.com/v3/application/shops/123/listings/456/images');
    expect(append).toHaveBeenCalledWith('image', expect.any(Buffer), expect.objectContaining({ filename: 'mug.jpg' }));
    expect(append).toHaveBeenCalledWith('rank', '1');
    append.mockRestore();
  });

  it('adds tracking to an order with a JSON body', async () => {
    await run('etsy_add_order_tracking', {
      shop_id: 123,
      receipt_id: 999,
      tracking_code: '00340434',
      carrier_name: 'dhl',
    });
    expect(sent().method).toBe('POST');
    expect(sent().url).toBe('https://openapi.etsy.com/v3/application/shops/123/receipts/999/tracking');
    expect(sent().data).toEqual({ tracking_code: '00340434', carrier_name: 'dhl' });
  });

  it('encodes path ids on every new tool, so an id cannot reach another route', () => {
    const added = [
      'etsy_list_taxonomy_properties', 'etsy_list_shipping_profiles', 'etsy_list_processing_profiles',
      'etsy_list_return_policies', 'etsy_list_shop_sections', 'etsy_read_listing_inventory',
      'etsy_create_listing_draft', 'etsy_edit_listing', 'etsy_set_listing_inventory',
      'etsy_add_listing_image', 'etsy_add_order_tracking',
    ];
    for (const name of added) expect(tool(name).endpointMapping.encodePathParams).toBe(true);
  });

  /**
   * Customers already have tools of their own named etsy_update_listing and
   * etsy_create_draft_listing on Etsy connectors. A catalog tool with the same
   * name would be matched to theirs by the catalog update and overwrite it.
   */
  it("states Etsy's 140-character title limit, so the model does not send longer titles", () => {
    for (const name of ['etsy_create_listing_draft', 'etsy_edit_listing']) {
      const title = tool(name).parameters.properties.title as { maxLength?: number; description?: string };
      expect(title.maxLength).toBe(140);
      expect(title.description).toContain('at most 140 characters');
    }
  });

  it('sets a listing property with a JSON body of value ids and values', async () => {
    await run('etsy_set_listing_property', {
      shop_id: 123,
      listing_id: 456,
      property_id: 200,
      value_ids: [1213],
      values: ['Beige'],
    });
    expect(sent().method).toBe('PUT');
    expect(sent().url).toBe('https://openapi.etsy.com/v3/application/shops/123/listings/456/properties/200');
    expect(sent().data).toEqual({ value_ids: [1213], values: ['Beige'] });
  });

  it('adds a translation with POST and replaces one with PUT, form-urlencoded', async () => {
    await run('etsy_add_listing_translation', {
      shop_id: 123,
      listing_id: 456,
      language: 'de',
      title: 'Blaue Keramiktasse',
      description: 'Handgemacht.',
      tags: 'tasse,keramik',
    });
    expect(sent().method).toBe('POST');
    expect(sent().url).toBe('https://openapi.etsy.com/v3/application/shops/123/listings/456/translations/de');
    const body = new URLSearchParams(sent().data);
    expect(body.get('title')).toBe('Blaue Keramiktasse');
    expect(body.get('tags')).toBe('tasse,keramik');
    mockedAxios.mockClear();
    await run('etsy_replace_listing_translation', {
      shop_id: 123,
      listing_id: 456,
      language: 'fr',
      title: 'Tasse',
      description: 'Faite main.',
    });
    expect(sent().method).toBe('PUT');
    expect(sent().url).toBe('https://openapi.etsy.com/v3/application/shops/123/listings/456/translations/fr');
  });

  it('assigns variation images with a JSON body', async () => {
    const variation_images = [{ property_id: 200, value_id: 1213, image_id: 789 }];
    await run('etsy_assign_variation_images', { shop_id: 123, listing_id: 456, variation_images });
    expect(sent().method).toBe('POST');
    expect(sent().url).toBe('https://openapi.etsy.com/v3/application/shops/123/listings/456/variation-images');
    expect(sent().data).toEqual({ variation_images });
  });

  it('uploads a video and a digital file as multipart files fetched from the given URL', async () => {
    for (const [name, params, field] of [
      ['etsy_add_listing_video', { shop_id: 123, listing_id: 456, video_url: 'https://cdn.example.com/mug.mp4', name: 'mug.mp4' }, 'video'],
      ['etsy_upload_listing_file', { shop_id: 123, listing_id: 456, file_url: 'https://cdn.example.com/p.pdf', name: 'p.pdf' }, 'file'],
    ] as const) {
      mockedAxios.mockClear();
      mockedFetchOutbound.mockResolvedValueOnce({
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from('bytes'),
        finalUrl: Object.values(params)[2] as string,
      } as any);
      const append = jest.spyOn(FormData.prototype, 'append');
      await run(name, params);
      expect(append).toHaveBeenCalledWith(field, expect.any(Buffer), expect.any(Object));
      expect(append).toHaveBeenCalledWith('name', params.name);
      append.mockRestore();
    }
  });

  it('deletes a listing on the listing route, and installs every delete switched off', async () => {
    await run('etsy_delete_listing_permanently', { listing_id: 456 });
    expect(sent().method).toBe('DELETE');
    expect(sent().url).toBe('https://openapi.etsy.com/v3/application/listings/456');
    const off = (tools as Array<Tool & { enabled?: boolean }>).filter((t) => t.enabled === false).map((t) => t.name);
    expect(off.sort()).toEqual(['etsy_delete_listing_image', 'etsy_delete_listing_permanently', 'etsy_delete_listing_property']);
    for (const t of tools) {
      if (t.endpointMapping.method === 'DELETE') expect(off).toContain(t.name);
    }
  });

  it('encodes path ids on the attribute, translation and media tools', () => {
    for (const name of [
      'etsy_get_listing_properties', 'etsy_set_listing_property', 'etsy_delete_listing_property',
      'etsy_read_listing_translation', 'etsy_add_listing_translation', 'etsy_replace_listing_translation',
      'etsy_list_listing_images', 'etsy_delete_listing_image', 'etsy_list_listing_variation_images',
      'etsy_assign_variation_images', 'etsy_list_listing_files', 'etsy_upload_listing_file',
      'etsy_list_listing_videos', 'etsy_add_listing_video', 'etsy_delete_listing_permanently',
      'etsy_list_production_partners',
    ]) {
      expect(`${name}:${tool(name).endpointMapping.encodePathParams}`).toBe(`${name}:true`);
    }
  });

  it('does not reuse names customers gave their own Etsy tools', () => {
    const taken = ['etsy_update_listing', 'etsy_create_draft_listing', 'etsy_update_listing_inventory', 'etsy_upload_listing_image', 'etsy_get_listing_inventory', 'etsy_get_seller_taxonomy'];
    for (const name of taken) expect(tools.some((t) => t.name === name)).toBe(false);
  });
});
