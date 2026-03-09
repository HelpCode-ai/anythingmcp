import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma.service';
import { Connector, ConnectorType, AuthType } from '../generated/prisma/client';
import { RestEngine } from './engines/rest.engine';
import { SoapEngine } from './engines/soap.engine';
import { GraphqlEngine } from './engines/graphql.engine';
import { DatabaseEngine } from './engines/database.engine';
import { McpClientEngine } from './engines/mcp-client.engine';
import { encrypt, decrypt } from '../common/crypto/encryption.util';

@Injectable()
export class ConnectorsService {
  private readonly logger = new Logger(ConnectorsService.name);
  private readonly encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly restEngine: RestEngine,
    private readonly soapEngine: SoapEngine,
    private readonly graphqlEngine: GraphqlEngine,
    private readonly databaseEngine: DatabaseEngine,
    private readonly mcpClientEngine: McpClientEngine,
  ) {
    this.encryptionKey =
      this.configService.get<string>('ENCRYPTION_KEY') ||
      'default-dev-key-change-in-prod!!';
  }

  async findAllByUser(userId: string): Promise<Connector[]> {
    return this.prisma.connector.findMany({
      where: { userId },
      include: { tools: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(id: string, userId: string): Promise<Connector> {
    const connector = await this.prisma.connector.findFirst({
      where: { id, userId },
      include: { tools: true, resources: true, prompts: true },
    });
    if (!connector) {
      throw new NotFoundException(`Connector ${id} not found`);
    }
    return connector;
  }

  async findByIdInternal(id: string): Promise<Connector> {
    const connector = await this.prisma.connector.findUnique({
      where: { id },
      include: { tools: true },
    });
    if (!connector) {
      throw new NotFoundException(`Connector ${id} not found`);
    }
    return connector;
  }

  async create(
    userId: string,
    data: {
      name: string;
      type: ConnectorType;
      baseUrl: string;
      authType?: AuthType;
      authConfig?: Record<string, unknown>;
      specUrl?: string;
      headers?: Record<string, string>;
      config?: Record<string, unknown>;
      envVars?: Record<string, string>;
    },
  ): Promise<Connector> {
    const encryptedAuth = data.authConfig
      ? encrypt(JSON.stringify(data.authConfig), this.encryptionKey)
      : null;

    return this.prisma.connector.create({
      data: {
        userId,
        name: data.name,
        type: data.type,
        baseUrl: data.baseUrl,
        authType: data.authType || 'NONE',
        authConfig: encryptedAuth,
        specUrl: data.specUrl,
        headers: data.headers as any,
        config: data.config as any,
        envVars: data.envVars as any,
      },
    });
  }

  async update(
    id: string,
    userId: string,
    data: Partial<{
      name: string;
      baseUrl: string;
      authType: AuthType;
      authConfig: Record<string, unknown>;
      isActive: boolean;
      headers: Record<string, string>;
      config: Record<string, unknown>;
      envVars: Record<string, string>;
    }>,
  ): Promise<Connector> {
    await this.findById(id, userId);

    const updateData: any = { ...data };
    if (data.authConfig) {
      updateData.authConfig = encrypt(
        JSON.stringify(data.authConfig),
        this.encryptionKey,
      );
    }

    return this.prisma.connector.update({
      where: { id },
      data: updateData,
    });
  }

  async remove(id: string, userId: string): Promise<void> {
    await this.findById(id, userId);
    await this.prisma.connector.delete({ where: { id } });
  }

  async testConnection(
    id: string,
    userId: string,
  ): Promise<{ ok: boolean; message: string }> {
    const connector = await this.findById(id, userId);

    try {
      const authConfig = connector.authConfig
        ? JSON.parse(decrypt(connector.authConfig, this.encryptionKey))
        : undefined;

      switch (connector.type) {
        case 'REST':
          await this.restEngine.execute(
            {
              baseUrl: connector.baseUrl,
              authType: connector.authType,
              authConfig,
              headers: connector.headers as Record<string, string>,
            },
            { method: 'GET', path: '/' },
            {},
          );
          break;
        case 'GRAPHQL':
          await this.graphqlEngine.execute(
            {
              baseUrl: connector.baseUrl,
              authType: connector.authType,
              authConfig,
              headers: connector.headers as Record<string, string>,
            },
            { method: 'query', path: '{ __typename }' },
            {},
          );
          break;
        case 'DATABASE':
          await this.databaseEngine.testConnection({
            baseUrl: connector.baseUrl,
            authType: connector.authType,
            authConfig,
          });
          break;
        case 'MCP': {
          const tools = await this.mcpClientEngine.listTools({
            baseUrl: connector.baseUrl,
            authType: connector.authType,
            authConfig,
            headers: connector.headers as Record<string, string>,
          });
          return {
            ok: true,
            message: `Connection successful — found ${tools.length} tools on remote MCP server`,
          };
        }
        default:
          return {
            ok: true,
            message: `Connection type ${connector.type} — test not yet implemented`,
          };
      }
      return { ok: true, message: 'Connection successful' };
    } catch (error: any) {
      return { ok: false, message: error.message || 'Connection failed' };
    }
  }

  async executeConnectorCall(
    connector: Connector,
    endpointMapping: {
      method: string;
      path: string;
      queryParams?: Record<string, unknown>;
      bodyMapping?: Record<string, unknown>;
      headers?: Record<string, string>;
      staticResponse?: string;
    },
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const authConfig = connector.authConfig
      ? JSON.parse(decrypt(connector.authConfig, this.encryptionKey))
      : undefined;

    const config = {
      baseUrl: connector.baseUrl,
      authType: connector.authType,
      authConfig,
      headers: connector.headers as Record<string, string>,
      specUrl: connector.specUrl ?? undefined,
      connectorId: connector.id,
    };

    // Inject env vars as parameter defaults
    const envVars = connector.envVars as Record<string, string> | undefined;
    const mergedParams = envVars
      ? { ...params, ...Object.fromEntries(
          Object.entries(envVars).filter(([k]) => params[k] === undefined),
        ) }
      : params;

    // Static response tools — return text immediately without engine dispatch
    if (endpointMapping.method === 'static' && endpointMapping.staticResponse) {
      return { text: endpointMapping.staticResponse };
    }

    switch (connector.type) {
      case 'REST':
        return this.restEngine.execute(config, endpointMapping, mergedParams);
      case 'SOAP':
        return this.soapEngine.execute(config, endpointMapping, mergedParams);
      case 'GRAPHQL':
        return this.graphqlEngine.execute(config, endpointMapping, mergedParams);
      case 'DATABASE': {
        const readOnly = (connector.config as any)?.readOnly !== false;
        return this.databaseEngine.execute(config, endpointMapping, mergedParams, { readOnly });
      }
      case 'MCP':
        return this.mcpClientEngine.execute(config, endpointMapping, mergedParams);
      default:
        throw new NotFoundException(
          `Connector type '${connector.type}' not yet implemented`,
        );
    }
  }

  getDecryptedAuthConfig(
    connector: Connector,
  ): Record<string, unknown> | undefined {
    if (!connector.authConfig) return undefined;
    return JSON.parse(decrypt(connector.authConfig, this.encryptionKey));
  }

  /**
   * Generate the 3 default tools for DATABASE connectors:
   *   1. get_database_schema — introspect tables/columns/types
   *   2. get_example_queries — return static example SQL patterns
   *   3. execute_query — run an arbitrary SELECT query
   */
  generateDefaultDatabaseTools(baseUrl: string, readOnly = true): Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    endpointMapping: Record<string, unknown>;
  }> {
    const isMongo =
      baseUrl.startsWith('mongodb://') || baseUrl.startsWith('mongodb+srv://');

    if (isMongo) {
      return this.generateMongoTools(readOnly);
    }

    const isMssql = baseUrl.startsWith('mssql://');
    const isMysql = baseUrl.startsWith('mysql://') || baseUrl.startsWith('mariadb://');
    const isOracle = baseUrl.startsWith('oracle://') || baseUrl.startsWith('oracledb://');
    const isSqlite = baseUrl.startsWith('sqlite://') || baseUrl.startsWith('sqlite:');

    let schemaQuery: string;
    let dbType: string;
    let topSyntax: string;

    if (isMssql) {
      dbType = 'SQL Server';
      topSyntax = 'SELECT TOP 10';
      schemaQuery = `SELECT t.TABLE_SCHEMA, t.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE, c.CHARACTER_MAXIMUM_LENGTH, c.IS_NULLABLE, CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 'YES' ELSE 'NO' END AS IS_PRIMARY_KEY FROM INFORMATION_SCHEMA.TABLES t JOIN INFORMATION_SCHEMA.COLUMNS c ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME LEFT JOIN (SELECT ku.TABLE_SCHEMA, ku.TABLE_NAME, ku.COLUMN_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY') pk ON c.TABLE_SCHEMA = pk.TABLE_SCHEMA AND c.TABLE_NAME = pk.TABLE_NAME AND c.COLUMN_NAME = pk.COLUMN_NAME WHERE t.TABLE_TYPE = 'BASE TABLE' ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME, c.ORDINAL_POSITION`;
    } else if (isMysql) {
      dbType = baseUrl.startsWith('mariadb://') ? 'MariaDB' : 'MySQL';
      topSyntax = 'SELECT ... LIMIT 10';
      schemaQuery = `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE, CASE WHEN COLUMN_KEY = 'PRI' THEN 'YES' ELSE 'NO' END AS IS_PRIMARY_KEY FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`;
    } else if (isOracle) {
      dbType = 'Oracle';
      topSyntax = 'SELECT ... FETCH FIRST 10 ROWS ONLY';
      schemaQuery = `SELECT t.OWNER AS TABLE_SCHEMA, t.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE, c.DATA_LENGTH AS CHARACTER_MAXIMUM_LENGTH, c.NULLABLE AS IS_NULLABLE, CASE WHEN cc.COLUMN_NAME IS NOT NULL THEN 'YES' ELSE 'NO' END AS IS_PRIMARY_KEY FROM ALL_TABLES t JOIN ALL_TAB_COLUMNS c ON t.OWNER = c.OWNER AND t.TABLE_NAME = c.TABLE_NAME LEFT JOIN (SELECT acc.OWNER, acc.TABLE_NAME, acc.COLUMN_NAME FROM ALL_CONSTRAINTS ac JOIN ALL_CONS_COLUMNS acc ON ac.CONSTRAINT_NAME = acc.CONSTRAINT_NAME AND ac.OWNER = acc.OWNER WHERE ac.CONSTRAINT_TYPE = 'P') cc ON c.OWNER = cc.OWNER AND c.TABLE_NAME = cc.TABLE_NAME AND c.COLUMN_NAME = cc.COLUMN_NAME WHERE t.OWNER NOT IN ('SYS','SYSTEM','MDSYS','CTXSYS','XDB','WMSYS','DBSNMP','OUTLN') ORDER BY t.OWNER, t.TABLE_NAME, c.COLUMN_ID`;
    } else if (isSqlite) {
      dbType = 'SQLite';
      topSyntax = 'SELECT ... LIMIT 10';
      schemaQuery = `SELECT '' AS table_schema, m.name AS table_name, p.name AS column_name, p.type AS data_type, NULL AS character_maximum_length, CASE WHEN p."notnull" = 0 THEN 'YES' ELSE 'NO' END AS is_nullable, CASE WHEN p.pk > 0 THEN 'YES' ELSE 'NO' END AS is_primary_key FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, p.cid`;
    } else {
      dbType = 'PostgreSQL';
      topSyntax = 'SELECT ... LIMIT 10';
      schemaQuery = `SELECT t.table_schema, t.table_name, c.column_name, c.data_type, c.character_maximum_length, c.is_nullable, CASE WHEN pk.column_name IS NOT NULL THEN 'YES' ELSE 'NO' END AS is_primary_key FROM information_schema.tables t JOIN information_schema.columns c ON t.table_schema = c.table_schema AND t.table_name = c.table_name LEFT JOIN (SELECT ku.table_schema, ku.table_name, ku.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name WHERE tc.constraint_type = 'PRIMARY KEY') pk ON c.table_schema = pk.table_schema AND c.table_name = pk.table_name AND c.column_name = pk.column_name WHERE t.table_type = 'BASE TABLE' AND t.table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY t.table_schema, t.table_name, c.ordinal_position`;
    }

    const executeQueryDesc = readOnly
      ? `Execute a read-only SQL query against the ${dbType} database. ` +
        `IMPORTANT: Only SELECT statements are allowed. ` +
        `Always call get_database_schema first to learn the table/column names, then use get_example_queries for syntax guidance. ` +
        `Results are limited to 1000 rows.`
      : `Execute a SQL query against the ${dbType} database. ` +
        `Supports SELECT, INSERT, UPDATE, DELETE, and other SQL statements. ` +
        `Always call get_database_schema first to learn the table/column names, then use get_example_queries for syntax guidance. ` +
        `SELECT results are limited to 1000 rows. Write operations return affected row counts.`;

    const queryParamDesc = readOnly
      ? `The SQL SELECT query to execute. Only SELECT is allowed. Example: "${topSyntax} * FROM table_name"`
      : `The SQL query to execute. Supports SELECT, INSERT, UPDATE, DELETE, and other statements. Example: "${topSyntax} * FROM table_name"`;

    return [
      // 1. Schema introspection
      {
        name: 'get_database_schema',
        description:
          `Retrieve the full database schema: all tables, columns, data types, nullable flags, and primary keys. ` +
          `Use this FIRST to understand the database structure before writing any queries. ` +
          `Returns one row per column across all user tables.`,
        parameters: { type: 'object', properties: {} },
        endpointMapping: { method: 'query', path: schemaQuery },
      },
      // 2. Example queries (static text, no DB execution)
      {
        name: 'get_example_queries',
        description:
          `Returns example SQL query patterns for this ${dbType} database. ` +
          `Use this to understand common query patterns before writing your own. ` +
          `This tool does NOT execute any query — it returns a text guide with examples.`,
        parameters: { type: 'object', properties: {} },
        endpointMapping: {
          method: 'static',
          path: '',
          staticResponse: this.buildExampleQueriesText({ isMssql, isMysql, isOracle, isSqlite, dbType, readOnly }),
        },
      },
      // 3. Dynamic query execution
      {
        name: 'execute_query',
        description: executeQueryDesc,
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: queryParamDesc,
            },
          },
          required: ['query'],
        },
        endpointMapping: { method: 'query', path: '${query}' },
      },
    ];
  }

  private generateMongoTools(readOnly = true): Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    endpointMapping: Record<string, unknown>;
  }> {
    const executeDesc = readOnly
      ? `Execute a read-only MongoDB find query. ` +
        `The query parameter must be a JSON string with the format: { "collection": "name", "filter": {}, "projection": {}, "sort": {}, "limit": 10 }. ` +
        `Only "collection" is required; filter, projection, sort, and limit are optional. ` +
        `Always call get_database_schema first to learn collection and field names, then use get_example_queries for syntax guidance. ` +
        `Results are limited to 1000 documents.`
      : `Execute a MongoDB query. ` +
        `The query parameter must be a JSON string with the format: { "collection": "name", "filter": {}, "projection": {}, "sort": {}, "limit": 10 }. ` +
        `Only "collection" is required; filter, projection, sort, and limit are optional. ` +
        `Always call get_database_schema first to learn collection and field names, then use get_example_queries for syntax guidance. ` +
        `Results are limited to 1000 documents.`;

    return [
      // 1. Schema introspection (MongoDB-specific)
      {
        name: 'get_database_schema',
        description:
          `Retrieve the MongoDB database structure: all collections and their document fields inferred from sample documents. ` +
          `Use this FIRST to understand the database structure before writing any queries. ` +
          `Returns collection names with sample field names, types, and example values.`,
        parameters: { type: 'object', properties: {} },
        endpointMapping: { method: 'mongo_schema', path: '' },
      },
      // 2. Example queries (static text, no DB execution)
      {
        name: 'get_example_queries',
        description:
          `Returns example MongoDB query patterns for this database. ` +
          `Use this to understand the JSON query format before writing your own. ` +
          `This tool does NOT execute any query — it returns a text guide with examples.`,
        parameters: { type: 'object', properties: {} },
        endpointMapping: {
          method: 'static',
          path: '',
          staticResponse: this.buildMongoExampleQueriesText(readOnly),
        },
      },
      // 3. Dynamic query execution
      {
        name: 'execute_query',
        description: executeDesc,
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                'A JSON object describing the MongoDB query. Required field: "collection". ' +
                'Optional fields: "filter" (match criteria), "projection" (fields to include/exclude), ' +
                '"sort" (ordering), "limit" (max docs). ' +
                'Example: {"collection":"users","filter":{"age":{"$gt":18}},"limit":10}',
            },
          },
          required: ['query'],
        },
        endpointMapping: { method: 'query', path: '${query}' },
      },
    ];
  }

  private buildExampleQueriesText(opts: {
    isMssql: boolean;
    isMysql: boolean;
    isOracle: boolean;
    isSqlite: boolean;
    dbType: string;
    readOnly?: boolean;
  }): string {
    const readOnly = opts.readOnly !== false;
    const note = readOnly
      ? '> NOTE: Only SELECT queries are allowed. INSERT, UPDATE, DELETE, DROP, and other write operations are blocked.'
      : '> NOTE: This connector supports both read and write operations (SELECT, INSERT, UPDATE, DELETE, etc.). Use write operations with caution.';

    if (opts.isMssql) {
      return [
        '# SQL Server Example Queries',
        '',
        '## List all tables',
        "SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_SCHEMA, TABLE_NAME",
        '',
        '## Preview table data (first 10 rows)',
        'SELECT TOP 10 * FROM [schema].[TableName]',
        '',
        '## Count rows in a table',
        'SELECT COUNT(*) AS total FROM [schema].[TableName]',
        '',
        '## Search by text column (case-insensitive)',
        "SELECT TOP 50 * FROM [dbo].[TableName] WHERE ColumnName LIKE '%search_term%'",
        '',
        '## Filter by date range',
        "SELECT * FROM [dbo].[TableName] WHERE DateColumn BETWEEN '2024-01-01' AND '2024-12-31' ORDER BY DateColumn DESC",
        '',
        '## Join two tables',
        'SELECT a.*, b.ColumnName FROM [dbo].[TableA] a JOIN [dbo].[TableB] b ON a.ForeignKey = b.PrimaryKey',
        '',
        '## Aggregate with GROUP BY',
        'SELECT Category, COUNT(*) AS cnt, SUM(Amount) AS total FROM [dbo].[TableName] GROUP BY Category ORDER BY total DESC',
        '',
        '## Get column details for a specific table',
        "SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'YourTable' ORDER BY ORDINAL_POSITION",
        '',
        '## Distinct values in a column',
        'SELECT DISTINCT ColumnName FROM [dbo].[TableName] ORDER BY ColumnName',
        '',
        '## Pagination (SQL Server 2012+)',
        'SELECT * FROM [dbo].[TableName] ORDER BY Id OFFSET 0 ROWS FETCH NEXT 50 ROWS ONLY',
        '',
        note,
      ].join('\n');
    }

    if (opts.isMysql) {
      return [
        `# ${opts.dbType} Example Queries`,
        '',
        '## List all tables',
        'SHOW TABLES',
        '',
        '## Preview table data (first 10 rows)',
        'SELECT * FROM table_name LIMIT 10',
        '',
        '## Describe table structure',
        'DESCRIBE table_name',
        '',
        '## Count rows in a table',
        'SELECT COUNT(*) AS total FROM table_name',
        '',
        '## Search by text column (case-insensitive by default with utf8)',
        "SELECT * FROM table_name WHERE column_name LIKE '%search_term%' LIMIT 50",
        '',
        '## Filter by date range',
        "SELECT * FROM table_name WHERE date_column BETWEEN '2024-01-01' AND '2024-12-31' ORDER BY date_column DESC",
        '',
        '## Join two tables',
        'SELECT a.*, b.column_name FROM table_a a JOIN table_b b ON a.foreign_key = b.primary_key',
        '',
        '## Aggregate with GROUP BY',
        'SELECT category, COUNT(*) AS cnt, SUM(amount) AS total FROM table_name GROUP BY category ORDER BY total DESC',
        '',
        '## Distinct values in a column',
        'SELECT DISTINCT column_name FROM table_name ORDER BY column_name',
        '',
        '## Pagination',
        'SELECT * FROM table_name ORDER BY id LIMIT 50 OFFSET 0',
        '',
        note,
      ].join('\n');
    }

    if (opts.isOracle) {
      return [
        '# Oracle Example Queries',
        '',
        '## List all user tables',
        'SELECT table_name FROM user_tables ORDER BY table_name',
        '',
        '## Preview table data (first 10 rows)',
        'SELECT * FROM table_name FETCH FIRST 10 ROWS ONLY',
        '',
        '## Count rows in a table',
        'SELECT COUNT(*) AS total FROM table_name',
        '',
        '## Search by text column (case-insensitive)',
        "SELECT * FROM table_name WHERE LOWER(column_name) LIKE '%search_term%' FETCH FIRST 50 ROWS ONLY",
        '',
        '## Filter by date range',
        "SELECT * FROM table_name WHERE date_column BETWEEN DATE '2024-01-01' AND DATE '2024-12-31' ORDER BY date_column DESC",
        '',
        '## Join two tables',
        'SELECT a.*, b.column_name FROM table_a a JOIN table_b b ON a.foreign_key = b.primary_key',
        '',
        '## Aggregate with GROUP BY',
        'SELECT category, COUNT(*) AS cnt, SUM(amount) AS total FROM table_name GROUP BY category ORDER BY total DESC',
        '',
        '## Describe table columns',
        "SELECT column_name, data_type, data_length, nullable FROM all_tab_columns WHERE table_name = 'YOUR_TABLE' ORDER BY column_id",
        '',
        '## Distinct values in a column',
        'SELECT DISTINCT column_name FROM table_name ORDER BY column_name',
        '',
        '## Pagination',
        'SELECT * FROM table_name ORDER BY id OFFSET 0 ROWS FETCH NEXT 50 ROWS ONLY',
        '',
        note,
      ].join('\n');
    }

    if (opts.isSqlite) {
      return [
        '# SQLite Example Queries',
        '',
        '## List all tables',
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        '',
        '## Preview table data (first 10 rows)',
        'SELECT * FROM table_name LIMIT 10',
        '',
        '## Count rows in a table',
        'SELECT COUNT(*) AS total FROM table_name',
        '',
        '## Search by text column (case-insensitive)',
        "SELECT * FROM table_name WHERE column_name LIKE '%search_term%' LIMIT 50",
        '',
        '## Filter by date range',
        "SELECT * FROM table_name WHERE date_column BETWEEN '2024-01-01' AND '2024-12-31' ORDER BY date_column DESC",
        '',
        '## Join two tables',
        'SELECT a.*, b.column_name FROM table_a a JOIN table_b b ON a.foreign_key = b.primary_key',
        '',
        '## Aggregate with GROUP BY',
        'SELECT category, COUNT(*) AS cnt, SUM(amount) AS total FROM table_name GROUP BY category ORDER BY total DESC',
        '',
        '## Table info (columns and types)',
        "SELECT name, type, pk FROM pragma_table_info('table_name')",
        '',
        '## Distinct values in a column',
        'SELECT DISTINCT column_name FROM table_name ORDER BY column_name',
        '',
        '## Pagination',
        'SELECT * FROM table_name ORDER BY id LIMIT 50 OFFSET 0',
        '',
        note,
      ].join('\n');
    }

    // PostgreSQL (default)
    return [
      '# PostgreSQL Example Queries',
      '',
      '## List all tables',
      "SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name",
      '',
      '## Preview table data (first 10 rows)',
      'SELECT * FROM schema_name.table_name LIMIT 10',
      '',
      '## Count rows in a table',
      'SELECT COUNT(*) AS total FROM schema_name.table_name',
      '',
      '## Search by text column (case-insensitive)',
      "SELECT * FROM table_name WHERE column_name ILIKE '%search_term%' LIMIT 50",
      '',
      '## Filter by date range',
      "SELECT * FROM table_name WHERE date_column BETWEEN '2024-01-01' AND '2024-12-31' ORDER BY date_column DESC",
      '',
      '## Join two tables',
      'SELECT a.*, b.column_name FROM table_a a JOIN table_b b ON a.foreign_key = b.primary_key',
      '',
      '## Aggregate with GROUP BY',
      'SELECT category, COUNT(*) AS cnt, SUM(amount) AS total FROM table_name GROUP BY category ORDER BY total DESC',
      '',
      '## Get column details for a specific table',
      "SELECT column_name, data_type, character_maximum_length, is_nullable FROM information_schema.columns WHERE table_name = 'your_table' ORDER BY ordinal_position",
      '',
      '## Distinct values in a column',
      'SELECT DISTINCT column_name FROM table_name ORDER BY column_name',
      '',
      '## Pagination',
      'SELECT * FROM table_name ORDER BY id LIMIT 50 OFFSET 0',
      '',
      note,
    ].join('\n');
  }

  private buildMongoExampleQueriesText(readOnly = true): string {
    const note = readOnly
      ? '> NOTE: Only read-only find queries are supported. Insert, update, delete, and aggregate operations are not allowed.'
      : '> NOTE: This connector supports read operations via find queries. Write operations are not yet supported through this interface.';

    return [
      '# MongoDB Example Queries',
      '',
      'Queries are JSON objects with the format:',
      '  { "collection": "name", "filter": {}, "projection": {}, "sort": {}, "limit": N }',
      '',
      '## List first 10 documents in a collection',
      '{"collection":"users","limit":10}',
      '',
      '## Filter by exact field value',
      '{"collection":"users","filter":{"status":"active"},"limit":50}',
      '',
      '## Filter with comparison operators',
      '{"collection":"orders","filter":{"total":{"$gt":100}},"sort":{"total":-1},"limit":20}',
      '',
      '## Search by text (regex, case-insensitive)',
      '{"collection":"products","filter":{"name":{"$regex":"search_term","$options":"i"}},"limit":50}',
      '',
      '## Filter by date range',
      '{"collection":"events","filter":{"createdAt":{"$gte":{"$date":"2024-01-01T00:00:00Z"},"$lte":{"$date":"2024-12-31T23:59:59Z"}}},"sort":{"createdAt":-1},"limit":100}',
      '',
      '## Select specific fields (projection)',
      '{"collection":"users","filter":{},"projection":{"name":1,"email":1,"_id":0},"limit":20}',
      '',
      '## Filter by nested field',
      '{"collection":"users","filter":{"address.city":"New York"},"limit":20}',
      '',
      '## Filter with $in operator (match any of several values)',
      '{"collection":"products","filter":{"category":{"$in":["electronics","books"]}},"limit":50}',
      '',
      '## Filter by existence of a field',
      '{"collection":"users","filter":{"phone":{"$exists":true}},"limit":50}',
      '',
      '## Combine multiple conditions (AND)',
      '{"collection":"orders","filter":{"status":"completed","total":{"$gt":50}},"sort":{"createdAt":-1},"limit":20}',
      '',
      '## OR conditions',
      '{"collection":"users","filter":{"$or":[{"role":"admin"},{"role":"manager"}]},"limit":50}',
      '',
      note,
    ].join('\n');
  }
}
