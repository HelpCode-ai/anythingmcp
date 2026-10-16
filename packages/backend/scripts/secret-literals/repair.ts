/**
 * Repair: move secret literals found in stored connectors and tools into the
 * connectors' encrypted variables, as the API now does on every save.
 *
 *   - a key in the base URL, a path, a query parameter, a tool header or a
 *     parameter default becomes `{{VAR}}`, the value goes into env_vars
 *     (re-encrypted with ENCRYPTION_KEY, like the app does);
 *   - an existing variable holding the same value is reused (catalog
 *     Telegram installs already hold TELEGRAM_BOT_TOKEN);
 *   - a tool name or description quoting the secret is rewritten, the name
 *     regenerated from the cleaned path;
 *   - config.baseUrlBaseline is cleaned the same way;
 *   - a catalog connector's own headers are left alone (they are rebuilt
 *     from the adapter's template when its variables change).
 *
 * DRY RUN BY DEFAULT: prints what it would change (redacted) and writes
 * nothing. With --apply it first copies every row it is about to change into
 * a backup table, then updates, all in one transaction.
 *
 *   DATABASE_URL=… ENCRYPTION_KEY=… npx ts-node scripts/secret-literals/repair.ts
 *       [--apply] [--connector <id>] [--workspace <id>]
 *
 * After --apply the running backend still serves the old copies from its
 * in-memory tool registry: restart it (or reload the affected connectors).
 *
 * Rollback, using the backup table the run prints:
 *   UPDATE connectors c SET base_url=b.base_url, headers=b.headers, config=b.config, env_vars=b.env_vars
 *     FROM <backup> b WHERE b.kind='connector' AND b.id=c.id;
 *   UPDATE mcp_tools t SET name=b.name, description=b.description, parameters=b.parameters,
 *          endpoint_mapping=b.endpoint_mapping
 *     FROM <backup> b WHERE b.kind='tool' AND b.id=t.id;
 */
import { Client } from 'pg';
import {
  planRepair,
  type ConnectorRow,
  type RepairPlan,
  type ToolRow,
} from '../../src/connectors/secret-literal-scan.util';
import { openEnvVarsStrict, sealEnvVars } from '../../src/common/crypto/env-vars-at-rest';

const GUARDED = `('REST','SOAP','GRAPHQL','MCP','ODATA')`;

export interface RepairOptions {
  apply?: boolean;
  connectorId?: string;
  workspaceId?: string;
  /** Fixed for tests; defaults to the current time. */
  backupSuffix?: string;
  out?: (line: string) => void;
}

export interface RepairResult {
  plans: RepairPlan[];
  skipped: Array<{ connectorId: string; reason: string }>;
  backupTable?: string;
}

function redactedPlan(plan: RepairPlan) {
  return {
    connectorId: plan.connectorId,
    workspaceId: plan.workspaceId,
    adapterSlug: plan.adapterSlug,
    connectorFields: Object.keys(plan.connector).filter((k) => k !== 'envVars'),
    newVariables: plan.newVariables,
    moved: plan.moved.map((m) => ({ variable: m.variable, field: m.field, kind: m.kind, pattern: m.pattern })),
    toolsChanged: plan.tools.map((t) => ({ id: t.id, fields: Object.keys(t.changes) })),
    renamedTools: plan.renamedTools,
  };
}

export async function repair(client: Client, opts: RepairOptions = {}): Promise<RepairResult> {
  const out = opts.out ?? console.log;
  const filters: string[] = [`c.type::text IN ${GUARDED}`];
  const params: string[] = [];
  if (opts.connectorId) {
    params.push(opts.connectorId);
    filters.push(`c.id = $${params.length}`);
  }
  if (opts.workspaceId) {
    params.push(opts.workspaceId);
    filters.push(`c.organization_id = $${params.length}`);
  }
  const where = filters.join(' AND ');

  await client.query(opts.apply ? 'BEGIN' : 'BEGIN READ ONLY');
  try {
    const connectors = (
      await client.query(
        `SELECT c.id, c.organization_id, c.name, c.type::text AS type, c.base_url, c.headers, c.config, c.env_vars
           FROM connectors c WHERE ${where} ${opts.apply ? 'FOR UPDATE' : ''}`,
        params,
      )
    ).rows;
    const tools = (
      await client.query(
        `SELECT t.id, t.connector_id, t.name, t.description, t.parameters, t.endpoint_mapping
           FROM mcp_tools t JOIN connectors c ON c.id = t.connector_id WHERE ${where}`,
        params,
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

    const result: RepairResult = { plans: [], skipped: [] };
    for (const c of connectors) {
      // Planned without the variables first: most connectors have nothing to
      // move, and their env_vars are then never decrypted.
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
      const ownTools = toolsByConnector.get(c.id) ?? [];
      if (!planRepair(row, ownTools)) continue;
      const env = openEnvVarsStrict(c.env_vars);
      if (env === null) {
        result.skipped.push({ connectorId: c.id, reason: 'env_vars could not be decrypted (ENCRYPTION_KEY?)' });
        continue;
      }
      const plan = planRepair({ ...row, envVars: env }, ownTools);
      if (plan) result.plans.push(plan);
    }

    for (const plan of result.plans) out(JSON.stringify(redactedPlan(plan)));
    for (const s of result.skipped) out(JSON.stringify({ skipped: s }));

    if (opts.apply && result.plans.length > 0) {
      const suffix = opts.backupSuffix ?? new Date().toISOString().replace(/\D/g, '').slice(0, 14);
      const table = `secret_literal_repair_backup_${suffix}`;
      await client.query(
        `CREATE TABLE ${table} (
           kind text NOT NULL, id text NOT NULL, base_url text, headers jsonb, config jsonb,
           env_vars jsonb, name text, description text, parameters jsonb, endpoint_mapping jsonb,
           backed_up_at timestamptz NOT NULL DEFAULT now())`,
      );
      const connectorIds = result.plans.map((p) => p.connectorId);
      const toolIds = result.plans.flatMap((p) => p.tools.map((t) => t.id));
      await client.query(
        `INSERT INTO ${table} (kind, id, base_url, headers, config, env_vars)
         SELECT 'connector', id, base_url, headers, config, env_vars FROM connectors WHERE id = ANY($1)`,
        [connectorIds],
      );
      if (toolIds.length > 0) {
        await client.query(
          `INSERT INTO ${table} (kind, id, name, description, parameters, endpoint_mapping)
           SELECT 'tool', id, name, description, parameters, endpoint_mapping FROM mcp_tools WHERE id = ANY($1)`,
          [toolIds],
        );
      }

      for (const plan of result.plans) {
        const sets: string[] = [];
        const values: unknown[] = [];
        const set = (column: string, value: unknown, json = false) => {
          values.push(json ? JSON.stringify(value) : value);
          sets.push(`${column} = $${values.length}${json ? '::jsonb' : ''}`);
        };
        if (plan.connector.baseUrl !== undefined) set('base_url', plan.connector.baseUrl);
        if (plan.connector.headers !== undefined) set('headers', plan.connector.headers, true);
        if (plan.connector.config !== undefined) set('config', plan.connector.config, true);
        if (plan.connector.envVars !== undefined) {
          set('env_vars', sealEnvVars(plan.connector.envVars), true);
        }
        if (sets.length > 0) {
          values.push(plan.connectorId);
          await client.query(`UPDATE connectors SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length}`, values);
        }
        for (const tool of plan.tools) {
          const tSets: string[] = [];
          const tValues: unknown[] = [];
          for (const [key, value] of Object.entries(tool.changes)) {
            const column = { name: 'name', description: 'description', parameters: 'parameters', endpointMapping: 'endpoint_mapping' }[key]!;
            const json = key === 'parameters' || key === 'endpointMapping';
            tValues.push(json ? JSON.stringify(value) : value);
            tSets.push(`${column} = $${tValues.length}${json ? '::jsonb' : ''}`);
          }
          tValues.push(tool.id);
          await client.query(`UPDATE mcp_tools SET ${tSets.join(', ')}, updated_at = now() WHERE id = $${tValues.length}`, tValues);
        }
      }
      result.backupTable = table;
    }

    await client.query(opts.apply ? 'COMMIT' : 'ROLLBACK');

    out(
      JSON.stringify({
        summary: {
          mode: opts.apply ? 'APPLIED' : 'DRY RUN (nothing written)',
          connectorsToRepair: result.plans.length,
          workspaces: new Set(result.plans.map((p) => p.workspaceId)).size,
          toolsToChange: result.plans.reduce((n, p) => n + p.tools.length, 0),
          toolsRenamed: result.plans.reduce((n, p) => n + p.renamedTools.length, 0),
          newVariables: result.plans.reduce((n, p) => n + p.newVariables.length, 0),
          skipped: result.skipped.length,
          ...(result.backupTable
            ? { backupTable: result.backupTable, next: 'Restart the backend so the tool registry reloads.' }
            : {}),
        },
      }),
    );
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

if (require.main === module) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  client
    .connect()
    .then(() =>
      repair(client, {
        apply: process.argv.includes('--apply'),
        connectorId: arg('--connector'),
        workspaceId: arg('--workspace'),
      }),
    )
    .then(() => client.end())
    .catch(async (err) => {
      console.error(`repair failed: ${err?.message ?? err}`);
      await client.end().catch(() => undefined);
      process.exit(1);
    });
}
