import {
  AuditExportEncoder,
  csvCell,
  exportColumns,
  toExportRow,
  type ExportableInvocation,
} from './audit-export.format';

const row = (over: Partial<ExportableInvocation> = {}): ExportableInvocation => ({
  id: 'inv-1',
  createdAt: new Date('2026-10-20T08:15:00.000Z'),
  status: 'ERROR',
  durationMs: 812,
  repeatCount: 3,
  error: '429 Too Many Requests',
  clientInfo: JSON.stringify({
    authMethod: 'mcp_api_key',
    apiKeyName: 'ci-key',
    userEmail: 'bot@example.com',
    mcpServerName: 'Ops server',
  }),
  input: { q: 'Müller' },
  output: null,
  tool: { name: 'search_customers', connector: { name: 'CRM', type: 'REST' } },
  user: { email: 'jana@example.com' },
  mcpServer: { name: 'Main' },
  ...over,
});

describe('csvCell', () => {
  it('leaves plain values alone and writes nothing for null', () => {
    expect(csvCell('search_customers')).toBe('search_customers');
    expect(csvCell(812)).toBe('812');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes commas, quotes and line breaks (RFC 4180)', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line 1\nline 2')).toBe('"line 1\nline 2"');
    expect(csvCell('line 1\r\nline 2')).toBe('"line 1\r\nline 2"');
  });

  it('defuses cells a spreadsheet would run as a formula', () => {
    expect(csvCell('=HYPERLINK("http://evil","x")')).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\tcmd')).toBe("'\tcmd");
    expect(csvCell('\rcmd')).toBe(`"'\rcmd"`);
  });

  it('keeps non-ASCII text as it is', () => {
    expect(csvCell('Müller, Zürich')).toBe('"Müller, Zürich"');
  });
});

describe('toExportRow', () => {
  it('maps a stored row to the export columns', () => {
    expect(toExportRow(row(), false)).toEqual({
      createdAt: '2026-10-20T08:15:00.000Z',
      status: 'ERROR',
      tool: 'search_customers',
      connector: 'CRM',
      connectorType: 'REST',
      mcpServer: 'Main',
      userEmail: 'jana@example.com',
      authMethod: 'mcp_api_key',
      apiKeyName: 'ci-key',
      durationMs: 812,
      repeatCount: 3,
      error: '429 Too Many Requests',
    });
  });

  it('adds input and output only when payloads are asked for', () => {
    expect(toExportRow(row(), false)).not.toHaveProperty('input');
    expect(toExportRow(row(), true)).toMatchObject({ input: { q: 'Müller' }, output: null });
  });

  it('falls back to clientInfo when the user or server row is gone', () => {
    const mapped = toExportRow(row({ user: null, mcpServer: null }), false);
    expect(mapped.userEmail).toBe('bot@example.com');
    expect(mapped.mcpServer).toBe('Ops server');
  });

  it('leaves a hidden server blank instead of falling back to clientInfo', () => {
    const mapped = toExportRow(row({ mcpServer: null, serverHidden: true }), false);
    expect(mapped.mcpServer).toBeNull();
    expect(mapped.userEmail).toBe('jana@example.com');
  });

  it('survives clientInfo that is missing or not JSON', () => {
    for (const clientInfo of [null, 'not json', '"a string"']) {
      const mapped = toExportRow(row({ clientInfo, user: null, mcpServer: null }), false);
      expect(mapped).toMatchObject({ authMethod: null, apiKeyName: null, userEmail: null, mcpServer: null });
    }
  });
});

describe('exportColumns', () => {
  it('lists the same names in both formats, payload columns last', () => {
    expect(exportColumns(false)).toEqual([
      'createdAt',
      'status',
      'tool',
      'connector',
      'connectorType',
      'mcpServer',
      'userEmail',
      'authMethod',
      'apiKeyName',
      'durationMs',
      'repeatCount',
      'error',
    ]);
    expect(exportColumns(true).slice(-2)).toEqual(['input', 'output']);
  });
});

describe('AuditExportEncoder', () => {
  const encodeAll = (enc: AuditExportEncoder, batches: ExportableInvocation[][], truncated: boolean) => {
    let out = enc.start();
    let rowCount = 0;
    for (const batch of batches) {
      out += enc.rows(batch);
      rowCount += batch.length;
    }
    return out + enc.end({ rowCount, truncated });
  };

  it('writes CSV with a BOM, a header and CRLF line ends', () => {
    const csv = encodeAll(new AuditExportEncoder('csv', false), [[row()], [row({ status: 'SUCCESS', error: null })]], false);
    expect(csv.startsWith('﻿createdAt,status,tool,')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines).toHaveLength(4); // header, 2 rows, trailing empty string
    expect(lines[1]).toBe(
      '2026-10-20T08:15:00.000Z,ERROR,search_customers,CRM,REST,Main,jana@example.com,mcp_api_key,ci-key,812,3,429 Too Many Requests',
    );
    expect(lines[3]).toBe('');
    expect(csv).not.toContain('# truncated');
  });

  it('writes payloads in CSV as JSON text', () => {
    const csv = encodeAll(new AuditExportEncoder('csv', true), [[row()]], false);
    expect(csv).toContain(',"{""q"":""Müller""}",\r\n');
  });

  it('ends a capped CSV with a marker line', () => {
    const csv = encodeAll(new AuditExportEncoder('csv', false), [[row()]], true);
    expect(csv.endsWith('# truncated: this export stopped at 1 rows. Narrow the date range to export the rest.\r\n')).toBe(true);
  });

  it('writes JSON that parses, with rowCount and the truncation flag', () => {
    const json = encodeAll(new AuditExportEncoder('json', true), [[row()], [], [row({ id: 'inv-2' })]], false);
    const parsed = JSON.parse(json);
    expect(parsed.rowCount).toBe(2);
    expect(parsed.truncated).toBe(false);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({ tool: 'search_customers', input: { q: 'Müller' } });

    const capped = JSON.parse(encodeAll(new AuditExportEncoder('json', false), [[row()]], true));
    expect(capped.truncated).toBe(true);
    expect(capped.rows[0]).not.toHaveProperty('input');
  });

  it('writes a valid file when nothing matches', () => {
    expect(JSON.parse(encodeAll(new AuditExportEncoder('json', false), [], false))).toEqual({
      rows: [],
      rowCount: 0,
      truncated: false,
    });
    expect(encodeAll(new AuditExportEncoder('csv', false), [], false).split('\r\n')).toHaveLength(2);
  });
});
