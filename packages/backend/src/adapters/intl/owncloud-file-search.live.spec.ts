import * as raw from './owncloud-file-search.json';
import { getAdapter } from '../catalog';

const a = raw as unknown as {
  slug: string;
  requiredEnvVars: string[];
  instructions: string;
  connector: { type: string; config: { fileSearch: { protocol: string; toolPrefix: string } } };
};

describe('owncloud-file-search adapter: static spec conformance', () => {
  it('is a File Search catalog entry for webdav', () => {
    expect(a.connector.type).toBe('FILE_SEARCH');
    expect(a.connector.config.fileSearch.protocol).toBe('webdav');
    // The wizard asks for the server and credentials; the catalog asks for nothing.
    expect(a.requiredEnvVars).toEqual([]);
    expect(a.instructions.length).toBeGreaterThan(800);
  });

  it('shows the fixed File Search tools in the catalog, share_file off', () => {
    const tools = getAdapter('owncloud-file-search')!.tools as Array<{ name: string; enabled?: boolean }>;
    expect(tools.map((t) => t.name)).toEqual(
      ['guide', 'search', 'find', 'list', 'read', 'grep', 'status', 'view_page', 'get_file', 'share_file'].map((n) => `owncloud_files_${n}`),
    );
    expect(tools.find((t) => t.name === 'owncloud_files_share_file')!.enabled).toBe(false);
  });
});

// Live: the drivers are exercised against real servers in
// src/ee/file-search/file-search.integration.spec.ts (RUN_FILES_INTEGRATION=1, FILES_IT_WEBDAV).
const live = process.env.RUN_OWNCLOUD_FILE_SEARCH_LIVE === '1' && !!process.env.FILES_IT_WEBDAV;
(live ? describe : describe.skip)('owncloud-file-search adapter: live', () => {
  it('is covered by the File Search integration spec', () => {
    expect(process.env.FILES_IT_WEBDAV).toBeTruthy();
  });
});
