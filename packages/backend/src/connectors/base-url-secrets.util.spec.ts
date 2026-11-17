import {
  BASE_URL_SECRET_MASK,
  baseUrlSecrets,
  hasHttpBaseUrl,
  keepMaskedBaseUrl,
  maskBaseUrlSecrets,
} from './base-url-secrets.util';
import { toPublicConnector } from './connector-secrets.util';
import { toExportEntry } from './connector-export.util';

const BITRIX = ['k2bx', 'a8g5', 'n4gh', 'vqgo'].join('');
const BITRIX_URL = `https://portal.bitrix24.com/rest/1/${BITRIX}/`;
const OPAQUE = 'q8ZtW3nRk2LxV9pMbH4cJs7YdF6gTe1A';

describe('base URL secrets', () => {
  it('checks the HTTP connector types only', () => {
    for (const type of ['REST', 'GRAPHQL', 'SOAP', 'MCP', 'ODATA']) expect(hasHttpBaseUrl(type)).toBe(true);
    for (const type of ['DATABASE', 'EMAIL', 'FILE_SEARCH', 'WEBHOOK', undefined]) expect(hasHttpBaseUrl(type)).toBe(false);
  });

  it('uses every rule of a save but the long-random-token one', () => {
    expect(baseUrlSecrets(BITRIX_URL)).toHaveLength(1);
    expect(baseUrlSecrets('https://maps.example.com/api?key=a1b2c3d4e5f6')).toHaveLength(1);
    expect(baseUrlSecrets(`https://api.example.com/files/x/${OPAQUE}`)).toEqual([]);
    expect(baseUrlSecrets(null)).toEqual([]);
  });

  it('masks only the secret, and leaves references and clean URLs alone', () => {
    expect(maskBaseUrlSecrets(BITRIX_URL)).toBe(`https://portal.bitrix24.com/rest/1/${BASE_URL_SECRET_MASK}/`);
    expect(maskBaseUrlSecrets('https://u:Pa55w0rd-1@api.example.com/?token=abc123def456')).toBe(
      'https://u:********@api.example.com/?token=********',
    );
    expect(maskBaseUrlSecrets('https://portal.bitrix24.com/rest/1/{{B_WEBHOOK_TOKEN}}/')).toBe(
      'https://portal.bitrix24.com/rest/1/{{B_WEBHOOK_TOKEN}}/',
    );
    expect(maskBaseUrlSecrets('https://api.example.com/v1')).toBe('https://api.example.com/v1');
  });

  describe('an edit made against the masked view', () => {
    it('keeps the stored URL when the masked one comes back unchanged', () => {
      expect(keepMaskedBaseUrl(maskBaseUrlSecrets(BITRIX_URL), BITRIX_URL)).toBe(BITRIX_URL);
    });

    it('takes a retyped URL as sent', () => {
      const other = `https://portal.bitrix24.com/rest/2/${BITRIX}/`;
      expect(keepMaskedBaseUrl(other, BITRIX_URL)).toBe(other);
    });

    it('cannot rebuild a URL edited around the mask', () => {
      expect(keepMaskedBaseUrl(`https://other.bitrix24.com/rest/1/${BASE_URL_SECRET_MASK}/`, BITRIX_URL)).toBeNull();
    });

    it('changes nothing when nothing stored was masked', () => {
      expect(keepMaskedBaseUrl('https://api.example.com/v2', 'https://api.example.com/v1')).toBe(
        'https://api.example.com/v2',
      );
    });
  });

  describe('API output', () => {
    const connector = {
      id: 'c1',
      name: 'Bitrix',
      type: 'REST',
      baseUrl: BITRIX_URL,
      headers: null,
      envVars: { BITRIX_WEBHOOK_TOKEN: BITRIX, PORTAL: 'portal' },
      config: { adapterSlug: 'custom', baseUrlBaseline: BITRIX_URL },
      authConfig: 'encrypted',
      tools: [],
    };

    it('never returns the secret of a base URL, to anyone', () => {
      const out = toPublicConnector(connector);
      expect(out.baseUrl).toBe(`https://portal.bitrix24.com/rest/1/${BASE_URL_SECRET_MASK}/`);
      expect((out.config as any).baseUrlBaseline).toBe(out.baseUrl);
      expect((out.config as any).adapterSlug).toBe('custom');
      expect(out.envVars).toEqual({ BITRIX_WEBHOOK_TOKEN: '', PORTAL: 'portal' });
      expect(out.maskedEnvVars).toEqual(['BITRIX_WEBHOOK_TOKEN']);
      expect(JSON.stringify(out)).not.toContain(BITRIX);
    });

    it('nor in an export without secrets', () => {
      expect(JSON.stringify(toExportEntry(connector, false))).not.toContain(BITRIX);
    });

    it('shows a repaired connector as it is stored', () => {
      const repaired = { ...connector, baseUrl: 'https://portal.bitrix24.com/rest/1/{{BITRIX_WEBHOOK_TOKEN}}/', config: null };
      expect(toPublicConnector(repaired).baseUrl).toBe(repaired.baseUrl);
    });

    it('leaves a DATABASE connection string to its own masking', () => {
      const db = { ...connector, type: 'DATABASE', baseUrl: 'postgresql://u:s3cret@db.example.com/x', config: null };
      expect(toPublicConnector(db).baseUrl).toBe('postgresql://u:********@db.example.com/x');
    });
  });
});
