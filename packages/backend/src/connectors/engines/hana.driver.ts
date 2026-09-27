import { createRequire } from 'module';
import * as path from 'path';

/**
 * SAP HANA access behind one small interface, with two interchangeable
 * drivers:
 *
 * - `hdb` (default). SAP's pure-JavaScript driver, Apache-2.0, bundled with
 *   AnythingMCP. Works on every image and architecture we ship.
 * - `@sap/hana-client`. SAP's native driver. Its licence (SAP Developer
 *   License) does not let us redistribute it, so it is never a dependency of
 *   this package: an operator installs it into their own deployment and picks
 *   it with `?driver=hana-client` on the connection string or
 *   `HANA_DRIVER=hana-client`. See docs/connectors/sap-hana.md.
 *
 * Both are driven the same way: one session per call, statements executed one
 * at a time, result rows streamed and cut off at the caller's row limit so a
 * `SELECT *` on a 500-million-row table never lands in memory.
 */

export type HanaDriverName = 'hdb' | 'hana-client';

export interface HanaConnectOptions {
  host: string;
  port: number;
  user?: string;
  password?: string;
  /** Tenant name in a multi-container system; omit when `port` is the tenant's own SQL port. */
  databaseName?: string;
  encrypt: boolean;
  validateCertificate: boolean;
}

export interface HanaQueryResult {
  rows: Record<string, unknown>[];
  /** True when the statement produced more rows than `maxRows`. */
  truncated: boolean;
  /** Set for statements that return no result set (DML in read-write mode). */
  rowsAffected?: number;
}

export interface HanaSession {
  /** Run a statement that returns nothing (SET SCHEMA, SET TRANSACTION …). */
  run(sql: string): Promise<void>;
  /** Run a statement with positional `?` values, reading at most `maxRows + 1` rows. */
  query(sql: string, values: unknown[], maxRows: number): Promise<HanaQueryResult>;
  close(): Promise<void>;
}

/** Thrown when `@sap/hana-client` is selected but not installed. */
export class HanaClientMissingError extends Error {
  constructor(detail: string) {
    super(
      'The SAP HANA connector is set to use the native @sap/hana-client driver, ' +
        'but it is not installed in this deployment. SAP does not allow it to be ' +
        'bundled, so it has to be added by the operator (see ' +
        'docs/connectors/sap-hana.md), or remove `driver=hana-client` from the ' +
        `connection string to use the bundled hdb driver. (${detail})`,
    );
  }
}

export function resolveHanaDriverName(fromUrl?: string | null): HanaDriverName {
  const raw = (fromUrl || process.env.HANA_DRIVER || 'hdb').trim().toLowerCase();
  if (raw === 'hdb') return 'hdb';
  if (raw === 'hana-client' || raw === '@sap/hana-client' || raw === 'native') {
    return 'hana-client';
  }
  throw new Error(
    `Unknown SAP HANA driver "${raw}". Use "hdb" (bundled) or "hana-client" (operator-installed @sap/hana-client).`,
  );
}

export async function openHanaSession(
  driver: HanaDriverName,
  opts: HanaConnectOptions,
): Promise<HanaSession> {
  return driver === 'hana-client' ? openHanaClientSession(opts) : openHdbSession(opts);
}

/**
 * Values SAP hands back that do not survive JSON as-is. RAW / VARBINARY
 * columns (GUIDs such as ACDOCA's document keys) arrive as Buffers and would
 * serialise as `{"type":"Buffer","data":[…]}`; SAP tools show them as upper-case
 * hex, so do the same. Decimals already arrive as strings from both drivers
 * and stay that way: a float would silently round currency amounts.
 */
export function normalizeHanaValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return value.toString('hex').toUpperCase();
  if (typeof value === 'bigint') {
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  }
  return value;
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = normalizeHanaValue(v);
  return out;
}

/* ------------------------------------------------------------------ */
/*  hdb                                                                */
/* ------------------------------------------------------------------ */

async function openHdbSession(opts: HanaConnectOptions): Promise<HanaSession> {
  // Loaded lazily: a deployment without any HANA connector never pays for it.
   
  const hdb = require('hdb');
  const client = hdb.createClient({
    host: opts.host,
    port: opts.port,
    user: opts.user,
    password: opts.password,
    ...(opts.databaseName ? { databaseName: opts.databaseName } : {}),
    ...(opts.encrypt
      ? { useTLS: true, rejectUnauthorized: opts.validateCertificate }
      : {}),
  });
  // Without a listener a dropped socket is an unhandled 'error' event and
  // takes the whole process down. The failing call still rejects on its own.
  client.on('error', () => undefined);

  await new Promise<void>((resolve, reject) =>
    client.connect((err: Error | null) => (err ? reject(err) : resolve())),
  );

  const prepare = (sql: string) =>
    new Promise<any>((resolve, reject) =>
      client.prepare(sql, (err: Error | null, stmt: any) =>
        err ? reject(err) : resolve(stmt),
      ),
    );

  return {
    run: (sql) =>
      new Promise<void>((resolve, reject) =>
        client.exec(sql, (err: Error | null) => (err ? reject(err) : resolve())),
      ),

    async query(sql, values, maxRows) {
      const stmt = await prepare(sql);
      try {
        const result: any = await new Promise((resolve, reject) =>
          stmt.execute(values, (err: Error | null, res: unknown) =>
            err ? reject(err) : resolve(res),
          ),
        );
        // No result set: hdb hands back the affected-row count.
        if (typeof result === 'number') {
          return { rows: [], truncated: false, rowsAffected: result };
        }
        if (!result || typeof result.createObjectStream !== 'function') {
          return { rows: [], truncated: false };
        }
        return await readHdbResultSet(result, maxRows);
      } finally {
        await new Promise<void>((resolve) => stmt.drop(() => resolve()));
      }
    },

    close: () =>
      new Promise<void>((resolve) => {
        try {
          client.end();
        } finally {
          resolve();
        }
      }),
  };
}

async function readHdbResultSet(rs: any, maxRows: number): Promise<HanaQueryResult> {
  const rows: Record<string, unknown>[] = [];
  let truncated = false;
  const stream = rs.createObjectStream();
  try {
    for await (const row of stream) {
      if (rows.length >= maxRows) {
        truncated = true;
        break;
      }
      rows.push(normalizeRow(row as Record<string, unknown>));
    }
  } finally {
    if (!rs.closed) {
      await new Promise<void>((resolve) => rs.close(() => resolve()));
    }
  }
  return { rows, truncated };
}

/* ------------------------------------------------------------------ */
/*  @sap/hana-client (operator-installed)                              */
/* ------------------------------------------------------------------ */

/**
 * Resolve `@sap/hana-client` from, in order: `HANA_CLIENT_PATH` (a directory
 * that contains the package, or the package directory itself — handy for a
 * mounted volume), the backend's own node_modules, and NODE_PATH.
 */
export function loadHanaClient(): any {
  const attempts: string[] = [];
  const explicit = process.env.HANA_CLIENT_PATH?.trim();
  if (explicit) {
    const req = createRequire(path.join(path.resolve(explicit), 'noop.js'));
    for (const id of ['@sap/hana-client', path.resolve(explicit)]) {
      try {
        return req(id);
      } catch (err: any) {
        attempts.push(`${id}: ${err?.code || err?.message}`);
      }
    }
  }
  try {
     
    return require('@sap/hana-client');
  } catch (err: any) {
    attempts.push(`@sap/hana-client: ${err?.code || err?.message}`);
  }
  throw new HanaClientMissingError(attempts.join('; '));
}

async function openHanaClientSession(opts: HanaConnectOptions): Promise<HanaSession> {
  const hana = loadHanaClient();
  const conn = hana.createConnection();
  const params: Record<string, unknown> = {
    serverNode: `${opts.host}:${opts.port}`,
    uid: opts.user,
    pwd: opts.password,
    encrypt: opts.encrypt ? 'true' : 'false',
    sslValidateCertificate: opts.validateCertificate ? 'true' : 'false',
    ...(opts.databaseName ? { databaseName: opts.databaseName } : {}),
  };
  await new Promise<void>((resolve, reject) =>
    conn.connect(params, (err: Error | null) => (err ? reject(err) : resolve())),
  );

  return {
    run: (sql) =>
      new Promise<void>((resolve, reject) =>
        conn.exec(sql, (err: Error | null) => (err ? reject(err) : resolve())),
      ),

    async query(sql, values, maxRows) {
      const stmt: any = await new Promise((resolve, reject) =>
        conn.prepare(sql, (err: Error | null, s: unknown) =>
          err ? reject(err) : resolve(s),
        ),
      );
      try {
        // A statement without result columns (DML in read-write mode) has no
        // result set to walk; exec reports the affected-row count instead.
        const columns = stmt.getColumnInfo?.() ?? [];
        if (!Array.isArray(columns) || columns.length === 0) {
          const affected: number = await new Promise((resolve, reject) =>
            stmt.exec(values, (e: Error | null, n: number) => (e ? reject(e) : resolve(n))),
          );
          return {
            rows: [],
            truncated: false,
            rowsAffected: typeof affected === 'number' ? affected : 0,
          };
        }
        const rs: any = await new Promise((resolve, reject) =>
          stmt.executeQuery(values, (err: Error | null, r: unknown) =>
            err ? reject(err) : resolve(r),
          ),
        );
        const rows: Record<string, unknown>[] = [];
        let truncated = false;
        const next = () =>
          new Promise<boolean>((resolve, reject) =>
            rs.next((err: Error | null, more: boolean) => (err ? reject(err) : resolve(more))),
          );
        try {
          while (await next()) {
            if (rows.length >= maxRows) {
              truncated = true;
              break;
            }
            rows.push(normalizeRow(rs.getValues()));
          }
        } finally {
          await new Promise<void>((resolve) => rs.close(() => resolve()));
        }
        return { rows, truncated };
      } finally {
        await new Promise<void>((resolve) => stmt.drop(() => resolve()));
      }
    },

    close: () =>
      new Promise<void>((resolve) => conn.disconnect(() => resolve())),
  };
}
