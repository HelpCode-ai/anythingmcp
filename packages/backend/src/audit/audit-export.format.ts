import type { AuditExportFormat } from './invocation-query.dto';

/** The fields of a tool_invocations row (with relations) an export reads. */
export interface ExportableInvocation {
  id: string;
  createdAt: Date;
  status: string;
  durationMs: number | null;
  repeatCount: number;
  error: string | null;
  clientInfo: string | null;
  input?: unknown;
  output?: unknown;
  tool: { name: string; connector: { name: string; type: string } | null } | null;
  user: { email: string } | null;
  mcpServer: { name: string } | null;
  /** Another member's server, for a restricted caller: no name, not even from clientInfo. */
  serverHidden?: boolean;
}

const COLUMNS = [
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
] as const;
const PAYLOAD_COLUMNS = ['input', 'output'] as const;

/** Column names, the same in CSV and JSON. */
export function exportColumns(payloads: boolean): string[] {
  return payloads ? [...COLUMNS, ...PAYLOAD_COLUMNS] : [...COLUMNS];
}

/** clientInfo is a JSON string written at call time; old or odd rows may not parse. */
function parseClientInfo(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function toExportRow(inv: ExportableInvocation, payloads: boolean): Record<string, unknown> {
  const ci = parseClientInfo(inv.clientInfo);
  const out: Record<string, unknown> = {
    createdAt: inv.createdAt.toISOString(),
    status: inv.status,
    tool: inv.tool?.name ?? null,
    connector: inv.tool?.connector?.name ?? null,
    connectorType: inv.tool?.connector?.type ?? null,
    mcpServer: inv.serverHidden ? null : (inv.mcpServer?.name ?? text(ci.mcpServerName)),
    userEmail: inv.user?.email ?? text(ci.userEmail),
    authMethod: text(ci.authMethod),
    apiKeyName: text(ci.apiKeyName),
    durationMs: inv.durationMs,
    // One stored row can stand for many identical failures (see AuditService).
    repeatCount: inv.repeatCount,
    error: inv.error,
  };
  if (payloads) {
    out.input = inv.input ?? null;
    out.output = inv.output ?? null;
  }
  return out;
}

/**
 * One CSV cell. Tool arguments, names and upstream errors are user- or
 * vendor-controlled, so a cell a spreadsheet would read as a formula gets a
 * leading `'`, then RFC 4180 quoting applies.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  let s = typeof value === 'string' ? value : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csvLine = (cells: unknown[]) => cells.map(csvCell).join(',') + '\r\n';

/**
 * Turns batches of rows into the chunks of an export file, so the caller can
 * write each batch as it arrives and never holds the whole file.
 *
 * CSV: UTF-8 BOM (Excel then reads umlauts correctly), a header line, CRLF.
 * JSON: one object, `{"rows":[...],"rowCount":n,"truncated":false}`.
 * A capped export ends with a `# truncated` line (CSV) or `truncated: true`.
 */
export class AuditExportEncoder {
  private readonly columns: string[];
  private first = true;

  constructor(
    private readonly format: AuditExportFormat,
    private readonly payloads: boolean,
  ) {
    this.columns = exportColumns(payloads);
  }

  start(): string {
    return this.format === 'csv' ? '﻿' + csvLine(this.columns) : '{"rows":[';
  }

  rows(batch: ExportableInvocation[]): string {
    let chunk = '';
    for (const inv of batch) {
      const row = toExportRow(inv, this.payloads);
      if (this.format === 'csv') {
        chunk += csvLine(this.columns.map((c) => row[c]));
      } else {
        chunk += (this.first ? '' : ',') + JSON.stringify(row);
        this.first = false;
      }
    }
    return chunk;
  }

  /** A truncated export stopped at the cap, so `rowCount` is the cap. */
  end({ rowCount, truncated }: { rowCount: number; truncated: boolean }): string {
    if (this.format === 'json') return `],"rowCount":${rowCount},"truncated":${truncated}}`;
    return truncated
      ? `# truncated: this export stopped at ${rowCount} rows. Narrow the date range to export the rest.\r\n`
      : '';
  }
}
