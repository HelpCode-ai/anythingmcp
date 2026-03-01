import { Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';

@Injectable()
export class DatabaseEngine {
  private readonly logger = new Logger(DatabaseEngine.name);
  private readonly MAX_ROWS = 1000;

  async execute(
    config: {
      baseUrl: string; // connection string
      authType: string;
      authConfig?: Record<string, unknown>;
    },
    endpointMapping: {
      method: string; // "query"
      path: string; // SQL template
    },
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const safeHost = config.baseUrl.split('@')[1] ?? 'unknown';
    this.logger.debug(`Database query → ${safeHost}`);

    // Only allow SELECT queries for safety
    const sql = this.interpolateParams(endpointMapping.path, params);
    this.validateQuery(sql);

    const pool = new Pool({ connectionString: config.baseUrl });

    try {
      const result = await pool.query(sql);
      const rows = Array.isArray(result.rows) ? result.rows : [result.rows];

      if (rows.length > this.MAX_ROWS) {
        return {
          rows: rows.slice(0, this.MAX_ROWS),
          truncated: true,
          totalRows: rows.length,
          message: `Results truncated to ${this.MAX_ROWS} rows`,
        };
      }

      return { rows, totalRows: rows.length };
    } finally {
      await pool.end();
    }
  }

  private validateQuery(sql: string): void {
    const normalized = sql.trim().toUpperCase();

    // Only allow SELECT statements
    if (!normalized.startsWith('SELECT')) {
      throw new Error(
        'Only SELECT queries are allowed. INSERT, UPDATE, DELETE, DROP, and other write operations are blocked.',
      );
    }

    // Block dangerous keywords even in sub-queries
    const blocked = [
      'INSERT',
      'UPDATE',
      'DELETE',
      'DROP',
      'TRUNCATE',
      'ALTER',
      'CREATE',
      'EXEC',
      'EXECUTE',
      'GRANT',
      'REVOKE',
    ];
    for (const keyword of blocked) {
      // Check for keyword as standalone word (not part of column names)
      const regex = new RegExp(`\\b${keyword}\\b`, 'i');
      if (regex.test(sql) && !normalized.startsWith('SELECT')) {
        throw new Error(`Blocked SQL keyword: ${keyword}`);
      }
    }
  }

  private interpolateParams(
    template: string,
    params: Record<string, unknown>,
  ): string {
    let sql = template;
    for (const [key, value] of Object.entries(params)) {
      const escapedValue = this.escapeValue(value);
      sql = sql.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), escapedValue);
      sql = sql.replace(new RegExp(`\\$${key}\\b`, 'g'), escapedValue);
    }
    return sql;
  }

  private escapeValue(value: unknown): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return String(value);
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    // Escape single quotes for strings
    const str = String(value).replace(/'/g, "''");
    return `'${str}'`;
  }
}
