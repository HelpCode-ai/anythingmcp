import axios, { AxiosRequestConfig } from 'axios';
import * as adapter from './strapi.json';
import {
  applyResponseTransform,
  validateTransform,
} from '../../connectors/response-transform.util';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';

/**
 * Strapi 5 Content API (docs.strapi.io/cms/api/rest): Bearer token against
 * {{STRAPI_URL}}/api/<plural-api-id>, plus the /_health probe. Read-only:
 * list documents with fields, filters, sort, pagination, populate, locale and
 * status; get one document by its Strapi 5 documentId.
 * Live part: RUN_STRAPI_LIVE=1 STRAPI_URL=http://127.0.0.1:1337 STRAPI_API_TOKEN=... npx jest src/adapters/intl/strapi
 * (reads only; the local fixture provides an articles collection).
 */
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, {
      __actual: actual.default,
    }),
    AxiosError: actual.AxiosError,
  };
});

const mockedAxios = axios as unknown as jest.Mock & {
  __actual: typeof axios;
};

type Tool = {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  responseMapping?: {
    transform?: unknown;
  };
  annotations?: Record<string, unknown>;
};

type SentConfig = {
  method: string;
  url: string;
  headers: Record<string, string>;
  params?: Record<string, unknown>;
  paramsSerializer?: (params: Record<string, unknown>) => string;
  data?: unknown;
};

const a = adapter as unknown as {
  slug: string;
  instructions: string;
  requiredEnvVars: string[];
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: {
      token: string;
    };
    headers: Record<string, string>;
    healthcheckPath: string;
  };
  probe: {
    tool: string;
  };
  tools: Tool[];
};

const FAKE_TOKEN = ['strapi', 'static', 'fake', 'token'].join('-');
const STATIC_BASE_URL = 'https://cms.example.test';

const engine = new RestEngine(
  {} as unknown as OAuth2TokenService,
  {} as unknown as LoginTokenService,
);

function getTool(name: string): Tool {
  const tool = a.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Strapi tool not found: ${name}`);
  return tool;
}

function sent(index = 0): SentConfig {
  return mockedAxios.mock.calls[index][0] as unknown as SentConfig;
}

function serializedQuery(index = 0): string {
  const config = sent(index);
  if (!config.paramsSerializer) {
    throw new Error('Expected RestEngine to install a query params serializer');
  }
  return config.paramsSerializer(config.params ?? {});
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = getTool(name);
  return engine.execute(
    {
      baseUrl: STATIC_BASE_URL,
      authType: a.connector.authType,
      authConfig: { token: FAKE_TOKEN },
      headers: a.connector.headers,
    },
    tool.endpointMapping,
    args,
  );
}

beforeEach(() => {
  mockedAxios.mockReset();
  mockedAxios.mockResolvedValue({
    data: {},
    headers: {},
    status: 200,
  });
});

describe('strapi adapter — static contract', () => {
  it('requires only the Strapi URL and Content API token', () => {
    expect(a.requiredEnvVars).toEqual([
      'STRAPI_URL',
      'STRAPI_API_TOKEN',
    ]);
    expect(a.connector.baseUrl).toBe('{{STRAPI_URL}}');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig.token).toBe('{{STRAPI_API_TOKEN}}');
    expect(a.connector.headers).toEqual({ Accept: 'application/json' });
  });

  it('documents the Strapi 5, read-only, reachability, and SSRF boundaries', () => {
    expect(a.instructions).toContain('Strapi 5 REST Content API');
    expect(a.instructions).toContain('SSRF_ALLOWED_HOSTS');
    expect(a.instructions).toMatch(/Cloud.*publicly reachable/i);
    expect(a.instructions).toMatch(/read-only GET requests/i);
    expect(a.instructions).toMatch(/does not prove that the API token is valid/i);
  });

  it('publishes exactly the three requested tools and endpoints', () => {
    expect(a.tools.map((tool) => tool.name).sort()).toEqual(
      [
        'strapi_get_document',
        'strapi_health',
        'strapi_list_documents',
      ].sort(),
    );

    expect(
      a.tools
        .map(
          (tool) =>
            `${tool.endpointMapping.method} ${tool.endpointMapping.path}`,
        )
        .sort(),
    ).toEqual(
      [
        'GET /_health',
        'GET /api/{contentType}',
        'GET /api/{contentType}/{documentId}',
      ].sort(),
    );
    expect(a.connector.healthcheckPath).toBe('/_health');
    expect(a.probe.tool).toBe('strapi_health');
  });

  it('contains no write method, request body, write tool, or Admin API path', () => {
    for (const tool of a.tools) {
      expect(tool.name.startsWith('strapi_')).toBe(true);
      expect(tool.endpointMapping.method).toBe('GET');
      expect(tool.endpointMapping).not.toHaveProperty('bodyMapping');
      expect(tool.endpointMapping.path).not.toMatch(
        /\/admin|content-manager|content-type-builder/i,
      );
      expect(tool.name).not.toMatch(
        /(?:^|_)(?:create|update|publish|unpublish|delete)(?:_|$)/,
      );
    }
  });

  it('derives read-only, non-destructive, idempotent annotations for every tool', () => {
    for (const tool of a.tools) {
      expect(
        deriveToolAnnotations({
          name: tool.name,
          connectorType: 'REST',
          endpointMapping: tool.endpointMapping,
          annotations: tool.annotations,
        }),
      ).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
    }
  });

  it('declares the list and get inputs and their exact query mappings', () => {
    const list = getTool('strapi_list_documents');
    const get = getTool('strapi_get_document');

    expect(list.parameters.required).toEqual(['contentType']);
    expect(Object.keys(list.parameters.properties).sort()).toEqual(
      [
        'contentType',
        'fields',
        'filters',
        'locale',
        'pagination',
        'populate',
        'sort',
        'status',
      ].sort(),
    );
    expect(list.endpointMapping.queryParams).toEqual({
      fields: '$fields',
      filters: '$filters',
      sort: '$sort',
      pagination: '$pagination',
      populate: '$populate',
      locale: '$locale',
      status: '$status',
    });

    expect(get.parameters.required).toEqual([
      'contentType',
      'documentId',
    ]);
    expect(Object.keys(get.parameters.properties).sort()).toEqual(
      [
        'contentType',
        'documentId',
        'fields',
        'locale',
        'populate',
      ].sort(),
    );
    expect(get.endpointMapping.queryParams).toEqual({
      fields: '$fields',
      populate: '$populate',
      locale: '$locale',
    });
  });
});

describe('strapi adapter — real RestEngine request construction', () => {
  it('injects the fake token only in the Authorization header', async () => {
    await callTool('strapi_list_documents', { contentType: 'articles' });

    const request = sent();
    expect(request.headers).toMatchObject({
      Accept: 'application/json',
      Authorization: `Bearer ${FAKE_TOKEN}`,
    });
    expect(request.url).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(request.params ?? {})).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(adapter)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(adapter)).not.toMatch(
      /Bearer\s+(?!Token|header)[A-Za-z0-9._~-]{16,}/,
    );
  });

  it('percent-encodes contentType and documentId without changing the path structure', async () => {
    const contentType = 'articles/../admin?x=1#fragment';
    const documentId = 'doc/a?draft=true#part with space';

    const list = getTool('strapi_list_documents');
    const get = getTool('strapi_get_document');
    expect(list.endpointMapping.encodePathParams).toBe(true);
    expect(get.endpointMapping.encodePathParams).toBe(true);

    await callTool('strapi_list_documents', { contentType });
    await callTool('strapi_get_document', { contentType, documentId });

    expect(sent(0).url).toBe(
      `${STATIC_BASE_URL}/api/${encodeURIComponent(contentType)}`,
    );
    expect(sent(1).url).toBe(
      `${STATIC_BASE_URL}/api/${encodeURIComponent(contentType)}/${encodeURIComponent(documentId)}`,
    );
    expect(sent(0).url).not.toContain('../admin?x=1');
    expect(sent(1).url).not.toContain('?draft=true');
    expect(sent(1).url).toContain('%2F');
    expect(sent(1).url).toContain('%3F');
    expect(sent(1).url).toContain('%23');
    expect(sent(1).url).toContain('%20');
  });

  it('serializes every list query through the engine, including deep objects', async () => {
    await callTool('strapi_list_documents', {
      contentType: 'articles',
      fields: ['title', 'slug'],
      filters: {
        title: { $containsi: 'release' },
        publishedAt: { $notNull: true },
      },
      sort: ['publishedAt:desc', 'title:asc'],
      pagination: { page: 2, pageSize: 10, withCount: true },
      populate: { author: { fields: ['name'] } },
      locale: 'en',
      status: 'published',
    });

    expect(sent().params).toEqual({
      fields: ['title', 'slug'],
      filters: {
        title: { $containsi: 'release' },
        publishedAt: { $notNull: true },
      },
      sort: ['publishedAt:desc', 'title:asc'],
      pagination: { page: 2, pageSize: 10, withCount: true },
      populate: { author: { fields: ['name'] } },
      locale: 'en',
      status: 'published',
    });

    expect(decodeURIComponent(serializedQuery()).split('&')).toEqual([
      'fields=title',
      'fields=slug',
      'filters[title][$containsi]=release',
      'filters[publishedAt][$notNull]=true',
      'sort=publishedAt:desc',
      'sort=title:asc',
      'pagination[page]=2',
      'pagination[pageSize]=10',
      'pagination[withCount]=true',
      'populate[author][fields][0]=name',
      'locale=en',
      'status=published',
    ]);
    expect(serializedQuery()).not.toContain('[object Object]');
  });

  it('serializes the get fields, populate, and locale parameters', async () => {
    await callTool('strapi_get_document', {
      contentType: 'articles',
      documentId: 'doc-1',
      fields: ['title', 'slug'],
      populate: '*',
      locale: 'de',
    });

    expect(sent().params).toEqual({
      fields: ['title', 'slug'],
      populate: '*',
      locale: 'de',
    });
    expect(decodeURIComponent(serializedQuery()).split('&')).toEqual([
      'fields=title',
      'fields=slug',
      'populate=*',
      'locale=de',
    ]);
  });

  it('drops every missing optional parameter instead of sending undefined', async () => {
    await callTool('strapi_list_documents', { contentType: 'articles' });
    await callTool('strapi_get_document', {
      contentType: 'articles',
      documentId: 'doc-1',
    });

    for (const index of [0, 1]) {
      expect(sent(index).params).toEqual({});
      expect(serializedQuery(index)).toBe('');
      expect(sent(index).url).not.toContain('?');
      expect(JSON.stringify(sent(index))).not.toContain('undefined');
    }
  });

  it('handles the empty 204 health response without inventing a token check', async () => {
    mockedAxios.mockResolvedValueOnce({
      data: undefined,
      headers: {},
      status: 204,
    });

    await expect(callTool('strapi_health', {})).resolves.toBeUndefined();
    expect(sent()).toMatchObject({
      method: 'GET',
      url: `${STATIC_BASE_URL}/_health`,
    });
    expect(sent().data).toBeUndefined();
  });
});

describe('strapi adapter — response contracts', () => {
  it('keeps list data and pagination meta together', () => {
    const tool = getTool('strapi_list_documents');
    const raw = {
      data: [
        {
          documentId: 'doc-1',
          title: 'Release notes',
        },
      ],
      meta: {
        pagination: {
          page: 1,
          pageSize: 10,
          pageCount: 1,
          total: 1,
        },
      },
    };

    expect(validateTransform(tool.responseMapping?.transform)).toBeNull();
    expect(applyResponseTransform(raw, tool.responseMapping).value).toEqual(raw);
  });

  it('returns the data object for one document', () => {
    const tool = getTool('strapi_get_document');
    const document = {
      documentId: 'doc-1',
      title: 'Release notes',
    };

    expect(validateTransform(tool.responseMapping?.transform)).toBeNull();
    expect(
      applyResponseTransform({ data: document, meta: {} }, tool.responseMapping)
        .value,
    ).toEqual(document);
  });
});

const runLive =
  process.env.RUN_STRAPI_LIVE === '1' &&
  Boolean(process.env.STRAPI_URL) &&
  Boolean(process.env.STRAPI_API_TOKEN);

const live = runLive ? describe : describe.skip;

type LiveListResponse = {
  data: Array<Record<string, unknown>>;
  meta: {
    pagination: {
      page: number;
      pageSize: number;
      pageCount: number;
      total: number;
    };
  };
};

type SanitizedLiveError = Error & {
  status?: number;
};

live('strapi adapter — live API through RestEngine', () => {
  const liveBaseUrl = process.env.STRAPI_URL!;
  const liveToken = process.env.STRAPI_API_TOKEN!;
  const contentType = process.env.STRAPI_TEST_CONTENT_TYPE ?? 'articles';
  const fixtureSlug = 'anythingmcp-alpha-release';
  const fixtureGermanSlug = 'anythingmcp-deutscher-artikel';
  const invalidToken = ['anythingmcp', 'invalid', 'strapi', 'token'].join('-');

  const liveEngine = new RestEngine(
    {} as unknown as OAuth2TokenService,
    {} as unknown as LoginTokenService,
  );

  let baselineEnglish: LiveListResponse;
  let baselineGerman: LiveListResponse;
  let liveDocumentId = process.env.STRAPI_TEST_DOCUMENT_ID ?? '';

  function assertLocalLiveUrl(): void {
    const url = new URL(liveBaseUrl);
    expect(url.protocol).toBe('http:');
    expect(['127.0.0.1', 'localhost', '::1']).toContain(url.hostname);
    expect(url.port || '80').toBe('1337');
    expect(url.pathname).toBe('/');
  }

  function useRealAxios(): void {
    mockedAxios.mockImplementation(
      (config: AxiosRequestConfig) =>
        mockedAxios.__actual.request(config),
    );
  }

  async function liveCall(
    name: string,
    args: Record<string, unknown>,
    token: string | null = liveToken,
  ): Promise<unknown> {
    const tool = getTool(name);
    const config = token === null
      ? {
          baseUrl: liveBaseUrl,
          authType: 'NONE',
          headers: a.connector.headers,
        }
      : {
          baseUrl: liveBaseUrl,
          authType: 'BEARER_TOKEN',
          authConfig: { token },
          headers: a.connector.headers,
        };

    try {
      return await liveEngine.execute(config, tool.endpointMapping, args);
    } catch (error) {
      const status = (error as { response?: { status?: number } }).response?.status;
      const sanitized = new Error(
        `${name} failed${status ? ` with HTTP ${status}` : ''}`,
      ) as SanitizedLiveError;
      sanitized.status = status;
      throw sanitized;
    }
  }

  async function shapedLiveCall(
    name: string,
    args: Record<string, unknown>,
    token: string | null = liveToken,
  ): Promise<unknown> {
    return applyResponseTransform(
      await liveCall(name, args, token),
      getTool(name).responseMapping,
    ).value;
  }

  async function snapshotPublished(locale: string): Promise<LiveListResponse> {
    return shapedLiveCall('strapi_list_documents', {
      contentType,
      sort: ['rank:asc'],
      pagination: { page: 1, pageSize: 100, withCount: true },
      populate: 'author',
      locale,
      status: 'published',
    }) as Promise<LiveListResponse>;
  }

  beforeAll(async () => {
    assertLocalLiveUrl();
    useRealAxios();
    baselineEnglish = await snapshotPublished('en');
    baselineGerman = await snapshotPublished('de');

    if (!liveDocumentId) {
      const document = baselineEnglish.data.find(
        (candidate) => candidate.slug === fixtureSlug,
      );
      if (typeof document?.documentId !== 'string') {
        throw new Error(
          `The local ${contentType} fixture has no published ${fixtureSlug} document`,
        );
      }
      liveDocumentId = document.documentId;
    }
  }, 30000);

  beforeEach(() => {
    // The outer static-test beforeEach restores the Axios mock before every
    // test. A gated live test opts back into the real client explicitly.
    useRealAxios();
  });

  afterAll(() => {
    mockedAxios.mockReset();
  });

  it('checks the real Strapi health endpoint and receives an empty 204 response', async () => {
    const body = await liveCall('strapi_health', {});
    expect([undefined, null, '']).toContain(body);

    const response = await mockedAxios.__actual.request({
      method: 'GET',
      url: `${liveBaseUrl}/_health`,
      validateStatus: () => true,
    });
    expect(response.status).toBe(204);
    expect(response.data === '' || response.data == null).toBe(true);
  }, 30000);

  it('applies fields, filters, sort, pagination, locale, and status to a real list', async () => {
    const response = await shapedLiveCall('strapi_list_documents', {
      contentType,
      fields: ['title', 'slug', 'rank'],
      filters: { slug: { $containsi: 'anythingmcp' } },
      sort: ['rank:desc'],
      pagination: { page: 1, pageSize: 1, withCount: true },
      locale: 'en',
      status: 'published',
    }) as LiveListResponse;

    expect(response.data).toHaveLength(1);
    expect(response.meta.pagination).toMatchObject({
      page: 1,
      pageSize: 1,
      pageCount: 2,
      total: 2,
    });
    expect(response.data[0]).toMatchObject({
      title: 'AnythingMCP Beta Guide',
      slug: 'anythingmcp-beta-guide',
      rank: 20,
    });
    expect(response.data[0].documentId).toEqual(expect.any(String));
    expect(response.data[0]).not.toHaveProperty('author');
  }, 30000);

  it('populates the author component only when requested', async () => {
    const response = await shapedLiveCall('strapi_list_documents', {
      contentType,
      fields: ['title', 'slug'],
      filters: { slug: { $eq: fixtureSlug } },
      pagination: { page: 1, pageSize: 10, withCount: true },
      populate: { author: { fields: ['name', 'role'] } },
      locale: 'en',
      status: 'published',
    }) as LiveListResponse;

    expect(response.data).toHaveLength(1);
    expect(response.data[0]).toMatchObject({
      slug: fixtureSlug,
      author: {
        name: 'Ada Lovelace',
        role: 'Editor',
      },
    });
  }, 30000);

  it('selects the localized German fixture with locale=de', async () => {
    const response = await shapedLiveCall('strapi_list_documents', {
      contentType,
      fields: ['title', 'slug', 'rank'],
      filters: { slug: { $eq: fixtureGermanSlug } },
      pagination: { page: 1, pageSize: 10, withCount: true },
      populate: 'author',
      locale: 'de',
      status: 'published',
    }) as LiveListResponse;

    expect(response.meta.pagination.total).toBe(1);
    expect(response.data).toHaveLength(1);
    expect(
      baselineEnglish.data.some(
        (document) => document.slug === fixtureGermanSlug,
      ),
    ).toBe(false);
    expect(response.data[0]).toMatchObject({
      title: 'AnythingMCP Deutscher Artikel',
      slug: fixtureGermanSlug,
      author: {
        name: 'Emmy Noether',
        role: 'Redakteurin',
      },
    });
  }, 30000);

  it('retrieves one populated document by its Strapi 5 documentId', async () => {
    const document = await shapedLiveCall('strapi_get_document', {
      contentType,
      documentId: liveDocumentId,
      fields: ['title', 'slug', 'rank'],
      populate: { author: { fields: ['name', 'role'] } },
      locale: 'en',
    }) as Record<string, unknown>;

    expect(document).toMatchObject({
      documentId: liveDocumentId,
      title: 'AnythingMCP Alpha Release',
      slug: fixtureSlug,
      rank: 10,
      author: {
        name: 'Ada Lovelace',
        role: 'Editor',
      },
    });
  }, 30000);

  it('rejects anonymous and invalid-token reads of the protected collection', async () => {
    await expect(
      liveCall(
        'strapi_list_documents',
        {
          contentType,
          pagination: { page: 1, pageSize: 1 },
          status: 'published',
        },
        null,
      ),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      liveCall(
        'strapi_list_documents',
        {
          contentType,
          pagination: { page: 1, pageSize: 1 },
          status: 'published',
        },
        invalidToken,
      ),
    ).rejects.toMatchObject({ status: 401 });
  }, 30000);

  it('leaves the English and German fixture data unchanged', async () => {
    expect(await snapshotPublished('en')).toEqual(baselineEnglish);
    expect(await snapshotPublished('de')).toEqual(baselineGerman);
  }, 30000);
});
