# Codebound script runner

For setup commands and a complete manual walkthrough, see
[Set up and test Codebound locally](codebound-testing.md).

Codebound saves JavaScript workflows and runs them against authorized connector
tools, returning a compact JSON result. Open **Build → Codebound**, choose an
active MCP server, select the tools a run may call, then click **Run script**.
Give the script a name and description and click **Save script** to reuse it.
The connector must already be assigned to the server and ready to use.

For the setup demo connector, the starter script is:

```javascript
const post = await tools.call('setup_demo_get_post', {});
if (!post || typeof post.id !== 'number' || typeof post.title !== 'string') {
  throw new Error('Expected a post with a numeric id and a title.');
}
return { id: post.id, title: post.title };
```

The editor shows the available tools' descriptions and input/output schemas.
An absent output schema is shown as `null`; check a representative response
and validate the fields your script needs. `tools.call` returns the executor's
filtered, structured JSON response, without MCP text footers. Scripts can use
`input`, the JSON parameters entered beside the code. Await each call before
starting another. Only the final return value is displayed.

## Supported scope

The saved-script list supports **Open**, **New script**, and **Delete** with a
confirmation. Open a script, edit it, and click **Save changes**. Saved records
include the name, description, MCP server, JavaScript, default parameters, and
tool allowlist. They persist in PostgreSQL across page reloads and backend
restarts. The list is paginated and excludes source and parameters until opened.

Running an opened script uses its stored source, server, and allowlist. The
parameters box can override its defaults for one run. If source, server, or
allowlist have unsaved changes, **Run script** tests that draft; **Save changes**
updates the reusable script. Save also persists the parameters as new defaults.
Opening another script or starting a new one prompts before discarding edits.

Edits use a revision counter: an outdated editor receives HTTP 409 instead of
overwriting another user's changes. Running an opened script also checks its
reviewed revision. Reopen it after a conflict to review the current source.
Deleting a script removes access to it; deleting its server also deletes linked
scripts. Runs already in progress use the snapshot loaded when the run began.

An AI client can now write scripts, execute them, save workflows, and reuse
saved IDs through six MCP tools. See [AI-authored scripts through MCP](codebound-mcp.md)
for client setup and examples. Marketplace bundles, separate MCP tool names for
each saved script, and the quotation workflow remain later milestones.

Both Cloud and self-hosted deployments use the same page and authenticated API.
The existing workspace license check still applies. Server assignment, active
connectors, organization membership, and role-based tool access restrict calls
in both modes. Editors and administrators can create, edit, and delete scripts.
Viewers can read and run them within their current tool permissions. A saved
allowlist is a restriction, not a grant: another author's script never expands
the caller's connector access. Both deployments use the same storage and API;
there is no edition-specific behavior.

### Local development database

The `20261017000000_add_codebound_scripts` migration adds `codebound_scripts`
and a composite foreign key that enforces the server's organization. Apply it
to the development database on localhost:5433, from `packages/backend`:

```bash
set -a
. ../../.env
set +a
npx prisma migrate deploy
npx prisma generate
```

For this prototype, eligible tools are REST `GET`, `HEAD`, and `static` tools
whose read-only annotation is true. Other transports and writes are excluded.
The read-only classification depends on the connector's configured HTTP method;
it cannot establish whether an upstream API abuses GET for mutations.

## Execution boundary and limits

Each run creates a fresh QuickJS WebAssembly runtime in a worker. User code runs
only in QuickJS. Node, environment variables, files, direct networking, timers,
and package imports are unavailable. Only serialized JSON crosses the broker.
Credentials remain in the existing connector executor, which retains network
rules, response transforms, secret redaction, and tool invocation auditing.
Script reads bypass the executor's response cache so each read is audited and
cannot consume a shared cache entry from a different caller.

| Budget | Limit |
| --- | --- |
| Worker wall time, including connector waits | 5 seconds |
| QuickJS heap / stack | 64 MiB / 512 KiB |
| Connector calls | 20, sequential |
| Parameters / arguments per call | 64 KiB each |
| Cumulative serialized tool replies | 1 MiB |
| Returned JSON | 32 KiB |
| Script source | 32,768 characters |
| Active runs per backend process | 4 total, 1 per organization |

The host terminates the worker at the deadline and rejects late results.
Existing connector engines do not accept an abort signal: a read already sent
upstream may finish after the script stops. No further reads are dispatched.
The organization's run slot stays occupied until that read finishes. Limits
apply per backend process; this is not a distributed resource quota.

Every started parent run produces a `CODEBOUND_RUN` security event containing
the run ID, caller, server, status, duration, and dispatched call count. Nested
invocations carry `Codebound run <runId>` in their intent field. Parent events
omit source, parameters, results, and raw exceptions. Connector errors shown to
scripts are generic; inspect the normal tool invocation log for details.
Runs of saved scripts also include the script ID and revision in the parent
event. Create, update, and delete produce `CODEBOUND_SCRIPT_CREATED`,
`CODEBOUND_SCRIPT_UPDATED`, and `CODEBOUND_SCRIPT_DELETED` security events,
containing metadata without source or parameters.

## API and verification

Dashboard JWT authentication is required:

- `GET /api/codebound/servers/:serverId/tools`: permitted tool descriptions and schemas.
- `POST /api/codebound/servers/:serverId/run`: `{ code, input, allowedTools }`.
  Returns `{ runId, result, calls, durationMs }` or an HTTP error.
- `GET /api/codebound/scripts?limit=20&offset=0`: `{ items, total }` for this
  workspace; `limit` is capped at 200.
- `POST /api/codebound/scripts`: `{ name, description, mcpServerId, code, input,
  allowedTools }` creates a saved script.
- `GET /api/codebound/scripts/:id`: opens its source and defaults.
- `PUT /api/codebound/scripts/:id`: replaces editable fields using the create
  body plus the reviewed `revision`; returns the incremented revision.
- `DELETE /api/codebound/scripts/:id`: removes it.
- `POST /api/codebound/scripts/:id/run`: `{ input, revision }`; source, server,
  and allowlist overrides are rejected. Returns the usual run result.

The caller's workspace and user identity come from authentication. Script
parameters cannot override them. Every nested call rechecks current permissions
and server assignments, validates arguments with the same schema conversion
used by MCP, then invokes the existing executor pinned to the resolved connector.

Run backend boundary/permission tests from `packages/backend`:

```bash
npm test -- --runInBand codebound
```

After applying the migration, also exercise real persistence, concurrent writes,
tenant denials, the database foreign key, and deletion against local PostgreSQL.
With the local `.env` exported as above, run:

```bash
RUN_CODEBOUND_DB=1 npm test -- --runInBand codebound
```

The database tests create two temporary tenant fixtures and remove them after
the run. They require localhost:5433 and are skipped without the explicit flag.

Run UI tests from `packages/frontend`, with the regular development server
stopped so Playwright can start Next on port 3100:

```bash
npm run test:e2e -- codebound.spec.ts
```

The UI tests mock API responses. Backend tests exercise real QuickJS execution,
including isolation, forbidden host APIs, timeouts, quotas, role/tenant denials,
and recovery. An integration test runs the broker, executor, and REST engine
against a local HTTP fixture, checking response filtering and both audit levels.
They are prototype evidence; they do not certify production isolation or a live
third-party integration.

### Verification on 17 October 2026

| Working directory | Command | Result |
| --- | --- | --- |
| `packages/backend` | `npm test -- --runInBand` | 664 suites / 19,826 tests passed; 1 suite / 1 test failed in unchanged `response-images.util.spec.ts`; 5 suites / 1,454 tests skipped |
| `packages/backend` | `npm test -- --runInBand response-images.util.spec` | All 14 tests passed when run separately |
| `packages/backend` | `npm test -- --runInBand codebound` | 76 tests; PostgreSQL tests are opt-in |
| `packages/backend` | `RUN_CODEBOUND_DB=1 npm test -- --runInBand codebound` | 81 tests passed, including MCP invocation and PostgreSQL persistence/isolation |
| `packages/backend` | `npx prisma validate` / `npx prisma migrate deploy` | Schema valid; new migration applied to local development PostgreSQL |
| `packages/backend` | `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` | No difference detected |
| `packages/backend` | `npm run lint:check` | Passed; 14 existing warnings |
| `packages/backend` | `npx tsc --noEmit -p tsconfig.json` | Passed |
| `packages/backend` | `npm run build` | Passed, including Prisma generation |
| `packages/frontend` | `npm run lint` | Passed; 26 existing warnings |
| `packages/frontend` | `npx tsc --noEmit -p tsconfig.json` | Passed |
| `packages/frontend` | `npx playwright install --with-deps chromium` | Passed |
| `packages/frontend` | `npm run test:e2e -- codebound.spec.ts` | 7 Chromium tests passed, including saved-script CRUD, viewer controls, and pagination recovery |
| Repository root | `node scripts/validate-adapters.mjs` | 490 adapters passed; 1,458 existing non-blocking warnings |
| Repository root | `node scripts/check-runtime-deps.mjs` | Passed |

The full backend run reports a `RangeError: Maximum call stack size exceeded` in
the unchanged image-response test for a 12 MiB aggregate result. That suite passes
when run separately; the full run is not a pass. All 81 focused Codebound tests
pass on the final source, including the five opt-in PostgreSQL tests.

Earlier UI and persistence verification also required access outside the
restricted execution sandbox for localhost listeners and browser installation.
The frontend is unchanged by the MCP integration; its results above are from the
saved-script UI implementation. Regular development servers and Playwright's
server were stopped after verification.
