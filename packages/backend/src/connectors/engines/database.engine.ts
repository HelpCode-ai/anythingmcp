import { Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import * as mssql from 'mssql';
import { MongoClient } from 'mongodb';

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
      method: string; // "query" or "static"
      path: string; // SQL template
      staticResponse?: string;
    },
    params: Record<string, unknown>,
  ): Promise<unknown> {
    // Static response tools (e.g. example queries) — return text without DB execution
    if (endpointMapping.method === 'static' && endpointMapping.staticResponse) {
      return { text: endpointMapping.staticResponse };
    }

    // MongoDB uses JSON-based queries, not SQL
    if (this.isMongodb(config.baseUrl)) {
      return this.executeMongodb(config, endpointMapping, params);
    }

    // If the path is a single param reference like ${query}, use the raw value as SQL
    // (don't escape it as a string literal — it IS the SQL)
    const rawParamMatch = endpointMapping.path.match(/^\$\{(\w+)\}$/);
    const sql = rawParamMatch
      ? String(params[rawParamMatch[1]] || '')
      : this.interpolateParams(endpointMapping.path, params);
    this.validateQuery(sql);

    if (this.isMssql(config.baseUrl)) {
      return this.executeMssql(config, sql);
    }
    return this.executePostgres(config.baseUrl, sql);
  }

  /** Test connectivity — runs SELECT 1 (SQL) or ping (MongoDB) */
  async testConnection(config: {
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, unknown>;
  }): Promise<void> {
    if (this.isMongodb(config.baseUrl)) {
      const client = new MongoClient(config.baseUrl, {
        serverSelectionTimeoutMS: 10000,
      });
      try {
        await client.connect();
        await client.db().command({ ping: 1 });
      } finally {
        await client.close();
      }
    } else if (this.isMssql(config.baseUrl)) {
      const mssqlConfig = this.buildMssqlConfig(config);
      const pool = await mssql.connect(mssqlConfig);
      try {
        await pool.request().query('SELECT 1 AS ok');
      } finally {
        await pool.close();
      }
    } else {
      const pool = new Pool({ connectionString: config.baseUrl });
      try {
        await pool.query('SELECT 1');
      } finally {
        await pool.end();
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  PostgreSQL                                                         */
  /* ------------------------------------------------------------------ */

  private async executePostgres(
    connectionString: string,
    sql: string,
  ): Promise<unknown> {
    const safeHost = connectionString.split('@')[1] ?? 'unknown';
    this.logger.debug(`PostgreSQL query → ${safeHost}`);

    const pool = new Pool({ connectionString });
    try {
      const result = await pool.query(sql);
      const rows = Array.isArray(result.rows) ? result.rows : [result.rows];
      return this.truncateRows(rows);
    } finally {
      await pool.end();
    }
  }

  /* ------------------------------------------------------------------ */
  /*  MSSQL                                                              */
  /* ------------------------------------------------------------------ */

  private async executeMssql(
    config: {
      baseUrl: string;
      authType: string;
      authConfig?: Record<string, unknown>;
    },
    sql: string,
  ): Promise<unknown> {
    const mssqlConfig = this.buildMssqlConfig(config);
    this.logger.debug(`MSSQL query → ${mssqlConfig.server}/${mssqlConfig.database}`);

    const pool = await mssql.connect(mssqlConfig);
    try {
      const result = await pool.request().query(sql);
      const rows = result.recordset ?? [];
      return this.truncateRows(rows);
    } finally {
      await pool.close();
    }
  }

  /**
   * Build mssql config from the connector's baseUrl and authConfig.
   *
   * Supported formats:
   *   - mssql://user:pass@host/database           (SQL Server Auth via URL)
   *   - mssql://user:pass@host:1433/database       (with explicit port)
   *   - mssql://host/database + authConfig          (auth via connector config)
   *
   * authConfig fields:
   *   - username, password        → SQL Server Auth
   *   - username, password, domain → Windows / NTLM Auth
   */
  private buildMssqlConfig(config: {
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, unknown>;
  }): mssql.config {
    const url = new URL(config.baseUrl);

    const server = url.hostname;
    const port = url.port ? parseInt(url.port, 10) : 1433;
    const database = url.pathname.replace(/^\//, '') || undefined;

    // Credentials: prefer authConfig, fall back to URL
    const auth = config.authConfig || {};
    const user =
      (auth.username as string) || decodeURIComponent(url.username) || undefined;
    const password =
      (auth.password as string) || decodeURIComponent(url.password) || undefined;
    const domain = auth.domain as string | undefined;

    const baseConfig: mssql.config = {
      server,
      port,
      database,
      options: {
        encrypt: false,
        trustServerCertificate: true,
      },
      requestTimeout: 30000,
      connectionTimeout: 15000,
    };

    if (domain) {
      // Windows / NTLM Authentication
      this.logger.debug(`MSSQL auth: Windows (NTLM) domain=${domain}`);
      baseConfig.authentication = {
        type: 'ntlm',
        options: {
          domain,
          userName: user || '',
          password: password || '',
        },
      };
    } else if (user) {
      // SQL Server Authentication
      this.logger.debug(`MSSQL auth: SQL Server user=${user}`);
      baseConfig.user = user;
      baseConfig.password = password;
    }

    return baseConfig;
  }

  /* ------------------------------------------------------------------ */
  /*  MongoDB                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Execute a MongoDB read-only query.
   *
   * endpointMapping.path is a JSON string describing the query:
   *   { "collection": "users", "filter": { "age": { "$gt": 18 } } }
   *
   * Or the path can be a param reference like ${query} whose value is a
   * JSON string with { collection, filter?, projection?, sort?, limit? }.
   */
  private async executeMongodb(
    config: { baseUrl: string; authConfig?: Record<string, unknown> },
    endpointMapping: { method: string; path: string },
    params: Record<string, unknown>,
  ): Promise<unknown> {
    // Resolve the query spec (may be a param reference or inline JSON)
    const rawParamMatch = endpointMapping.path.match(/^\$\{(\w+)\}$/);
    const queryStr = rawParamMatch
      ? String(params[rawParamMatch[1]] || '{}')
      : this.interpolateMongoParams(endpointMapping.path, params);

    let spec: {
      collection: string;
      filter?: Record<string, unknown>;
      projection?: Record<string, unknown>;
      sort?: Record<string, unknown>;
      limit?: number;
    };

    try {
      spec = JSON.parse(queryStr);
    } catch {
      throw new Error(
        'MongoDB query must be a valid JSON object with at least a "collection" field',
      );
    }

    if (!spec.collection) {
      throw new Error('MongoDB query must specify a "collection" field');
    }

    const client = new MongoClient(config.baseUrl, {
      serverSelectionTimeoutMS: 10000,
    });

    try {
      await client.connect();
      const db = client.db(); // uses the database from the connection string

      this.logger.debug(`MongoDB query → ${spec.collection}`);

      let cursor = db
        .collection(spec.collection)
        .find(spec.filter || {}, { projection: spec.projection });

      if (spec.sort) {
        cursor = cursor.sort(spec.sort as any);
      }

      const limit = Math.min(spec.limit || this.MAX_ROWS, this.MAX_ROWS);
      cursor = cursor.limit(limit);

      const rows = await cursor.toArray();
      return this.truncateRows(rows as Record<string, unknown>[]);
    } finally {
      await client.close();
    }
  }

  private interpolateMongoParams(
    template: string,
    params: Record<string, unknown>,
  ): string {
    let result = template;
    for (const [key, value] of Object.entries(params)) {
      const jsonValue = JSON.stringify(value);
      result = result.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), jsonValue);
      result = result.replace(new RegExp(`\\$${key}\\b`, 'g'), jsonValue);
    }
    return result;
  }

  /* ------------------------------------------------------------------ */
  /*  Shared helpers                                                     */
  /* ------------------------------------------------------------------ */

  private isMongodb(baseUrl: string): boolean {
    return baseUrl.startsWith('mongodb://') || baseUrl.startsWith('mongodb+srv://');
  }

  private isMssql(baseUrl: string): boolean {
    return baseUrl.startsWith('mssql://');
  }

  private truncateRows(rows: Record<string, unknown>[]): unknown {
    if (rows.length > this.MAX_ROWS) {
      return {
        rows: rows.slice(0, this.MAX_ROWS),
        truncated: true,
        totalRows: rows.length,
        message: `Results truncated to ${this.MAX_ROWS} rows`,
      };
    }
    return { rows, totalRows: rows.length };
  }

  private validateQuery(sql: string): void {
    const normalized = sql.trim().toUpperCase();

    if (!normalized.startsWith('SELECT')) {
      throw new Error(
        'Only SELECT queries are allowed. INSERT, UPDATE, DELETE, DROP, and other write operations are blocked.',
      );
    }

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
    const str = String(value).replace(/'/g, "''");
    return `'${str}'`;
  }
}
