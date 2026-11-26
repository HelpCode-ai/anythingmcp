import axios from 'axios';
import * as adapter from './microsoft-onenote.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { isBinaryBody, readBinaryConfig, renderBinaryBody } from '../../connectors/binary-response.util';

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return {
    __esModule: true,
    default: Object.assign(jest.fn(), actual.default),
    AxiosError: actual.AxiosError,
  };
});
const mockedAxios = axios as unknown as jest.Mock;

type Tool = {
  name: string;
  description: string;
  parameters: Parameters<typeof applySchemaDefaults>[0];
  endpointMapping: Parameters<RestEngine['execute']>[1];
  responseMapping?: Record<string, unknown>;
};
const tools = adapter.tools as unknown as Tool[];
const tool = (name: string): Tool => {
  const found = tools.find(t => t.name === `microsoft_onenote_${name}`);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
};
const BASE = 'https://graph.microsoft.com/v1.0';
const owners = [
  { scope: 'site', collection: 'sites', id: 'contoso.sharepoint.com,site-guid,web-guid' },
  { scope: 'group', collection: 'groups', id: '11111111-2222-3333-4444-555555555555' },
] as const;
const operations = [
  { name: 'list_SCOPE_notebooks', suffix: 'notebooks', params: {} },
  { name: 'list_SCOPE_sections', suffix: 'sections', params: {} },
  { name: 'list_SCOPE_section_pages', suffix: 'sections/1-section/pages', params: { section_id: '1-section' } },
  { name: 'get_SCOPE_page', suffix: 'pages/1-page', params: { page_id: '1-page' } },
  { name: 'get_SCOPE_page_content', suffix: 'pages/1-page/content', params: { page_id: '1-page' } },
  { name: 'get_SCOPE_resource', suffix: 'resources/0-resource/content', params: { resource_id: '0-resource' } },
];
const call = (name: string, params: Record<string, unknown>) => {
  const selected = tool(name);
  return new RestEngine(
    { getAccessToken: jest.fn().mockResolvedValue('shared-test-token') } as unknown as OAuth2TokenService,
    {} as LoginTokenService,
  ).execute(
    { ...adapter.connector, authConfig: { ...adapter.connector.authConfig } },
    selected.endpointMapping,
    applySchemaDefaults(selected.parameters, params),
  );
};
const sent = () => mockedAxios.mock.calls[0][0];

describe('OneNote shared notebooks: static Graph conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('adds exactly the site/group read surface without broadening the default OAuth scopes', () => {
    const shared = tools.filter(t => /^\/(sites|groups)\//.test(String(t.endpointMapping.path)));
    expect(shared.map(t => t.name).sort()).toEqual(owners.flatMap(owner =>
      operations.map(op => `microsoft_onenote_${op.name.replace('SCOPE', owner.scope)}`),
    ).sort());
    expect(adapter.connector.authConfig.scopes).toBe('offline_access User.Read Notes.ReadWrite');
    for (const selected of shared) {
      expect(selected.endpointMapping.method).toBe('GET');
      expect(selected.endpointMapping.encodePathParams).toBe(true);
      expect(deriveToolAnnotations({ name: selected.name, connectorType: 'REST', endpointMapping: selected.endpointMapping }).readOnlyHint).toBe(true);
    }
  });

  describe.each(owners)('$scope-owned notebooks', (owner) => {
    const ownerKey = `${owner.scope}_id`;

    it.each(operations)('$name uses the selected owner and the documented Graph path', async (operation) => {
      mockedAxios.mockResolvedValue({ data: {} });
      const name = operation.name.replace('SCOPE', owner.scope);
      await call(name, { [ownerKey]: owner.id, ...operation.params });
      expect(sent().url).toBe(`${BASE}/${owner.collection}/${encodeURIComponent(owner.id)}/onenote/${operation.suffix}`);
      expect(sent().headers.Authorization).toBe('Bearer shared-test-token');
      expect(sent().method).toBe('GET');
    });

    it('keeps owner and resource ids in their own path segments', async () => {
      mockedAxios.mockResolvedValue({ data: {} });
      const id = '../other?x=1#fragment';
      const resource = '0-resource/../../?q=fixture';
      await call(`get_${owner.scope}_resource`, { [ownerKey]: id, resource_id: resource });
      expect(sent().url).toBe(`${BASE}/${owner.collection}/${encodeURIComponent(id)}/onenote/resources/${encodeURIComponent(resource)}/content`);
      expect(sent().params ?? {}).toEqual({});
    });

    it('passes pagination and filters through without consuming the next link', async () => {
      const response = { value: [{ id: 'notebook' }], '@odata.nextLink': `${BASE}/${owner.collection}/${owner.id}/onenote/notebooks?$skip=20` };
      mockedAxios.mockResolvedValue({ data: response });
      await expect(call(`list_${owner.scope}_notebooks`, { [ownerKey]: owner.id, top: 10, skip: 10, filter: "contains(tolower(displayName),'work')" })).resolves.toBe(response);
      expect(sent().params).toEqual({ $top: 10, $skip: 10, $filter: "contains(tolower(displayName),'work')" });
      expect(mockedAxios).toHaveBeenCalledTimes(1);
    });

    it('returns a Graph access refusal without trying another owner', async () => {
      const refusal = Object.assign(new Error('Graph access refused'), { response: { status: 403, data: { error: { message: 'Access denied' } } } });
      mockedAxios.mockRejectedValueOnce(refusal);
      await expect(call(`list_${owner.scope}_notebooks`, { [ownerKey]: owner.id })).rejects.toThrow();
      expect(mockedAxios).toHaveBeenCalledTimes(1);
      expect(sent().url).toContain(`/${owner.collection}/`);
    });

    it('requests element ids and keeps the shared page HTML size cap', async () => {
      mockedAxios.mockResolvedValue({ data: '<html>page</html>' });
      const name = `get_${owner.scope}_page_content`;
      await call(name, { [ownerKey]: owner.id, page_id: '1-page', include_ids: true });
      expect(sent().params).toEqual({ includeIDs: true });
      const mapping = tool(name).responseMapping;
      expect(applyResponseTransform('<html>page</html>', mapping).value).toBe('<html>page</html>');
      expect(applyResponseTransform('x'.repeat(250_000), mapping).value).toMatchObject({ _truncated: true });
    });

    it.each(['image/png', 'application/pdf'])('returns a %s resource through the existing binary pipeline', async (contentType) => {
      const bytes = contentType === 'image/png'
        ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
        : Buffer.from('%PDF-1.4\nfixture\n%%EOF');
      mockedAxios.mockImplementationOnce(async (request: { transformResponse: Array<(data: Buffer, headers: Record<string, string>) => unknown> }) => {
        const headers = { 'content-type': contentType };
        return { data: request.transformResponse[0](bytes, headers), headers };
      });
      const name = `get_${owner.scope}_resource`;
      const raw = await call(name, { [ownerKey]: owner.id, resource_id: '0-resource' });
      if (!isBinaryBody(raw)) throw new Error('Expected binary resource data');
      const config = readBinaryConfig(tool(name).responseMapping);
      expect(config).toEqual({ as: 'auto', maxBytes: 4 * 1024 * 1024 });
      const rendered = renderBinaryBody(raw, config);
      expect(rendered.content[0].type).toBe(contentType === 'image/png' ? 'image' : 'resource');
      expect(JSON.stringify(rendered.value)).not.toContain(bytes.toString('base64'));
    });
  });
});

const live = process.env.RUN_ONENOTE_SHARED_LIVE === '1' && process.env.MS_GRAPH_ACCESS_TOKEN ? describe : describe.skip;
live('OneNote shared notebooks: live delegated read', () => {
  beforeAll(() => mockedAxios.mockImplementation((config: unknown) => jest.requireActual('axios').default(config)));
  for (const owner of owners) {
    const id = process.env[owner.scope === 'site' ? 'ONENOTE_SITE_ID' : 'ONENOTE_GROUP_ID'];
    (id ? it : it.skip)(`lists ${owner.scope} notebooks`, async () => {
      const selected = tool(`list_${owner.scope}_notebooks`);
      const result = await new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
        { baseUrl: BASE, authType: 'BEARER_TOKEN', authConfig: { token: process.env.MS_GRAPH_ACCESS_TOKEN } },
        selected.endpointMapping,
        { [`${owner.scope}_id`]: id, top: 1 },
      );
      expect(result).toMatchObject({ value: expect.any(Array) });
    }, 30_000);
  }
});
