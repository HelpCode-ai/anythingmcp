import { Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import * as mssql from 'mssql';
import { MongoClient } from 'mongodb';
import * as mysql from 'mysql2/promise';
import * as oracledb from 'oracledb';
import Database from 'better-sqlite3';
import { assertSafeOutboundHost } from '../../common/ssrf.util';
import {
  HanaConnectOptions,
  HanaDriverName,
  openHanaSession,
  resolveHanaDriverName,
} from './hana.driver';
import { renderStaticResponse } from '../static-response.util';

@Injectable()
export class DatabaseEngine {
  private readonly logger = new Logger(DatabaseEngine.name);
  private readonly MAX_ROWS = 1000;
  // Upper bound on an incoming SQL string. The query is untrusted; capping its
  // length bounds the read-only lexical scan below (no unbounded work on a
  // hostile, oversized payload). 100k chars is far beyond any real analytics query.
  private readonly MAX_QUERY_LENGTH = 100_000;
  // Server-side ceiling on one statement. An agent's unbounded scan on a
  // production ERP would otherwise run until someone kills it by hand.
  // MSSQL keeps its own 30 s request timeout; HANA reads `statementTimeout`
  // from its connection string (see buildHanaConfig).
  private readonly STATEMENT_TIMEOUT_MS = 60_000;
  private readonly CONNECT_TIMEOUT_MS = 15_000;

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
      staticResponses?: Record<string, unknown>;
      topicParam?: string;
    },
    params: Record<string, unknown>,
    options?: { readOnly?: boolean; deniedTables?: unknown },
  ): Promise<unknown> {
    const readOnly = options?.readOnly !== false; // default true
    const deniedTables = normalizeDeniedTables(options?.deniedTables);
    // Static response tools (e.g. example queries) — return text without DB execution
    if (
      endpointMapping.method === 'static' &&
      (endpointMapping.staticResponse || endpointMapping.staticResponses)
    ) {
      return { text: renderStaticResponse(endpointMapping, params) };
    }

    // SSRF guard: a connector's connection string is user-supplied, so block it
    // from reaching internal/metadata hosts before any driver opens a socket.
    await this.assertSafeDbHost(config.baseUrl);

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
      this.assertNoDeniedTables(sql, deniedTables);
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
    this.assertNoDeniedTables(sql, deniedTables);
    return this.dispatch(config, sql, values, readOnly);
  }

  /**
   * Merge credentials held in the connector's encrypted `authConfig` into the
   * connection URL.
   *
   * The mssql and oracle drivers take user/password as config fields, so they
   * already read `authConfig` (see buildMssqlConfig / buildOracleConfig). pg,
   * mysql2 and the Mongo driver only take a URL, which would force an adapter
   * to carry the password in the plaintext `baseUrl` column. Splicing it in
   * here keeps the secret in `authConfig`, which is encrypted at rest.
   *
   * A username already present in the URL wins: it is the more specific
   * statement, and overriding it would silently break existing connectors.
   */
  private withUrlCredentials(
    baseUrl: string,
    authConfig?: Record<string, unknown>,
  ): string {
    const username = authConfig?.username;
    if (typeof username !== 'string' || username === '') return baseUrl;
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      return baseUrl; // not a URL we can edit — hand it to the driver as-is
    }
    if (url.username) return baseUrl;
    url.username = encodeURIComponent(username);
    const password = authConfig?.password;
    if (typeof password === 'string' && password !== '') {
      url.password = encodeURIComponent(password);
    }
    return url.toString();
  }

  private detectDriver(baseUrl: string): SqlDriver {
    if (this.isHana(baseUrl)) return 'hana';
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
    if (this.isHana(config.baseUrl)) {
      return this.executeHana(config, sql, values, readOnly);
    }
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
    return this.executePostgres(config, sql, values);
  }

  /** Test connectivity — runs SELECT 1 (SQL) or ping (MongoDB) */
  async testConnection(config: {
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, unknown>;
  }): Promise<void> {
    await this.assertSafeDbHost(config.baseUrl);
    if (this.isMongodb(config.baseUrl)) {
      const client = new MongoClient(
        this.withUrlCredentials(config.baseUrl, config.authConfig),
        { serverSelectionTimeoutMS: 10000 },
      );
      try {
        await client.connect();
        await client.db().command({ ping: 1 });
      } finally {
        await client.close();
      }
    } else if (this.isHana(config.baseUrl)) {
      await this.executeHana(config, 'SELECT 1 AS OK FROM DUMMY', [], true);
    } else if (this.isMssql(config.baseUrl)) {
      const mssqlConfig = this.buildMssqlConfig(config);
      const pool = await mssql.connect(mssqlConfig);
      try {
        await pool.request().query('SELECT 1 AS ok');
      } finally {
        await pool.close();
      }
    } else if (this.isMysql(config.baseUrl)) {
      const conn = await mysql.createConnection(
        this.mysqlUri(config.baseUrl, config.authConfig),
      );
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
      const pool = new Pool({
        connectionString: this.withUrlCredentials(
          config.baseUrl,
          config.authConfig,
        ),
      });
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
    config: { baseUrl: string; authConfig?: Record<string, unknown> },
    sql: string,
    values: unknown[] = [],
  ): Promise<unknown> {
    const connectionString = this.withUrlCredentials(
      config.baseUrl,
      config.authConfig,
    );
    const safeHost = connectionString.split('@')[1] ?? 'unknown';
    this.logger.debug(`PostgreSQL query → ${safeHost}`);

    const pool = new Pool({
      connectionString,
      statement_timeout: this.STATEMENT_TIMEOUT_MS,
      connectionTimeoutMillis: this.CONNECT_TIMEOUT_MS,
    });
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

    const client = new MongoClient(
      this.withUrlCredentials(config.baseUrl, config.authConfig),
      { serverSelectionTimeoutMS: 10000 },
    );

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
    const client = new MongoClient(
      this.withUrlCredentials(config.baseUrl, config.authConfig),
      { serverSelectionTimeoutMS: 10000 },
    );

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
    const uri = this.mysqlUri(config.baseUrl, config.authConfig);
    this.logger.debug(`MySQL query → ${new URL(uri).hostname}`);

    const conn = await mysql.createConnection({
      uri,
      connectTimeout: this.CONNECT_TIMEOUT_MS,
    });
    try {
      const [result] =
        values.length > 0
          ? await conn.execute({ sql, timeout: this.STATEMENT_TIMEOUT_MS }, values as any[])
          : await conn.query({ sql, timeout: this.STATEMENT_TIMEOUT_MS });
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

  /**
   * Normalize mariadb:// to mysql:// since mysql2 only understands mysql://,
   * and splice in any authConfig credentials.
   */
  private mysqlUri(
    baseUrl: string,
    authConfig?: Record<string, unknown>,
  ): string {
    const normalized = baseUrl.startsWith('mariadb://')
      ? 'mysql://' + baseUrl.slice('mariadb://'.length)
      : baseUrl;
    return this.withUrlCredentials(normalized, authConfig);
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
    // Round-trip ceiling; oracledb cancels the call and raises DPI-1067.
    conn.callTimeout = this.STATEMENT_TIMEOUT_MS;
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
  /*  SAP HANA                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * One session per call, like every other engine here. The session is set up
   * before the caller's statement runs:
   *
   * - `SET TRANSACTION READ ONLY` when the connector is read-only, so HANA
   *   itself refuses writes for the rest of the session. The lexical guard is
   *   the first line; this is the second; the database user's grants are the
   *   real boundary.
   * - `SET SCHEMA` so SAP's unqualified table names (ACDOCA, VBAK…) resolve.
   * - `SET 'CDS_CLIENT'` when an SAP client is configured. SAP's CDS views
   *   filter on that session variable, and without it they return no rows at
   *   all, which reads as "no data" rather than as a setup mistake.
   *
   * The whole call races a timeout; on expiry the session is closed, which
   * makes HANA cancel the running statement.
   */
  private async executeHana(
    config: {
      baseUrl: string;
      authType: string;
      authConfig?: Record<string, unknown>;
    },
    sql: string,
    values: unknown[] = [],
    readOnly = true,
  ): Promise<unknown> {
    const hana = this.buildHanaConfig(config);
    this.logger.debug(
      `SAP HANA query → ${hana.connect.host}:${hana.connect.port}` +
        `${hana.connect.databaseName ? `/${hana.connect.databaseName}` : ''} (${hana.driver})`,
    );

    const session = await openHanaSession(hana.driver, hana.connect);
    let timer: NodeJS.Timeout | undefined;
    try {
      const work = (async () => {
        if (readOnly) await session.run('SET TRANSACTION READ ONLY');
        if (hana.currentSchema) {
          await session.run(`SET SCHEMA ${quoteHanaIdentifier(hana.currentSchema)}`);
        }
        if (hana.sapClient) {
          await session.run(`SET 'CDS_CLIENT' = '${hana.sapClient}'`);
        }
        return session.query(sql, values, this.MAX_ROWS);
      })();
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `SAP HANA query exceeded ${hana.timeoutSeconds}s and was cancelled. ` +
                  'Narrow it (filter on company code, fiscal year, period) or aggregate in SQL.',
              ),
            ),
          hana.timeoutSeconds * 1000,
        );
      });
      const result = await Promise.race([work, timeout]);
      if (result.rowsAffected !== undefined && result.rows.length === 0) {
        return { rowsAffected: result.rowsAffected };
      }
      if (result.truncated) {
        return {
          rows: result.rows,
          truncated: true,
          totalRows: `more than ${this.MAX_ROWS}`,
          message: `Results truncated to ${this.MAX_ROWS} rows`,
        };
      }
      return { rows: result.rows, totalRows: result.rows.length };
    } finally {
      if (timer) clearTimeout(timer);
      await session.close().catch(() => undefined);
    }
  }

  /**
   * Parse a HANA connection string:
   *
   *   hana://host:30015                          tenant's own SQL port
   *   hana://host:30013/QS4                      system DB port + tenant name
   *   hana://host:30015/?databaseName=QS4&currentSchema=SAPHANADB&sapClient=100
   *
   * Query options: `databaseName`, `currentSchema` (alias `schema`),
   * `encrypt` (default true), `sslValidateCertificate` (default true),
   * `sapClient` (3 digits), `driver` (`hdb` | `hana-client`),
   * `statementTimeout` in seconds (default 60, max 600).
   *
   * Credentials come from the encrypted `authConfig`, falling back to the URL.
   */
  buildHanaConfig(config: {
    baseUrl: string;
    authConfig?: Record<string, unknown>;
  }): {
    driver: HanaDriverName;
    connect: HanaConnectOptions;
    currentSchema?: string;
    sapClient?: string;
    timeoutSeconds: number;
  } {
    const url = new URL(config.baseUrl.replace(/^saphana:\/\//, 'hana://'));
    const q = url.searchParams;
    const auth = config.authConfig || {};

    const pathDb = decodeURIComponent(url.pathname.replace(/^\//, '')).trim();
    const databaseName = (q.get('databaseName') || pathDb || '').trim() || undefined;

    const sapClient = (q.get('sapClient') || q.get('sap-client') || '').trim() || undefined;
    if (sapClient && !/^\d{3}$/.test(sapClient)) {
      throw new Error(`sapClient must be a three-digit SAP client such as 100, got "${sapClient}".`);
    }
    const currentSchema = (q.get('currentSchema') || q.get('schema') || '').trim() || undefined;

    const bool = (v: string | null, dflt: boolean) =>
      v === null || v === '' ? dflt : !/^(false|0|no|off)$/i.test(v);

    const rawTimeout = Number(q.get('statementTimeout') || 60);
    const timeoutSeconds = Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.min(Math.floor(rawTimeout), 600)
      : 60;

    const port = Number(url.port || 30015);
    return {
      driver: resolveHanaDriverName(q.get('driver')),
      connect: {
        host: url.hostname.replace(/^\[|\]$/g, ''),
        port,
        user: (auth.username as string) || decodeURIComponent(url.username) || undefined,
        password: (auth.password as string) || decodeURIComponent(url.password) || undefined,
        databaseName,
        encrypt: bool(q.get('encrypt'), true),
        validateCertificate: bool(q.get('sslValidateCertificate'), true),
      },
      currentSchema,
      sapClient,
      timeoutSeconds,
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

  /**
   * SSRF guard for a database connection string. SQLite is a local file (no
   * network host) so it's skipped here. Every other engine resolves one or more
   * hosts that must pass the same outbound policy as REST/SOAP/GraphQL — so a
   * connector can't be pointed at cloud metadata, loopback, or internal-only
   * databases unless an operator allowlists them (SSRF_ALLOWED_HOSTS /
   * SSRF_ALLOW_PRIVATE).
   */
  private async assertSafeDbHost(baseUrl: string): Promise<void> {
    if (this.isSqlite(baseUrl)) return;
    const hosts = this.extractHosts(baseUrl);
    for (const host of hosts) {
      await assertSafeOutboundHost(host);
    }
  }

  /**
   * Pull the host(s) out of a DB connection string without assuming http(s).
   * Handles `scheme://user:pass@host:port/db`, comma-separated replica-set hosts
   * (`mongodb://h1:27017,h2:27017/db`) and bracketed IPv6 (`[::1]:5432`).
   */
  private extractHosts(baseUrl: string): string[] {
    const m = baseUrl.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(.*)$/s);
    if (!m) return [];
    // Authority = everything before the first path/query/fragment separator.
    let authority = m[1].split(/[/?#]/)[0];
    // Strip credentials (user:pass@) — keep only what follows the last '@'.
    const at = authority.lastIndexOf('@');
    if (at !== -1) authority = authority.slice(at + 1);
    return authority
      .split(',')
      .map((hp) => {
        const h = hp.trim();
        if (!h) return '';
        if (h.startsWith('[')) {
          const end = h.indexOf(']'); // [ipv6]:port
          return end !== -1 ? h.slice(1, end) : h.slice(1);
        }
        const colon = h.indexOf(':'); // host:port
        return colon !== -1 ? h.slice(0, colon) : h;
      })
      .filter(Boolean);
  }

  private isMongodb(baseUrl: string): boolean {
    return baseUrl.startsWith('mongodb://') || baseUrl.startsWith('mongodb+srv://');
  }

  private isHana(baseUrl: string): boolean {
    return baseUrl.startsWith('hana://') || baseUrl.startsWith('saphana://');
  }

  private isMssql(baseUrl: string): boolean {
    // `sqlserver://` is accepted as a connection string (base-url.util) and
    // parses the same way; without it here it fell through to the pg driver.
    return baseUrl.startsWith('mssql://') || baseUrl.startsWith('sqlserver://');
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

  /**
   * Remove string literals and comments so the read-only lexical checks below
   * can't be fooled (e.g. `WHERE note = 'a;b'`) nor trip over harmless keyword
   * substrings inside literals (e.g. `WHERE action = 'DELETE'`).
   *
   * Done as a single linear character scan rather than regex: a regex for
   * unterminated block comments backtracks in polynomial time on hostile input
   * (`/*a/*a/*…`), and the query string is fully untrusted.
   */
  private stripLiteralsAndComments(sql: string): string {
    if (sql.length > this.MAX_QUERY_LENGTH) {
      throw new Error(
        `Query too long (${sql.length} chars; max ${this.MAX_QUERY_LENGTH}).`,
      );
    }
    let out = '';
    let i = 0;
    const n = Math.min(sql.length, this.MAX_QUERY_LENGTH);
    while (i < n) {
      const c = sql[i];
      const next = sql[i + 1];

      // Line comment: -- … end of line
      if (c === '-' && next === '-') {
        i += 2;
        while (i < n && sql[i] !== '\n') i++;
        out += ' ';
        continue;
      }

      // Block comment: /* … */ (an unterminated one runs to end of input)
      if (c === '/' && next === '*') {
        i += 2;
        while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
        i += 2;
        out += ' ';
        continue;
      }

      // Single-quoted string with '' escape → collapse to an empty literal
      if (c === "'") {
        i++;
        while (i < n) {
          if (sql[i] === "'") {
            if (sql[i + 1] === "'") {
              i += 2;
              continue;
            }
            i++;
            break;
          }
          i++;
        }
        out += "''";
        continue;
      }

      out += c;
      i++;
    }
    return out;
  }

  /**
   * Refuse a statement that names a denied table (`connector.config.deniedTables`).
   *
   * Every identifier in the statement is checked, not only the ones after
   * FROM / JOIN: comma joins, subqueries and schema-qualified or quoted names
   * (`"SAPHANADB"."PA0008"`) would each slip past a FROM-only parser. The cost
   * is that a column whose name matches a denied table pattern is refused too,
   * so keep patterns table-shaped (`PA####`, not `PA*`).
   *
   * This is defence in depth against an agent wandering into HR or security
   * tables. The database user's grants remain the boundary.
   */
  private assertNoDeniedTables(sql: string, denied: RegExp[]): void {
    if (denied.length === 0) return;
    const stripped = this.stripLiteralsAndComments(sql);
    const tokens = stripped.match(/"(?:[^"]|"")+"|[A-Za-z_/][A-Za-z0-9_/$#]*/g) || [];
    for (const raw of tokens) {
      const name = raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw;
      if (denied.some((re) => re.test(name))) {
        throw new Error(
          `Access to table ${name.toUpperCase()} is blocked by this connector's denied-tables list. ` +
            'Ask an administrator if you need it.',
        );
      }
    }
  }

  private validateQuery(sql: string): void {
    const normalized = this.stripLiteralsAndComments(sql).trim().toUpperCase();

    // Read-only entry points: a plain SELECT, or a WITH (CTE) that ultimately
    // selects. Common Table Expressions are a legitimate read-only construct
    // (`WITH q AS (SELECT …) SELECT … FROM q`) and were previously rejected.
    if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
      throw new Error(
        'Only SELECT queries are allowed (a leading WITH … SELECT CTE is also accepted). INSERT, UPDATE, DELETE, DROP, and other write operations are blocked.',
      );
    }

    // Reject stacked statements (e.g. "SELECT 1; DROP TABLE x"). A single
    // trailing semicolon is tolerated; anything after it is not.
    if (normalized.replace(/;\s*$/, '').includes(';')) {
      throw new Error(
        'Only a single SQL statement is allowed; stacked statements are blocked.',
      );
    }

    // Postgres allows data-modifying CTEs — `WITH x AS (INSERT … RETURNING …)
    // SELECT …`. Those write despite the leading WITH, so block any write
    // keyword that opens a CTE body. Matching `(\s*<keyword>` keeps this from
    // flagging ordinary identifiers (`created_at`) or read-only subqueries.
    const dataModifyingCte =
      /\(\s*(INSERT|UPDATE|DELETE|MERGE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE)\b/;
    const cteMatch = normalized.match(dataModifyingCte);
    if (cteMatch) {
      throw new Error(
        `Blocked SQL keyword in CTE: ${cteMatch[1]}. Only read-only queries are allowed.`,
      );
    }

    // A SELECT can still write or lock. `SELECT … INTO t` creates a table
    // (Postgres, SQL Server) or a file (MySQL `INTO OUTFILE`); `FOR UPDATE` /
    // `FOR SHARE` (Postgres, MySQL, Oracle, SAP HANA) and MySQL's
    // `LOCK IN SHARE MODE` hold row locks that block the application writing
    // those rows — on an ERP that is the posting run, not a harmless read.
    if (/\bINTO\b/.test(normalized)) {
      throw new Error(
        'SELECT … INTO is blocked: it writes a table or file. Only read-only queries are allowed.',
      );
    }
    if (
      /\bFOR\s+(NO\s+KEY\s+)?(UPDATE|SHARE|KEY\s+SHARE)\b|\bLOCK\s+IN\s+SHARE\s+MODE\b/.test(
        normalized,
      )
    ) {
      throw new Error(
        'Locking reads (FOR UPDATE / FOR SHARE) are blocked: they hold row locks on the source system. Remove the locking clause.',
      );
    }
  }

}

/**
 * Compile `connector.config.deniedTables` into anchored, case-insensitive
 * matchers. Glob syntax: `*` any run of characters, `?` one character,
 * `#` one digit — `PA####` is SAP's HR infotype tables PA0000–PA9999 without
 * also matching a column such as PARVW. Anything that is not a non-empty
 * string is ignored.
 */
export function normalizeDeniedTables(input: unknown): RegExp[] {
  const list = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[\s,]+/)
      : [];
  const out: RegExp[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const pattern = item.trim();
    if (!pattern) continue;
    let re = '';
    for (const ch of pattern) {
      if (ch === '*') re += '.*';
      else if (ch === '?') re += '.';
      else if (ch === '#') re += '[0-9]';
      else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    out.push(new RegExp(`^${re}$`, 'i'));
  }
  return out;
}

export type SqlDriver = 'postgres' | 'mysql' | 'mssql' | 'oracle' | 'sqlite' | 'hana';

/**
 * Quote a HANA identifier. SAP namespaced objects (`/BIC/AZSALES2`) are only
 * valid quoted; a double quote inside the name is doubled.
 */
export function quoteHanaIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

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
 * - hana       →  `?, ?, ...` (hdb and @sap/hana-client prepared statements)
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
    case 'hana':
    default:
      return '?';
  }
}
