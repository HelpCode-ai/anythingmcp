import { fileParamNames, isFileRef, withFileRefHints } from './file-upload-params';
import { publicAllowed, sniffType } from './file-upload-sniff';
import { uploadQuotaFor } from './file-upload-quotas';

describe('file upload helpers', () => {
  it('finds the parameters behind __file markers only', () => {
    expect(fileParamNames({ image: { __file: '$image_url' }, rank: '$rank', alt: { __json: '$x' } })).toEqual(['image_url']);
    expect(fileParamNames(undefined)).toEqual([]);
    expect(fileParamNames({ file: { __file: 'https://fixed' } })).toEqual([]);
  });

  it('adds the reference hint to file parameters, once', () => {
    const schema = { type: 'object', properties: { file_url: { type: 'string', description: 'Public URL.' }, name: { type: 'string' } } };
    const hinted = withFileRefHints(schema, { file: { __file: '$file_url' } });
    expect(hinted.properties.file_url.description).toMatch(/^Public URL\. Or, .*amcp-file:<id>.*file_upload_link/);
    expect(hinted.properties.name).toBe(schema.properties.name);
    expect(withFileRefHints(hinted, { file: { __file: '$file_url' } })).toBe(hinted);
    expect(withFileRefHints(schema, { name: '$name' })).toBe(schema);
  });

  it('recognises references strictly', () => {
    expect(isFileRef('amcp-file:0123456789abcdef01234567')).toBe(true);
    expect(isFileRef('amcp-file:../../etc')).toBe(false);
    expect(isFileRef('https://x/amcp-file:0123456789abcdef01234567')).toBe(false);
  });

  it('sniffs types and allows public links only when bytes and extension agree', () => {
    expect(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniffType(Buffer.from('%PDF-1.7'))).toBe('pdf');
    expect(sniffType(Buffer.from('\0\0\0\x18ftypmp42', 'latin1'))).toBe('mp4');
    expect(publicAllowed('a.jpg', 'image/jpeg')).toBe(true);
    expect(publicAllowed('a.jpg', 'image/png')).toBe(false);
    expect(publicAllowed('a.zip', 'application/zip')).toBe(false);
    expect(publicAllowed('a.mov', 'video/mp4')).toBe(true);
  });

  it('has per-plan caps on Cloud and env-driven caps on self-hosted', () => {
    expect(uploadQuotaFor('starter', { cloud: true, env: {} })).toMatchObject({ maxFileBytes: 50 * 1024 * 1024, uploadsPerDay: 150, ttlHours: 8 });
    expect(uploadQuotaFor('team', { cloud: true, env: {} })?.maxFileBytes).toBe(100 * 1024 * 1024);
    expect(uploadQuotaFor(null, { cloud: true, env: {} })).toBeNull();
    expect(uploadQuotaFor(null, { cloud: false, env: {} })).toMatchObject({ uploadsPerDay: null, maxStoredBytes: null });
    expect(uploadQuotaFor(null, { cloud: false, env: { FILE_UPLOADS_TTL_HOURS: '2' } })?.ttlHours).toBe(2);
  });
});
