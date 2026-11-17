/**
 * READ-ONLY report: connectors and tools whose base URL, headers, paths,
 * query parameters, parameter defaults or names hold a secret-looking
 * literal (see src/common/secret-literals.util.ts), plus a DATABASE
 * connector whose connection string still carries its password (see
 * src/connectors/database-url-credentials.util.ts) — a `database_url_password`
 * finding, for a row from before that move was added.
 *
 * Prints one JSON line per finding, then a summary. A finding names the
 * connector, the workspace, the field and a redacted pattern
 * (`bot<10 digits>:***(35)`, or the DATABASE connection string with its
 * password replaced by `********`); the secret itself is never printed.
 *
 * The queries run inside a READ ONLY transaction, so the script cannot
 * change anything even by mistake. env_vars and a DATABASE connector's
 * auth_config are not read — the finding only looks at what is still
 * visible in the plaintext column, not at whether repair could act on it.
 *
 *   DATABASE_URL=postgres://… npx ts-node scripts/secret-literals/report.ts
 *
 * On the cloud droplet, where the deployed image may not contain this code
 * yet, build a single file with `node scripts/secret-literals/bundle.mjs
 * report` and run it inside the backend container (see bundle.mjs).
 */
import { Client } from 'pg';
import {
  scanConnector,
  type ConnectorRow,
  type ScanFinding,
  type ToolRow,
} from '../../src/connectors/secret-literal-scan.util';

const GUARDED = `('REST','SOAP','GRAPHQL','MCP','ODATA','DATABASE')`;

export async function report(client: Client, out: (line: string) => void = console.log) {
  await client.query('BEGIN READ ONLY');
  try {
    const connectors = (
      await client.query(
        `SELECT id, organization_id, name, type::text AS type, base_url, headers, config
           FROM connectors
          WHERE type::text IN ${GUARDED}`,
      )
    ).rows;
    const tools = (
      await client.query(
        `SELECT t.id, t.connector_id, t.name, t.description, t.parameters, t.endpoint_mapping
           FROM mcp_tools t
           JOIN connectors c ON c.id = t.connector_id
          WHERE c.type::text IN ${GUARDED}`,
      )
    ).rows;

    const toolsByConnector = new Map<string, ToolRow[]>();
    for (const t of tools) {
      const list = toolsByConnector.get(t.connector_id) ?? [];
      list.push({
        id: t.id,
        connectorId: t.connector_id,
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        endpointMapping: t.endpoint_mapping,
      });
      toolsByConnector.set(t.connector_id, list);
    }

    const findings: ScanFinding[] = [];
    for (const c of connectors) {
      const row: ConnectorRow = {
        id: c.id,
        organizationId: c.organization_id,
        name: c.name,
        type: c.type,
        baseUrl: c.base_url,
        headers: c.headers,
        config: c.config,
        envVars: null,
      };
      findings.push(...scanConnector(row, toolsByConnector.get(c.id) ?? []));
    }

    for (const f of findings) out(JSON.stringify(f));

    const count = <K extends string>(key: (f: ScanFinding) => K) =>
      findings.reduce<Record<string, number>>((acc, f) => {
        const k = key(f);
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {});
    const connectorsWith = (pred: (f: ScanFinding) => boolean) =>
      new Set(findings.filter(pred).map((f) => f.connectorId)).size;
    const isUrlOrName = (f: ScanFinding) =>
      f.field === 'baseUrl' || f.field === 'tool.path' || f.field === 'tool.name' || f.field.startsWith('tool.query.');

    out(
      JSON.stringify(
        {
          summary: {
            connectorsScanned: connectors.length,
            toolsScanned: tools.length,
            findings: findings.length,
            connectorsAffected: connectorsWith(() => true),
            workspacesAffected: new Set(findings.map((f) => f.workspaceId)).size,
            toolsAffected: new Set(findings.filter((f) => f.toolId).map((f) => f.toolId)).size,
            connectorsWithSecretInBaseUrlPathQueryOrName: connectorsWith(isUrlOrName),
            catalogConnectorsAffected: connectorsWith((f) => !!f.adapterSlug),
            customConnectorsAffected: connectorsWith((f) => !f.adapterSlug),
            byField: count((f) => (f.field.startsWith('headers.') ? 'headers.*' : f.field.replace(/^(tool\.(query|headers|parameter))\..*/, '$1.*'))),
            byKind: count((f) => f.kind),
            byAdapter: count((f) => f.adapterSlug ?? '(custom)'),
          },
        },
        null,
        2,
      ),
    );
    return findings;
  } finally {
    await client.query('ROLLBACK');
  }
}

if (require.main === module) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  client
    .connect()
    .then(() => report(client))
    .then(() => client.end())
    .catch(async (err) => {
      console.error(`report failed: ${err?.message ?? err}`);
      await client.end().catch(() => undefined);
      process.exit(1);
    });
}
