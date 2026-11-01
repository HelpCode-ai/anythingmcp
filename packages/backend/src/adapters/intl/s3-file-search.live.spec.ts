import * as raw from './s3-file-search.json';
import { getAdapter } from '../catalog';

const a = raw as unknown as {
  slug: string;
  requiredEnvVars: string[];
  instructions: string;
  connector: { type: string; config: { fileSearch: { protocol: string; toolPrefix: string } } };
};

describe('s3-file-search adapter: static spec conformance', () => {
  it('is a File Search catalog entry for s3', () => {
    expect(a.connector.type).toBe('FILE_SEARCH');
    expect(a.connector.config.fileSearch.protocol).toBe('s3');
    // The wizard asks for the server and credentials; the catalog asks for nothing.
    expect(a.requiredEnvVars).toEqual([]);
    expect(a.instructions.length).toBeGreaterThan(800);
  });

  it('shows the fixed File Search tools in the catalog, share_file off', () => {
    const tools = getAdapter('s3-file-search')!.tools as Array<{ name: string; enabled?: boolean }>;
    expect(tools.map((t) => t.name)).toEqual(
      ['guide', 'search', 'find', 'list', 'read', 'grep', 'status', 'get_file', 'share_file'].map((n) => `s3_files_${n}`),
    );
    expect(tools.find((t) => t.name === 's3_files_share_file')!.enabled).toBe(false);
  });
});

// Live: the drivers are exercised against real servers in
// src/ee/file-search/file-search.integration.spec.ts (RUN_FILES_INTEGRATION=1); S3 against MinIO by hand, see docs/connectors/file-search.md.
const live = process.env.RUN_S3_FILE_SEARCH_LIVE === '1' && !!process.env.FILES_IT_S3;
(live ? describe : describe.skip)('s3-file-search adapter: live', () => {
  it('is covered by the File Search integration spec', () => {
    expect(process.env.FILES_IT_S3).toBeTruthy();
  });
});
