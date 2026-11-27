import { fileParamNames, isFileRef, withFileRefHints } from './file-upload-params';
import { publicAllowed, sniffType } from './file-upload-sniff';
import { MAX_UPLOADS_PER_DAY, uploadQuotaFor, uploadsPerDayOverride } from './file-upload-quotas';

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

  describe('licence feature uploadsPerDay', () => {
    const MB = 1024 * 1024;

    it('keeps the plan default without the feature', () => {
      expect(uploadQuotaFor('team', { cloud: true, env: {} })?.uploadsPerDay).toBe(500);
      expect(uploadQuotaFor('team', { cloud: true, env: {}, features: null })?.uploadsPerDay).toBe(500);
      expect(uploadQuotaFor('team', { cloud: true, env: {}, features: { maxUsers: 3 } })?.uploadsPerDay).toBe(500);
    });

    it('replaces only the daily count when set', () => {
      expect(uploadQuotaFor('team', { cloud: true, env: {}, features: { uploadsPerDay: 2000 } })).toEqual({
        plan: 'team',
        maxFileBytes: 100 * MB,
        uploadsPerDay: 2000,
        maxStoredBytes: 10 * 1024 * MB,
        ttlHours: 8,
      });
      expect(uploadQuotaFor('starter', { cloud: true, env: {}, features: { uploadsPerDay: '2000' } })?.uploadsPerDay).toBe(2000);
      expect(uploadQuotaFor('starter', { cloud: true, env: {}, features: { uploadsPerDay: 2000 } })?.maxFileBytes).toBe(50 * MB);
    });

    it('falls back to the plan default for an invalid, zero or negative value', () => {
      for (const uploadsPerDay of [0, -5, 1.5, NaN, Infinity, '', 'lots', '20 00', null, true, {}]) {
        expect(uploadQuotaFor('team', { cloud: true, env: {}, features: { uploadsPerDay } })?.uploadsPerDay).toBe(500);
      }
      // The argument is the features object, not the field: a bare string or
      // array is not a features object, so there is no override.
      expect(uploadsPerDayOverride('2000')).toBeNull();
      expect(uploadsPerDayOverride([2000])).toBeNull();
    });

    it('clamps a value above the documented maximum', () => {
      expect(MAX_UPLOADS_PER_DAY).toBe(10_000);
      expect(uploadsPerDayOverride({ uploadsPerDay: 20_000_000 })).toBe(MAX_UPLOADS_PER_DAY);
      expect(uploadsPerDayOverride({ uploadsPerDay: '20000000' })).toBe(MAX_UPLOADS_PER_DAY);
      expect(uploadQuotaFor('team', { cloud: true, env: {}, features: { uploadsPerDay: 20_000_000 } })?.uploadsPerDay).toBe(10_000);
      expect(uploadQuotaFor('team', { cloud: true, env: {}, features: { uploadsPerDay: 10_000 } })?.uploadsPerDay).toBe(10_000);
    });

    it('raises the plan count but never lowers it', () => {
      expect(uploadQuotaFor('enterprise', { cloud: true, env: {}, features: { uploadsPerDay: 2000 } })?.uploadsPerDay).toBe(5_000);
      expect(uploadQuotaFor('enterprise', { cloud: true, env: {}, features: { uploadsPerDay: 8000 } })?.uploadsPerDay).toBe(8000);
      expect(uploadQuotaFor('team', { cloud: true, env: {}, features: { uploadsPerDay: 100 } })?.uploadsPerDay).toBe(500);
    });

    it('needs an active plan on Cloud and leaves self-hosted to its env', () => {
      expect(uploadQuotaFor(null, { cloud: true, env: {}, features: { uploadsPerDay: 2000 } })).toBeNull();
      expect(uploadQuotaFor(null, { cloud: false, env: {}, features: { uploadsPerDay: 2000 } })?.uploadsPerDay).toBeNull();
    });
  });
});
