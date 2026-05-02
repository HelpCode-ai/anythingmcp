import { Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import * as mssql from 'mssql';
import { MongoClient } from 'mongodb';
import * as mysql from 'mysql2/promise';
import * as oracledb from 'oracledb';
import Database from 'better-sqlite3';

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
    options?: { readOnly?: boolean },
  ): Promise<unknown> {
    const readOnly = options?.readOnly !== false; // default true
    // Static response tools (e.g. example queries) — return text without DB execution
    if (endpointMapping.method === 'static' && endpointMapping.staticResponse) {
      return { text: endpointMapping.staticResponse };
    }

    // MongoDB schema introspection
    if (endpointMapping.method === 'mongo_schema' && this.isMongodb(config.baseUrl)) {
      return this.getMongoSchema(config);
    }

    // MongoDB uses JSON-based queries, not SQL
    if (this.isMongodb(config.baseUrl)) {
      return this.executeMongodb(config, endpointMapping, params);
    }

    // If the path is a single param reference like ${query}, use the raw value as SQL.
    // The query value is fully untrusted; rely on validateQuery() (in readOnly mode)
    // and on the database role's grants. Prepared statements cannot help here because
    // the entire statement comes from the caller.
    const rawParamMatch = endpointMapping.path.match(/^\$\{(\w+)\}$/);
    const isRawSql = !!rawParamMatch;

    if (isRawSql) {
      const sql = String(params[rawParamMatch![1]] || '');
      if (readOnly) {
        this.validateQuery(sql);
      }
      return this.dispatch(config, sql, [], readOnly);
    }

    // Templated SQL: compile ${name} / $name placeholders to driver-specific
    // parameterised queries. Values are bound, never inlined.
    const driver = this.detectDriver(config.baseUrl);
    const { sql, values } = compileParameterized(
      endpointMapping.path,
      params,
      driver,
    );
    if (readOnly) {
      this.validateQuery(sql);
    }
    return this.dispatch(config, sql, values, readOnly);
  }

  private detectDriver(baseUrl: string): SqlDriver {
    if (this.isMssql(baseUrl)) return 'mssql';
    if (this.isMysql(baseUrl)) return 'mysql';
    if (this.isOracle(baseUrl)) return 'oracle';
    if (this.isSqlite(baseUrl)) return 'sqlite';
    return 'postgres';
  }

  private dispatch(
    config: { baseUrl: string; authType: string; authConfig?: Record<string, unknown> },
    sql: string,
    values: unknown[],
    readOnly: boolean,
  ): Promise<unknown> {
    if (this.isMssql(config.baseUrl)) {
      return this.executeMssql(config, sql, values);
    }
    if (this.isMysql(config.baseUrl)) {
      return this.executeMysql(config, sql, values);
    }
    if (this.isOracle(config.baseUrl)) {
      return this.executeOracle(config, sql, values);
    }
    if (this.isSqlite(config.baseUrl)) {
      return Promise.resolve(
        this.executeSqlite(config.baseUrl, sql, values, readOnly),
      );
    }
    return this.executePostgres(config.baseUrl, sql, values);
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
    } else if (this.isMysql(config.baseUrl)) {
      const conn = await mysql.createConnection(this.mysqlUri(config.baseUrl));
      try {
        await conn.query('SELECT 1');
      } finally {
        await conn.end();
      }
    } else if (this.isOracle(config.baseUrl)) {
      const oraConfig = this.buildOracleConfig(config);
      const conn = await oracledb.getConnection(oraConfig);
      try {
        await conn.execute('SELECT 1 FROM DUAL');
      } finally {
        await conn.close();
      }
    } else if (this.isSqlite(config.baseUrl)) {
      const filePath = this.sqlitePath(config.baseUrl);
      const db = new Database(filePath, { readonly: true });
      try {
        db.prepare('SELECT 1').get();
      } finally {
        db.close();
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
    values: unknown[] = [],
  ): Promise<unknown> {
    const safeHost = connectionString.split('@')[1] ?? 'unknown';
    this.logger.debug(`PostgreSQL query → ${safeHost}`);

    const pool = new Pool({ connectionString });
    try {
      const result =
        values.length > 0 ? await pool.query(sql, values) : await pool.query(sql);
      if (result.rows && result.rows.length > 0) {
        const rows = Array.isArray(result.rows) ? result.rows : [result.rows];
        return this.truncateRows(rows);
      }
      // Write operations return rowCount instead of rows
      return { rowCount: result.rowCount, command: result.command };
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
    values: unknown[] = [],
  ): Promise<unknown> {
    const mssqlConfig = this.buildMssqlConfig(config);
    this.logger.debug(`MSSQL query → ${mssqlConfig.server}/${mssqlConfig.database}`);

    const pool = await mssql.connect(mssqlConfig);
    try {
      const request = pool.request();
      values.forEach((value, idx) => {
        request.input(`p${idx}`, value as any);
      });
      const result = await request.query(sql);
      if (result.recordset && result.recordset.length > 0) {
        return this.truncateRows(result.recordset);
      }
      // Write operations return rowsAffected
      return { rowsAffected: result.rowsAffected?.[0] ?? 0 };
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

  /**
   * Introspect a MongoDB database: list collections and sample one document
   * per collection to infer field names and types.
   */
  private async getMongoSchema(
    config: { baseUrl: string; authConfig?: Record<string, unknown> },
  ): Promise<unknown> {
    const client = new MongoClient(config.baseUrl, {
      serverSelectionTimeoutMS: 10000,
    });

    try {
      await client.connect();
      const db = client.db();

      const collectionInfos = await db.listCollections().toArray();
      const collections: Array<{
        name: string;
        type: string;
        documentCount?: number;
        sampleFields: Array<{ field: string; type: string; example?: unknown }>;
      }> = [];

      for (const info of collectionInfos) {
        const col = db.collection(info.name);
        const count = await col.estimatedDocumentCount();
        const sample = await col.findOne();

        const sampleFields: Array<{ field: string; type: string; example?: unknown }> = [];
        if (sample) {
          for (const [key, value] of Object.entries(sample)) {
            const fieldType = value === null
              ? 'null'
              : Array.isArray(value)
                ? 'array'
                : typeof value === 'object' && value instanceof Date
                  ? 'date'
                  : typeof value === 'object' && (value as any)?._bsontype === 'ObjectId'
                    ? 'ObjectId'
                    : typeof value;

            // Provide a short example (truncate strings, stringify objects)
            let example: unknown = value;
            if (typeof value === 'string' && value.length > 80) {
              example = value.slice(0, 80) + '...';
            } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
              example = `{${Object.keys(value as object).join(', ')}}`;
            } else if (Array.isArray(value)) {
              example = `[${value.length} items]`;
            }

            sampleFields.push({ field: key, type: fieldType, example });
          }
        }

        collections.push({
          name: info.name,
          type: info.type || 'collection',
          documentCount: count,
          sampleFields,
        });
      }

      return { collections };
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
  /*  MySQL / MariaDB                                                    */
  /* ------------------------------------------------------------------ */

  private async executeMysql(
    config: {
      baseUrl: string;
      authType: string;
      authConfig?: Record<string, unknown>;
    },
    sql: string,
    values: unknown[] = [],
  ): Promise<unknown> {
    const uri = this.mysqlUri(config.baseUrl);
    this.logger.debug(`MySQL query → ${new URL(uri).hostname}`);

    const conn = await mysql.createConnection(uri);
    try {
      const [result] =
        values.length > 0
          ? await conn.execute(sql, values as any[])
          : await conn.query(sql);
      if (Array.isArray(result)) {
        return this.truncateRows(result as Record<string, unknown>[]);
      }
      // Write operations return OkPacket
      const info = result as any;
      return { affectedRows: info.affectedRows, insertId: info.insertId };
    } finally {
      await conn.end();
    }
  }

  /** Normalize mariadb:// to mysql:// since mysql2 only understands mysql:// */
  private mysqlUri(baseUrl: string): string {
    if (baseUrl.startsWith('mariadb://')) {
      return 'mysql://' + baseUrl.slice('mariadb://'.length);
    }
    return baseUrl;
  }

  /* ------------------------------------------------------------------ */
  /*  Oracle                                                             */
  /* ------------------------------------------------------------------ */

  private async executeOracle(
    config: {
      baseUrl: string;
      authType: string;
      authConfig?: Record<string, unknown>;
    },
    sql: string,
    values: unknown[] = [],
  ): Promise<unknown> {
    const oraConfig = this.buildOracleConfig(config);
    this.logger.debug(`Oracle query → ${oraConfig.connectString}`);

    const conn = await oracledb.getConnection(oraConfig);
    try {
      const result = await conn.execute(sql, values as any[], {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        autoCommit: true,
      });
      if (result.rows && result.rows.length > 0) {
        return this.truncateRows(result.rows as Record<string, unknown>[]);
      }
      // Write operations return rowsAffected
      return { rowsAffected: result.rowsAffected ?? 0 };
    } finally {
      await conn.close();
    }
  }

  /**
   * Parse oracle://user:pass@host:1521/service_name into oracledb config.
   */
  private buildOracleConfig(config: {
    baseUrl: string;
    authConfig?: Record<string, unknown>;
  }): oracledb.ConnectionAttributes {
    const url = new URL(config.baseUrl.replace(/^oracledb:\/\//, 'oracle://'));
    const auth = config.authConfig || {};

    const user = (auth.username as string) || decodeURIComponent(url.username) || undefined;
    const password = (auth.password as string) || decodeURIComponent(url.password) || undefined;
    const host = url.hostname;
    const port = url.port || '1521';
    const serviceName = url.pathname.replace(/^\//, '') || undefined;

    return {
      user,
      password,
      connectString: `${host}:${port}/${serviceName}`,
    };
  }

  /* ------------------------------------------------------------------ */
  /*  SQLite                                                             */
  /* ------------------------------------------------------------------ */

  private executeSqlite(
    baseUrl: string,
    sql: string,
    values: unknown[] = [],
    readOnly = true,
  ): unknown {
    const filePath = this.sqlitePath(baseUrl);
    this.logger.debug(`SQLite query → ${filePath}`);

    const db = new Database(filePath, { readonly: readOnly });
    try {
      const stmt = db.prepare(sql);
      if (stmt.reader) {
        const rows = stmt.all(...(values as any[])) as Record<string, unknown>[];
        return this.truncateRows(rows);
      }
      // Write statement (INSERT, UPDATE, DELETE, etc.)
      const info = stmt.run(...(values as any[]));
      return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
    } finally {
      db.close();
    }
  }

  /** Extract file path from sqlite:///absolute/path or sqlite://./relative */
  private sqlitePath(baseUrl: string): string {
    // sqlite:///absolute/path → /absolute/path
    // sqlite://./relative     → ./relative
    // sqlite:/path            → /path
    const stripped = baseUrl.replace(/^sqlite:\/\//, '');
    if (stripped.startsWith('/')) return stripped;
    return stripped;
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

  private isMysql(baseUrl: string): boolean {
    return baseUrl.startsWith('mysql://') || baseUrl.startsWith('mariadb://');
  }

  private isOracle(baseUrl: string): boolean {
    return baseUrl.startsWith('oracle://') || baseUrl.startsWith('oracledb://');
  }

  private isSqlite(baseUrl: string): boolean {
    return baseUrl.startsWith('sqlite://') || baseUrl.startsWith('sqlite:');
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

}

export type SqlDriver = 'postgres' | 'mysql' | 'mssql' | 'oracle' | 'sqlite';

/**
 * Compile a SQL template with `${name}` or `$name` placeholders into a
 * parameterised query for the given driver. Each placeholder becomes a
 * positional or named bind variable; values are returned in the order the
 * driver expects them.
 *
 * - postgres   →  `$1, $2, ...`
 * - mysql      →  `?, ?, ...` (bound via `connection.execute()`)
 * - mssql      →  `@p0, @p1, ...` (bound via `request.input('p0', value)`)
 * - oracle     →  `:b0, :b1, ...` (positional array)
 * - sqlite     →  `?, ?, ...`
 *
 * The same param name appearing twice in the template is bound twice (once
 * per occurrence) to keep the indices simple. A reference to a parameter
 * that is not present in `params` is left unresolved (yielding a SQL error
 * at execution time, not a SQL injection).
 */
export function compileParameterized(
  template: string,
  params: Record<string, unknown>,
  driver: SqlDriver,
): { sql: string; values: unknown[] } {
  const values: unknown[] = [];
  const sql = template.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)\b/g,
    (match, brace: string | undefined, bare: string | undefined) => {
      const name = brace || bare;
      if (!name || !Object.prototype.hasOwnProperty.call(params, name)) {
        return match;
      }
      values.push(params[name]);
      return placeholderFor(driver, values.length);
    },
  );
  return { sql, values };
}

function placeholderFor(driver: SqlDriver, oneBasedIndex: number): string {
  switch (driver) {
    case 'postgres':
      return `$${oneBasedIndex}`;
    case 'mssql':
      return `@p${oneBasedIndex - 1}`;
    case 'oracle':
      return `:b${oneBasedIndex - 1}`;
    case 'mysql':
    case 'sqlite':
    default:
      return '?';
  }
}
