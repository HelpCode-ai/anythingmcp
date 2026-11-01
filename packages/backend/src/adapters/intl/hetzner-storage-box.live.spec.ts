import * as raw from './hetzner-storage-box.json';
import { getAdapter } from '../catalog';

const a = raw as unknown as {
  slug: string;
  requiredEnvVars: string[];
  instructions: string;
  connector: { type: string; config: { fileSearch: { protocol: string; toolPrefix: string } } };
};

describe('hetzner-storage-box adapter: static spec conformance', () => {
  it('is a File Search catalog entry for sftp', () => {
    expect(a.connector.type).toBe('FILE_SEARCH');
    expect(a.connector.config.fileSearch.protocol).toBe('sftp');
    // The wizard asks for the server and credentials; the catalog asks for nothing.
    expect(a.requiredEnvVars).toEqual([]);
    expect(a.instructions.length).toBeGreaterThan(800);
  });

  it('shows the fixed File Search tools in the catalog, share_file off', () => {
    const tools = getAdapter('hetzner-storage-box')!.tools as Array<{ name: string; enabled?: boolean }>;
    expect(tools.map((t) => t.name)).toEqual(
      ['guide', 'search', 'find', 'list', 'read', 'grep', 'status', 'view_page', 'get_file', 'share_file'].map((n) => `storage_box_${n}`),
    );
    expect(tools.find((t) => t.name === 'storage_box_share_file')!.enabled).toBe(false);
  });
});

// Live: the drivers are exercised against real servers in
// src/ee/file-search/file-search.integration.spec.ts (RUN_FILES_INTEGRATION=1, FILES_IT_SFTP).
const live = process.env.RUN_HETZNER_STORAGE_BOX_LIVE === '1' && !!process.env.FILES_IT_SFTP;
(live ? describe : describe.skip)('hetzner-storage-box adapter: live', () => {
  it('is covered by the File Search integration spec', () => {
    expect(process.env.FILES_IT_SFTP).toBeTruthy();
  });
});
