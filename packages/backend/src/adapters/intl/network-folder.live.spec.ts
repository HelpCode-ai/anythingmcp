import * as raw from './network-folder.json';
import { getAdapter } from '../catalog';

const a = raw as unknown as {
  slug: string;
  requiredEnvVars: string[];
  instructions: string;
  connector: { type: string; config: { fileSearch: { protocol: string; toolPrefix: string } } };
};

describe('network-folder adapter: static spec conformance', () => {
  it('is a File Search catalog entry for local', () => {
    expect(a.connector.type).toBe('FILE_SEARCH');
    expect(a.connector.config.fileSearch.protocol).toBe('local');
    // The wizard asks for the server and credentials; the catalog asks for nothing.
    expect(a.requiredEnvVars).toEqual([]);
    expect(a.instructions.length).toBeGreaterThan(800);
  });

  it('shows the fixed File Search tools in the catalog, share_file off', () => {
    const tools = getAdapter('network-folder')!.tools as Array<{ name: string; enabled?: boolean }>;
    expect(tools.map((t) => t.name)).toEqual(
      ['guide', 'search', 'find', 'list', 'read', 'grep', 'status', 'view_page', 'get_file', 'share_file'].map((n) => `network_folder_${n}`),
    );
    expect(tools.find((t) => t.name === 'network_folder_share_file')!.enabled).toBe(false);
  });
});

// Live: a network folder is a local path; the driver is covered by
// src/ee/file-search/file-search.integration.spec.ts and the File Search unit specs.
const live = process.env.RUN_NETWORK_FOLDER_LIVE === '1';
(live ? describe : describe.skip)('network-folder adapter: live', () => {
  it('needs FILE_SOURCE_ROOTS on this host', () => {
    expect(process.env.FILE_SOURCE_ROOTS).toBeTruthy();
  });
});
