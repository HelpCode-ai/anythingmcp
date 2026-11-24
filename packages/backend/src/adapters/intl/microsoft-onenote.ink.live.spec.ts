import * as adapter from './microsoft-onenote.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { isOneNotePageResult } from '../../connectors/onenote-page-renderer';

const tool = adapter.tools.find((entry) => entry.name === 'microsoft_onenote_get_page_image')!;

describe('OneNote page preview adapter', () => {
  it('opts only a read-only, encoded page-content GET into rendering', () => {
    expect(tool).toBeDefined();
    expect(tool.endpointMapping).toMatchObject({ method: 'GET', path: '/me/onenote/pages/{page_id}/content', encodePathParams: true });
    expect(tool.responseMapping).toMatchObject({ render: 'onenote-page', binary: { maxBytes: 4194304 } });
    expect(deriveToolAnnotations({ name: tool.name, connectorType: 'REST', endpointMapping: tool.endpointMapping as any }).readOnlyHint).toBe(true);
    expect(adapter.connector.authConfig.scopes).toBe('offline_access User.Read Notes.ReadWrite');
  });
});

const live = process.env.RUN_ONENOTE_INK_LIVE === '1' && process.env.MS_GRAPH_ACCESS_TOKEN && process.env.ONENOTE_LIVE_PAGE_ID ? it : it.skip;

live('renders an explicitly selected pen-written Graph page (read only)', async () => {
  const engine = new RestEngine({ getAccessToken: async () => process.env.MS_GRAPH_ACCESS_TOKEN } as any, {} as any);
  const result = await engine.execute({
    baseUrl: adapter.connector.baseUrl,
    authType: 'OAUTH2',
    authConfig: { accessToken: process.env.MS_GRAPH_ACCESS_TOKEN },
  }, tool.endpointMapping as any, { page_id: process.env.ONENOTE_LIVE_PAGE_ID }, tool.responseMapping);
  expect(isOneNotePageResult(result)).toBe(true);
  if (!isOneNotePageResult(result)) throw new Error('Expected a OneNote page preview');
  expect(result.tiles.length).toBeGreaterThan(0);
  for (const tile of result.tiles) expect(Buffer.from(tile.data, 'base64').subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}, 180_000);
